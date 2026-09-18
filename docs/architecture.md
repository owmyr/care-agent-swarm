# Architecture — Deep Dive

This document provides a comprehensive deep dive into the system architecture, design rationale, operational semantics, and technical tradeoffs of the **Multi-Agent Swarm AI Orchestration Layer**.

---

## 1. LLM Harness

### Why a harness at all

Three reasons, in order of importance:

1. **Operational concerns live in one place.** Retry, backoff, timeout, redaction, schema validation, circuit breaker. If every agent implemented them, we'd have N divergent copies. The harness is the single owner of these policies; every agent goes through it.
2. **The SDK is a thin wrapper around an HTTP call.** It has a `maxRetries` default, a `timeout` default, and typed errors. It does not (in any version we evaluated) combine these into the resilience semantics a production system needs: a circuit breaker, a `Retry-After`-honoring backoff, structured redacted logs, and a graceful-fallback return shape.
3. **Testability.** The harness accepts a `client` parameter. The same code path that calls the real `Anthropic` in production calls `FakeAnthropicClient` in the demo and tests. No module-level mocking.

### Layered retry policy

```
SDK request
  ↑ maxRetries: 0           ← we own retry entirely
  │
Harness.call
  ↓ for attempt in 1..maxAttempts
  ↓   try: client.messages.create(...)
  ↓   catch err: classifyError(err)
  ↓     if retryable and attempt < maxAttempts:
  ↓       waitMs = Retry-After ? parseInt(Retry-After) * 1000 : backoff(attempt)
  ↓       sleep(waitMs); continue
  ↓     else: record error; break
  ↓
  ↓ circuitBreaker.recordSuccess() | recordFailure()  ← only on retryable errors
  ↓
  ↓ validate output against Zod schema (retry once on ValidationError)
  ↓
  ↓ return HarnessResult { status, content, attempts, durationMs, error, requestId, traceId, ... }
```

The SDK's native retries are disabled (`maxRetries: 0`) so the harness is the only thing counting attempts and the only thing talking to the circuit breaker. This makes the reasoning end-to-end coherent.

### Error classification

We classify errors into a small set of `RetryableErrorKind`s and treat them uniformly:

| Class | Retry? | Examples |
|---|---|---|
| `rate_limit` | yes | `RateLimitError` (429) |
| `timeout` | yes | `APIConnectionTimeoutError`, `ECONNRESET`, `ETIMEDOUT` |
| `connection` | yes | `APIConnectionError`, `ENOTFOUND`, `fetch failed` |
| `server` | yes | `InternalServerError` (5xx) |
| `conflict` | yes | `ConflictError` (409) |
| `validation` | **no** | `BadRequestError` (400) — won't fix itself; throw at the call site |
| `auth` | **no** | `AuthenticationError` (401) — bad key; fix config |
| `forbidden` | **no** | `PermissionDeniedError` (403) — won't fix itself |
| `not_found` | **no** | `NotFoundError` (404) — usually a programmer error |
| `output_validation` | no (re-throw path) | Zod output schema mismatch — the harness already retries this once internally |

The reasoning: retrying 400/401/403/404 just wastes tokens and delays the inevitable. They're treated as programmer/config errors, surfaced as `status: 'failed'`, and the caller decides what to do.

### Backoff math

```
waitMs = clamp(
  Retry-After ? parseInt(Retry-After) * 1000 : baseMs * 2^attempt + jitter,
  0,
  maxMs
)
```

`Retry-After` is a string that can be either a delta-seconds (e.g., `"7"`) or an HTTP-date. The harness handles both. The fallback is exponential with jitter: `baseMs * 2^attempt + random(0..jitterMs)`. Default `baseMs=500`, `jitterMs=1000`, `maxMs=30_000`.

The jitter is the anti-thundering-herd knob. Without it, every client backing off on a 429 will retry at the same instant, and the next attempt will 429 again.

### Circuit breaker

```
       success                          probe success
CLOSED ─────────► CLOSED  (normal)
   │ failure
   │ N consecutive failures
   ▼
OPEN ────────────────► HALF_OPEN  (after cooldownMs)
   │ probe failure                  ▲
   └──────────► OPEN ◄──────────────┘
```

When the breaker is `OPEN`, the harness short-circuits without calling the API. The result is `HarnessResult { status: 'failed', error: { kind: 'circuit_open' } }`. The caller (e.g., the orchestrator) decides whether to use a cached/fallback content or escalate.

Transitions:
- `recordSuccess()` → `closed`
- `recordFailure()` (when closed, and consecutive >= threshold) → `open`
- `recordFailure()` (when half-open) → `open`
- `getState()` (when open and elapsed >= cooldownMs) → `half_open`

Default `failureThreshold=5`, `cooldownMs=30_000`. Tunable per deployment.

### Schema validation

Zod is the single source of truth. The harness's call signature:

```ts
async call<T>(options: HarnessCallOptions, outputSchema?: ZodSchema<T>): Promise<HarnessResult<T>>
```

Two validations:
- **Input**: `HarnessCallOptionsSchema` is enforced at the call site (TypeScript types). If the input is structurally invalid at runtime, the harness returns `status: 'failed'`.
- **Output**: if `outputSchema` is provided, the harness parses the LLM's text response through it. The harness uses a tolerant JSON extractor (handles fenced ```json blocks, bare JSON, or text with embedded JSON). On `ZodError`, the harness retries the call once, then returns `status: 'degraded'` (or `failed` if the retry also fails).

This is "graceful fallback" applied to validation: a malformed LLM response is degraded, not a hard failure that crashes the agent.

### Redaction

Four layers (defense in depth, applied to the `sensitive: {prompt, output}` payload only when content logging is opted in — see *Observability* below for the default metadata-only logging):

1. **JSON `"field": "value"` patterns** + JSON tree-walk for structured outputs. For outputs that parse as JSON, the harness parses → walks the object tree with the call's `sensitiveFields` → re-stringifies. This handles nested arrays and objects correctly (e.g., `medications: ["Lisinopril 10mg"]` in the medical-history output).
2. **Fenced-block** redaction for `"""..."""` and ` ```...``` ` blocks. Catches multi-line free-text payloads like the `Raw clinical notes` narrative where the value spans many lines and a colon regex would only catch the label line.
3. **Colon-separated `Field: value`** patterns with case-insensitive, separator-flexible field matching (catches free-text prompts like `Resident: Margaret Thompson`).
4. **Format-only** patterns (SSN/phone/email/date) — always redact regardless of field name, so a developer who forgets to declare `sensitiveFields` still gets protection.

The default PHI allowlist: `ssn, socialSecurityNumber, dob, dateOfBirth, diagnosis, diagnoses, medications, medication, mrn, medicalRecordNumber, apiKey, api_key, token, password, creditCard, phoneNumber, email, address`.

The redaction is defense-in-depth: even if a developer forgets to declare a `sensitiveFields`, the pino `redact` catches the standard PHI fields, and the format-only layer (4) catches SSN/phone/email/date regardless.

### Observability

**Default logging is metadata-only.** The harness never logs the full prompt or output unless the caller explicitly opts in via `logContent: true` on `HarnessCallOptions` or the `HARNESS_LOG_CONTENT=true` env var. This is the production-safe default: a log-line leak exposes metadata (token counts, duration, status, schema name, prompt hash for dedup) but never PHI.

Every call produces structured JSON logs in metadata-only mode:

```json
{
  "level": 30,
  "time": 1782364174277,
  "name": "care-agent-swarm",
  "traceId": "991886fb-...",
  "model": "claude-sonnet-4-5",
  "attempt": 0,
  "requestId": "req_018EeWyXxfu5pfWkrYcMdjWG",
  "durationMs": 1018,
  "inputTokens": 50,
  "outputTokens": 100,
  "hasOutputSchema": true,
  "promptHash": "7a3c8e9f4b2d",
  "msg": "llm_call_success"
}
```

When `logContent: true` is set, a `sensitive: { prompt, output }` field is added with the four-layer redaction applied.

- `traceId`: per-call UUID. Propagated to sub-agents and the audit trail so a full request is reconstructable.
- `requestId`: `_request_id` from the Anthropic API. This is the ID Anthropic uses for support tickets — log it on every call so any user-reported issue can be traced.
- `attempt`, `durationMs`, `inputTokens`, `outputTokens`: standard.
- `hasOutputSchema`: boolean indicating whether an output schema was provided.
- `promptHash`: SHA-256 prefix of the prompt, for deduplication and "have I seen this prompt before" debugging without exposing content.
- `sensitive` (opt-in only): the (redacted) input prompt and output text, for debugging without leaking PHI.
- The `traceId` is also bound to the agent's child logger so all logs in a single request share it.

### Graceful fallback

Operational failures return a typed result, never throw. The caller branches on `result.status`:

```ts
switch (result.status) {
  case 'ok':       // success
  case 'degraded': // partial / fallback content; caller decides if usable
  case 'failed':   // unrecoverable; caller escalates or fails soft
}
```

`degraded` is used when the harness returned a usable but compromised result (e.g., timeout, output validation failed twice, connection issue with a cached fallback). The caller can choose to use the content with reduced confidence or fail.

Programmer errors (malformed schema config, wrong arg types) **do** throw — they are bugs, not expected runtime conditions. The distinction is important: conflating "the API is flaky" with "I configured the harness wrong" hides bugs and corrupts audit trails.

---

## 2. Agent Swarm

### Ownership boundaries

| Agent | Owns | Reads | Writes |
|---|---|---|---|
| **Orchestrator** | fan-out, fault tolerance, final synthesis (LLM), status enum | Intake form | `IntakeOrchestrationResult` |
| **Medical History** | parse + summarize clinical notes | clinical notes | structured `MedicalSummary` |
| **Regulatory Compliance** | validate care plan vs state regs | care plan + state | compliance report |
| **Family Communication** | draft plain-language welcome | resident + family + facility | letter |

The orchestrator does **not** re-validate medical, compliance, or family-domain logic. Each sub-agent owns its domain end-to-end.

### Typed message contract

All inter-agent messages are Zod schemas. The orchestrator and sub-agents exchange typed `HarnessResult<SubAgentOutput>` envelopes — never raw strings, never `any`. TypeScript types are derived from the Zod schemas via `z.infer<typeof X>`, so there's a single source of truth.

### Promise.allSettled (not Promise.all)

`Promise.all` would cancel the whole intake on a single sub-agent rejection. `Promise.allSettled` always resolves with per-promise `{status, value | reason}`. The orchestrator iterates the results, marks each as success/failure, and computes a status enum:

- `complete` — all 3 sub-agents returned `status: 'ok'`
- `partial` — at least 1 success, at least 1 failure
- `failed` — all 3 failed

### Orchestrator as LLM agent

The orchestrator uses the harness to synthesize a 2-3 sentence executive `summary` from the sub-agent results. If that call fails, fall back to a generic template. This makes the orchestrator a real LLM agent (faithful to "Orchestrator *agent*") and demonstrates harness reuse at the top of the stack.

### Anti-loop guards

- **No retry loops in the orchestrator.** Sub-agents get one harness call each (with the harness's own internal retry for transient errors). Don't add another retry layer on top.
- **Trace IDs everywhere.** Every log line, every result, every audit record carries the same `traceId` for the request.

---

## 3. Incident Reporting Workflow

### Hybrid classify / deterministic validate

The validation step is deterministic; the LLM only classifies and infers.

```
Free-text incident report
  │
  ▼
LLM.classify(report) → { type, severity, regulatoryPath, requiredNotifications }
  │
  ▼
requiredFields = REQUIRED_FIELDS_BY_TYPE[type]   ← deterministic, table-driven
  │
  ▼
loop (iter < maxIterations):
  missing = requiredFields.filter(f => isEmpty(report[f]))
  if missing.length === 0: break (success)
  if iter === maxIterations - 1: loopGuardTriggered = true, escalate
  fieldsAdded = await LLM.infer(report, missing)  ← harness call
  report = { ...report, ...fieldsAdded }
  iter++
  │
  ▼
Audit trail: { iterations, validationHistory, finalReport, notificationsSent, errors, ... }
```

This separation makes the audit trail trustworthy: the validation step is reproducible (deterministic check on the required-fields table), the LLM's only jobs are classification (subjective) and field inference (generative from prose).

### REQUIRED_FIELDS_BY_TYPE (per CMS-style regulation)

```ts
const REQUIRED_FIELDS_BY_TYPE: Record<IncidentType, string[]> = {
  fall: ['bodyPartAffected', 'fallLocation', 'supervisingNurse', 'physicianNotified', 'injuryLevel'],
  medication_error: ['medicationName', 'dosageGiven', 'dosagePrescribed', 'pharmacistNotified', 'residentCondition'],
  elopement: ['durationMissing', 'foundLocation', 'policeNotified', 'familyNotified', 'preventionMeasures'],
  abuse_allegation: ['allegationType', 'accusedParty', 'witnessStatements', 'administrationNotified', 'ombudsmanNotified'],
  medical_emergency: ['vitalSigns', 'emergencyServicesContacted', 'hospitalTransfer', 'physicianNotified', 'familyNotified'],
  property_damage: ['damageExtent', 'estimatedCost', 'responsibleParty', 'insuranceNotified'],
  physical_altercation: ['partiesInvolved', 'injuriesSustained', 'witnessStatements', 'policeNotified', 'counselingArranged'],
  other: ['description', 'supervisorNotified', 'resolutionPlan'],
};
```

`REGULATORY_PATH_BY_TYPE` is the parallel table for which agency to notify.

### Validation history (per-iteration audit)

Each iteration pushes an entry to `validationHistory`:

```ts
{
  iteration: number;
  missingFields: string[];     // before this iteration's check
  fieldsAdded: string[];       // what the LLM inferred and we accepted
  validationPassed: boolean;   // after this iteration's check
  durationMs: number;          // for cost analysis
  inferError?: string;         // if the LLM call itself failed
}
```

This is the per-execution compliance audit trail. The final audit also includes `notificationsSent` (who was notified, with escalation flag) and `errors[]` (any operational failures during the run, so a clinical reviewer can reconstruct exactly what happened).

### Max-iteration guard

Default `maxIterations = 3` (configurable). When the guard fires:

- `loopGuardTriggered: true`
- `humanEscalationRequired: true`
- `escalationReason: "Max iterations (N) reached with M fields still missing: ..."`
- `notificationsSent` is prefixed with `"Human Reviewer — ..."`

The guard fires the moment the cap is hit; we do not try "one more iteration." This is a hard guarantee, not a heuristic.

### Workflow never throws

Every operational failure is recorded in `errors[]` and `humanEscalationRequired: true` is set. The workflow always returns an audit trail. This is the contract.

---

## 4. Tradeoffs and signals-to-switch

### When this is the right shape
- **Custom validation logic** tied to regulation (the per-type required-fields table is the example)
- **Structured audit trail required** (compliance reviews, CMS audits)
- **Multi-agent coordination** that has to be resilient to partial failure
- **Need to embed the workflow in a product** with strong typing end-to-end
- **Evolving requirements** — adding a new incident type = one new entry in `REQUIRED_FIELDS_BY_TYPE` + one new sub-agent

### Signals to switch to a managed tool (n8n, Make)
- Non-engineers own the workflow
- < 10 workflows/month
- No SLA on the orchestration layer
- No complex validation logic (just routing)
- No need for an audit trail

### Signals to keep it custom
- Audit trail is a compliance requirement (this is a strong one)
- The workflow embeds in a product (not a stand-alone internal tool)
- The validation logic is complex and evolves with regulation
- You need fine-grained control over retry/timeout/redaction
- You need trace IDs and per-iteration observability

The requirement for a structured, tamper-evident JSON audit trail for every execution is a strong architectural signal toward custom orchestration code — a managed workflow tool would have to be wrapped to produce that anyway, and the wrapper ends up being most of the value.

---

## 5. Observability surface

- Every harness call → one log line with `traceId`, `requestId`, `model`, `attempt`, `durationMs`, `tokens`, redacted `sensitive` payload, `msg`.
- Every orchestrator run → bound to a `traceId`, logs at intake start + completion with `status` and `successCount`.
- Every incident workflow run → bound to a `traceId`, `IncidentAuditTrail` returned with `validationHistory` (one entry per iteration) and `errors[]`.
- Every circuit-breaker transition → `circuit_breaker_state_change` log line with `from`/`to`.

A full request is reconstructable from logs by grep on `traceId`. The Anthropic `request_id` lets you cross-reference to Anthropic's side if a user reports an issue.
