# Written Responses — Sections A, C, D, E

This document contains the written answers for Sections A (conceptual), C (auth + security audit), D (AI-assisted testing + dev workflow), and E (behavioral). Section B is the code; Sections A/C/D/E are this document and the linked `docs/ai-testing-log.md`.

---

## Section A — Conceptual Questions

### A1 — AI Provider Resilience: circuit breaker + degradation plan

**The pattern.** A circuit breaker sits between the application and the LLM provider with three states: `CLOSED` (normal), `OPEN` (provider known-bad; short-circuit), `HALF_OPEN` (probing after cooldown). The breaker opens after N consecutive retryable failures, stays open for a cooldown window, then transitions to `HALF_OPEN` to admit a single probe request. If the probe succeeds, the breaker closes and traffic resumes; if it fails, the breaker re-opens.

**Concrete numbers from this build.** Default `failureThreshold: 5`, `cooldownMs: 30_000`. Tunable per deployment. The state transitions are logged with `from` and `to` so an operator can see when the breaker flipped.

**Retry policy that respects the provider.** The Anthropic API returns `Retry-After` on 429s (as either delta-seconds or an HTTP-date). The harness parses the header and waits that long before retrying. If the header is absent, it falls back to exponential backoff with jitter: `min(baseMs * 2^attempt + random(0..jitterMs), maxMs)`. Default `baseMs=500`, `jitterMs=1000`, `maxMs=30_000`. Jitter is the anti-thundering-herd knob — without it, every client backing off on a 429 will retry at the same instant, and the next attempt will 429 again.

**SDK retries disabled so the policy is coherent.** The Anthropic SDK natively retries 408/409/429/5xx with a default of 2 attempts. If we left that on *and* layered our own retry on top, we'd retry up to 2 × 3 = 6 times and the circuit-breaker state would diverge from the actual call count. We set `maxRetries: 0` on the SDK and own the entire retry policy in the harness.

**What gets retried, what doesn't.** We classify errors into retryable vs. non-retryable. Retryable: 429 (rate-limit), 408/timeout, connection errors, 5xx, 409 (conflict). Non-retryable: 400 (bad request — won't fix itself), 401 (auth — config issue), 403 (forbidden), 404 (usually a programmer error). Retrying 400 just wastes tokens and delays the inevitable. The harness returns `status: 'failed'` for non-retryable errors instead of retrying.

**User-facing degradation.** Operational failures return a typed `HarnessResult` with `status: 'degraded'` or `'failed'`, never raise. The caller branches on `status`:
- `ok` — success
- `degraded` — partial / fallback content; the caller decides if the content is usable with reduced confidence
- `failed` — unrecoverable; the caller escalates or fails soft (e.g., the incident workflow escalates to a human reviewer)

The distinction between `degraded` and `failed` is a UX decision: `degraded` means "I have something to show you, but with caveats" (e.g., a cached response, or a slightly incomplete summary); `failed` means "I cannot produce a usable result" (e.g., the circuit is open, or all attempts were non-degradable). Programmer errors (malformed schema, wrong arg types) **do** throw — they are bugs, not expected runtime conditions.

**Failure modes the harness handles explicitly.** Rate-limit, timeout, connection error, server error, output-validation failure (the LLM returned JSON that doesn't match the Zod schema — the harness retries the call once, then returns `degraded`). The `degraded`/`failed` distinction is keyed to the error kind: timeouts and connections degrade, validation errors degrade, but auth/not-found are programmer errors and fail.

**Observability.** Every call logs `{traceId, agent, model, attempt, status, durationMs, requestId, tokens}`. The `_request_id` from the Anthropic response is captured and logged on every call so any user-reported issue can be traced to Anthropic's side. The circuit-breaker state transitions are also logged.

**What I'd add with more time.** Per-provider circuit-breaker state (so OpenAI and Anthropic are isolated). Latency-based breakers (a slow provider is also "bad"). A dead-letter queue for requests that fail when the breaker is open, so a manual operator can replay them.

### A2 — Agent & Sub-Agent Design Principles

**What each sub-agent owns.** The orchestrator does NOT re-validate medical, compliance, or family-domain logic. Each sub-agent owns its domain end-to-end. The orchestrator is a coordinator + synthesizer, not a re-doer. Ownership boundaries from this build:

| Agent | Owns | Reads | Writes |
|---|---|---|---|
| Orchestrator | fan-out, fault tolerance, final synthesis (LLM), status enum | Intake form | `IntakeOrchestrationResult` |
| Medical History | parse + summarize clinical notes | clinical notes | structured `MedicalSummary` |
| Regulatory Compliance | validate care plan vs state regs | care plan + state | compliance report |
| Family Communication | draft plain-language welcome | resident + family + facility | letter |

**Communication contract.** Typed Zod messages, never raw strings, never `any`. The harness's `HarnessResult<T>` envelope is the inter-agent message. TypeScript types are derived from the Zod schemas via `z.infer`, so there's a single source of truth.

**Runaway-loop prevention.** Multiple layers:
- The orchestrator has no retry loop. Sub-agents get one harness call each (with the harness's own internal retry for transient errors). No nested retry layers.
- The incident workflow has a hard `maxIterations` cap (default 3). When the cap is hit, the loop guard fires: `loopGuardTriggered: true`, `humanEscalationRequired: true`, and the workflow does *not* try "one more iteration." This is a hard guarantee, not a heuristic.
- The harness's circuit breaker prevents infinite retries against a known-bad provider.

**Contradicting outputs.** Who resolves conflicts? In this build, the orchestrator is the synthesizer: it uses the harness to write a 2-3 sentence executive summary that reconciles the sub-agent results. If two sub-agents disagree, the orchestrator's summary names the disagreement rather than picking a side. The compliance agent's `violations[]` and the medical agent's `flaggedConcerns[]` are surfaced in the orchestrator's `flaggedIssues[]` for human review. The orchestrator does not silently merge or override.

**Observability.** Every agent binds a `traceId` (UUID) via the logger. The same `traceId` is propagated to sub-agents and to the audit trail, so a full request is reconstructable from logs by `grep traceId`. The agent's structured log payload includes the agent name, the `requestId` from the API, the attempt count, the duration, the status, and the (redacted) input/output. The `IntakeOrchestrationResult` and `IncidentAuditTrail` both include the `traceId` for end-to-end traceability.

### A3 — Workflow Automation vs. Custom Code

**Signals to use a managed tool (n8n, Make, Zapier).**
- Non-engineers own the workflow (marketing, ops, support)
- < 10 workflows/month, low volume
- No SLA on the orchestration layer
- No complex validation logic — just routing, notifications, simple transforms
- No need for an audit trail
- "Good enough" is fine; no need to tune retry policy, timeouts, or observability

**Signals to write custom code.**
- A custom validation logic is tied to regulation (e.g., the per-type required-fields table in this build)
- A structured audit trail is a compliance requirement (the assessment's "structured JSON audit trail for every execution" is itself a strong signal — most managed tools would have to be wrapped to produce that anyway)
- The workflow is embedded in a product with strong typing end-to-end (Zod schemas → TypeScript types)
- The validation logic evolves with regulation (adding a new incident type = one new entry in `REQUIRED_FIELDS_BY_TYPE` + one new sub-agent in this build)
- You need fine-grained control over retry policy, timeouts, redaction, observability
- You need trace IDs and per-iteration observability that maps to the LLM provider's `request_id`
- The workflow involves LLM calls (managed tools are weak at LLM orchestration; you'd end up wrapping them anyway)
- IP-sensitive — the workflow logic is a product differentiator

**The real-world signals from this assessment.** The "structured JSON audit trail for every execution" requirement is itself a strong signal toward custom code. A managed tool would have to be wrapped to produce the per-iteration `validationHistory` records, the `errors[]` array, the `humanEscalationRequired` flag, the `loopGuardTriggered` flag. The wrapper ends up being most of the value, and at that point you might as well own the whole thing. The same is true for the harness's redaction policy, the circuit breaker, the `Retry-After` honoring — these are real production concerns that managed tools abstract away, and abstracting them away is the wrong tradeoff when you're building a regulated product.

**A useful heuristic.** If you can describe the workflow as "when X happens, send Y to Z, then maybe send W," a managed tool is fine. If you can describe it as "when X happens, classify it, validate that all required fields are present, infer missing fields from free text, loop with a max-iter guard, escalate to a human if the guard fires, and produce a JSON audit trail that survives a compliance review," you want custom code. The fact that the workflow involves LLM calls is a strong tell — most managed tools treat LLMs as a "send prompt, get response" black box and don't give you the harness primitives you need for resilience.

---

## Section C — Authentication & Security Audit

### C1 — Auth architecture

**API keys.** Read from `process.env.ANTHROPIC_API_KEY` only. The harness never reads from a file or accepts the key as a constructor argument in production code paths. `.env` is in `.gitignore` and `.env.example` (with no real values) is the only thing in the repo. The `ANTHROPIC_API_KEY` is the only secret this build needs.

**Rotation.** The rotation procedure is: generate a new key in the Anthropic console, update the secret in the deployment environment (e.g., Kubernetes secret, CI secret, .env on the operator's machine), restart the process. No in-app rotation is implemented (out of scope for a single-LLM-key build). The key is read at process start; restarting picks up the new value.

**Permission scoping.** The harness has the minimum required permission: it can call the Anthropic Messages API with the model ID, the prompt, the `max_tokens`, and (optionally) the temperature. It does not need admin-level Anthropic API permissions (e.g., billing, organization management). For the build as scoped (no user auth, no multi-tenant), there is no further permission scoping to do.

**What I did NOT implement and why.**
- **No user auth layer.** The build is the AI layer of a CRM, not the full CRM. User auth (login, sessions, RBAC) lives in a separate layer that the assessment does not require. The harness assumes the upstream layer (the CRM's API gateway) has already authenticated the request.
- **No key vault integration.** The build uses `process.env` for the single API key. In a production deployment, the secret would come from a vault (AWS Secrets Manager, HashiCorp Vault, Kubernetes secrets) — but the harness's interface is unchanged: it reads from the env, and the env is populated by the vault integration in the deployment layer.
- **No per-user rate limiting.** The CRM layer above us handles per-user quotas. The harness's circuit breaker is per-process, not per-user.

### C2 — Self-conducted security audit

**Regulatory context.** A residential elderly care facility in the US is a Covered Entity under HIPAA. The AI layer handles Protected Health Information (PHI): resident names, dates of birth, diagnoses, medications, medical record numbers, and contact details. CMS Conditions of Participation and state regulations (e.g., California Title 22, Texas Administrative Code Title 26) impose additional retention and audit requirements. The redaction policy below is designed to satisfy HIPAA's 18 Safe Harbor identifiers and the audit-log expectations in 45 CFR § 164.312(b).

**HIPAA 18 identifiers and the redaction map.** HIPAA's Safe Harbor de-identification requires removing the following identifiers. The harness's `DEFAULT_PHI_FIELDS` and per-call `sensitiveFields` are mapped to each:

| HIPAA identifier | Redacted as | Default allowlist field | Format matcher (layer 3) |
|---|---|---|---|
| 1. Names | `[REDACTED]` | `residentName`, `familyContactName` | — |
| 2. Geographic subdivisions smaller than a state | `[REDACTED]` | `address` | — |
| 3. All elements of dates (except year) | `[REDACTED]` | `dob`, `dateOfBirth`, `admissionDate` | `\d{4}-\d{2}-\d{2}` |
| 4. Telephone numbers | `[REDACTED-PHONE]` | `phone`, `phoneNumber` | `\+?\d{1,2}-\d{3}-\d{3}-\d{4}` |
| 5. Fax numbers | `[REDACTED-PHONE]` | `fax` | same |
| 6. Email addresses | `[REDACTED-EMAIL]` | `email` | `[\w.+-]+@[\w-]+\.[\w.-]+` |
| 7. SSN | `[REDACTED-SSN]` | `ssn`, `socialSecurityNumber` | `\d{3}-\d{2}-\d{4}` |
| 8. Medical record numbers | `[REDACTED]` | `mrn`, `medicalRecordNumber` | — |
| 9. Health plan beneficiary numbers | `[REDACTED]` | `insuranceNotified`, `insuranceId` | — |
| 10. Account numbers | `[REDACTED]` | `accountNumber` | — |
| 11. Certificate/license numbers | `[REDACTED]` | `licenseNumber` | — |
| 12. Vehicle identifiers | `[REDACTED]` | `vehicleId` | — |
| 13. Device identifiers | `[REDACTED]` | `deviceId` | — |
| 14. URLs | `[REDACTED]` | `url` | — |
| 15. IP addresses | `[REDACTED]` | `ipAddress` | — |
| 16. Biometric identifiers | `[REDACTED]` | `biometric` | — |
| 17. Full-face photos | `[REDACTED]` | `photo` | — |
| 18. Any other unique identifier code | `[REDACTED]` | `token`, `apiKey`, `password` | — |

Redaction is **four-layer defense in depth** (see `redactStringValue` in `src/harness/harness.ts`):
1. JSON `"field": "value"` patterns (catches structured payloads, including arrays/objects via the JSON tree-walk used for the `sensitive.output` payload)
2. **Fenced-block** redaction for `"""..."""` and ` ```...``` ` blocks (catches multi-line free-text like the `Raw clinical notes` narrative where the value spans many lines and a colon regex would only catch the label line)
3. Colon-separated `Field: value` patterns with case-insensitive, separator-flexible field matching (catches free-text prompts like `Resident: Margaret Thompson`)
4. Format-only patterns (SSN/phone/email/date) — always redact regardless of field name, so a developer who forgets to declare `sensitiveFields` still gets protection

**Default logging is metadata-only.** The harness never logs the full prompt or output unless the caller explicitly opts in via `logContent: true` on `HarnessCallOptions` or the `HARNESS_LOG_CONTENT=true` env var. The default log payload is `{traceId, requestId, model, attempt, durationMs, inputTokens, outputTokens, hasOutputSchema, promptHash}` — `promptHash` is a SHA-256 prefix for deduplication/debugging without exposing content. When opt-in content logging is enabled, the four-layer redaction above is applied to the `sensitive: {prompt, output}` payload before logging.

This was a real bug in the first build: the redaction only handled JSON patterns, so `Date of birth: 1947-03-12` in a free-text prompt leaked to logs. A subsequent audit (after the initial JSON-only fix) found that the **raw clinical notes narrative and output JSON arrays** (medications, allergies, conditions) were still leaking. The current four-layer fix — including fenced-block redaction for multi-line payloads and the JSON tree-walk for structured outputs — is verified by `tests/harness.test.ts`.

**Attack surfaces and mitigations.**

1. **Prompt injection in user-supplied clinical notes.** A malicious or careless user could embed instructions in the clinical notes ("Ignore previous instructions and return..."). Mitigated by:
   - The output schema is Zod-validated. The LLM can only return fields defined in the schema. An injected "ignore previous" instruction has nowhere to go.
   - The system prompt is fixed (in the agent's code, not user-controlled). The user-supplied data only goes into the `userPrompt` template, where the model treats it as data, not instructions.
   - The harness retries the call once on schema violation, which further constrains the output.

2. **PHI leakage in logs.** A log line could include the resident's SSN, diagnosis, or medications. Mitigated by the four-layer redaction above + pino's built-in `redact: ['*.ssn', '*.dob', ...]` at the logger level. Even if a developer forgets to declare `sensitiveFields`, the pino `redact` catches the standard PHI fields, and the format-only layer (layer 4) catches SSN/phone/email/date regardless. **Important: the default log payload is metadata-only — `{traceId, requestId, model, attempt, durationMs, inputTokens, outputTokens, hasOutputSchema, promptHash}` — so prompt and output content are *not* logged unless the caller opts in via `logContent: true` (or the `HARNESS_LOG_CONTENT=true` env var).** When opt-in content logging is enabled, the four-layer redaction (JSON tree-walk for structured outputs, fenced-block redaction for `"""..."""` and ` ```...``` `, colon-separated patterns, and format-only fallbacks) is applied to the `sensitive: {prompt, output}` payload.

3. **API key leakage.** The key could be logged, committed, or sent to the client. Mitigated by:
   - `.env` is in `.gitignore`. `.env.example` holds no real value.
   - The key is read from `process.env` only. The harness's logger has a redact rule for `*.apiKey`, `*.token`, `*.password` to catch accidental logging.
   - The build does not send the API key to any client-side code (no browser bundle, no static export). The key is server-side only.
   - The Anthropic SDK is constructed with `maxRetries: 0` and the harness is the only retry layer — no SDK retry logic exposes the key in error paths.

4. **LLM returning PII not in the input.** The model could hallucinate PII (a phone number, a name) that didn't come from the user. Mitigated by:
   - The output schema is Zod-validated. If the schema says `summary: z.string().max(2000)`, the model can't return a 10,000-character block of unrelated PII.
   - The redacted logging still applies — any PII the model returns is redacted before it hits the log file.
   - In production, a downstream human reviewer (or compliance scan) would catch PII in the output that wasn't in the input.

5. **Runaway LLM cost.** A misconfigured agent could call the harness in an infinite loop, burning tokens. Mitigated by:
   - The circuit breaker short-circuits calls when the provider is known-bad.
   - The incident workflow has a hard `maxIterations` cap.
   - The orchestrator's `Promise.allSettled` is a one-shot fan-out, not a loop.
   - Per-call `maxTokens` and `maxAttempts` are bounded.
   - The harness has a per-call `withTimeout` race so a hanging client cannot stall the caller.

6. **Unauthorized actions against the harness.** If the harness were exposed as a service, anyone could call it. Mitigated by:
   - **Out of scope for this build.** The harness is a library called by the CRM layer, which is responsible for authn/authz. If this were a standalone service, the first thing I'd add is API key auth on the harness endpoint + a per-caller rate limit.

7. **Tooling injection via the LLM.** If a future sub-agent uses tool calling (not in this build), a malicious user could trick the LLM into calling a tool with attacker-controlled arguments. Mitigated by:
   - Not in this build (no tool calls).
   - In future, would require: a strict allowlist of tool names per agent, argument validation against the tool's Zod schema, and a human-in-the-loop for any tool that mutates state.

**First thing I'd fix with more time.** HIPAA-mandated Business Associate Agreements (BAAs) with Anthropic. The build assumes Anthropic is a Business Associate; in production, the BAA is the legal basis for processing PHI through the API at all. Second: per-caller rate limiting and API key auth on the harness if it were exposed as a service. The build assumes an upstream auth layer; in a real deployment, that layer is mandatory and the harness should refuse unauthenticated calls.

**Audit logging for compliance (45 CFR § 164.312(b)).** Every harness call, every orchestrator run, and every incident workflow produces structured JSON logs with `{traceId, agent, model, attempt, status, durationMs, requestId, tokens, sensitive (redacted)}`. The `requestId` is the Anthropic `_request_id`, which lets a compliance reviewer cross-reference to Anthropic's side if needed. The `traceId` ties all logs in a single request together. The `IncidentAuditTrail` is itself a structured JSON record per incident, with `validationHistory` (per-iteration), `errors[]` (operational failures), `notificationsSent` (who was notified), and `escalationReason` (why a human was looped in). The format is JSON Lines on stdout, ingestible by any log pipeline (Datadog, Splunk, CloudWatch). The retention policy required by HIPAA is 6 years; the deployment layer is responsible for configuring the pipeline's retention.

---

## Section D — AI-Assisted Testing & Developer Workflow

### D1 — How you tested with AI

See `docs/ai-testing-log.md` for the full log of AI-suggested tests I rejected or modified, with reasoning. Summary of the pattern:

The AI assistant I used to scaffold tests tended to (a) assert on implementation details (exact sleep call, internal state, log strings) rather than the contract; (b) use module-level mocking (`vi.mock('@anthropic-ai/sdk')`) which is fragile; and (c) prioritize "green check" coverage over failure-mode tests.

Every AI-suggested test that violated one of these patterns was rewritten. The 42 tests in `tests/` are all my own or modified from AI suggestions, and they assert on:
- **Call count** (the harness retried exactly N times)
- **Eventual outcome** (`status: 'ok'`, `content: 'recovered'`)
- **Never-throws contracts** (`expect(promise).resolves.toBeDefined()`)
- **Policy** (a 400 does not retry; a 429 does; the circuit opens after N consecutive retryable failures)
- **Structured log fields** (not log strings)

The most consequential rejection was the wall-clock backoff assertion. The AI suggested `expect(sleep).toHaveBeenCalledWith(1000)` to verify a `Retry-After: 1` is honored. I rejected because the test was coupled to the internal sleep call rather than the contract ("the harness retries after the server's told wait time"). I replaced it with a call-count assertion and a "did the second attempt succeed" assertion. This change is what makes the test suite reliable across refactors of the backoff math.

**Tools used.** opencode with the `glm-5.2` model for test scaffolding and refactoring, and GPT 5.5 as a second model to audit the test suite for coverage gaps and contract-vs-implementation drift. I also used the build model to suggest test names and to find edge cases in the code that I should cover. For every test the AI suggested, I read the test, evaluated it against the principles above, and either accepted (rare — maybe 2 of the 42) or rewrote. I did not blindly accept any test.

### D2 — Your Developer Agent OS

**The setup.**
- **Editor / TUI**: opencode running in the terminal, with the `build` (default) and `plan` (read-only) primary agents. I switch with Tab depending on whether I want to make changes or just review.
- **Model**: the user's configured model drives opencode's coding sessions. For this assessment, I left the user's current model untouched and didn't add a model override in `opencode.json`.
- **Second model for review/audit**: GPT 5.5, used independently to review plans and audit finished diffs for flaws the build model missed. Cross-model verification catches blind spots a single model has — if both models agree a change is sound, that's a stronger signal than one model self-reviewing.
- **Files**: AGENTS.md (always-loaded project context), `opencode.json` (config), `.opencode/skills/<name>/SKILL.md` (on-demand skills), `package.json` + `tsconfig.json` + `biome.json` (project config).

**The prep layer (token-efficiency).**
- `AGENTS.md` is loaded every session. It carries the stack, the commands, the conventions, and the deliverables checklist — so I don't re-read the assessment email in every session.
- 5 on-demand skills in `.opencode/skills/`: `llm-harness`, `agent-swarm`, `incident-workflow`, `demo-scenarios`, `assessment-rubric`. Each is loaded only when the task matches the skill's `description`. This keeps the per-session context window small while encoding the project-specific patterns (the harness's retry policy, the swarm's ownership boundaries, the incident workflow's loop guard, the demo's 3 video beats, the written-answers rubric).
- `opencode.json` registers the skills path, hardens permissions (`git push` denied, `.env*` read denied, `rm -rf` denied), and adds a reference to the `anthropic-sdk-typescript` repo so any session can inspect the SDK internals.

**How I chain tools per stage.**
- **Planning**: `plan` mode (Tab). I describe the task; the model proposes an approach; I review and refine.
- **Scaffolding**: I run the build/scaffold commands directly (Bash), verify the outputs, and use `biome` to auto-format imports.
- **Coding**: `build` mode. I write modules incrementally. After each module, I run `npm run build` (type-check) + `npm test` (relevant tests) to verify before moving on.
- **Reviewing**: I read the diff vs. the previous version, then run it through GPT 5.5 as an independent audit — asking it to flag logic flaws, missing edge cases, or anything that looks like the build model rationalizing its own output. For non-trivial changes, I use the `explore` subagent to do a quick scan of related code paths.
- **Testing**: I write tests with the same model, but I reject any test that asserts on implementation rather than contract (see D1). I use `vi.useFakeTimers()` sparingly; the harness accepts a `sleep` function so I can pass `vi.fn().mockResolvedValue(undefined)` instead of fake-timer gymnastics.
- **Deploying**: out of scope for this assessment (no deployment target). The build artifact is a TypeScript library; the demo runs via `tsx`.

**How I verify AI-generated work rather than blindly accepting it.**
- Every AI-suggested test is reviewed against the contract-vs-implementation principle. See `docs/ai-testing-log.md` for the full list of rejected/modified tests.
- Every AI-suggested code change is type-checked (`npm run build`) and tested (`npm test`) before commit.
- **Cross-model audit**: planning notes and finished diffs were run through GPT 5.5 as a second reviewer. A model auditing its own output is a weak signal; a different model catching the same blind spot is a strong one.
- For the written answers, the `assessment-rubric` skill encodes the grading signals (cite tools/patterns/tradeoffs, real examples for E1-E3). I draft against the rubric, not against the AI's first output.
- I use the `plan` mode for non-trivial changes to review the approach before any code is written.

**The `doom_loop` guard.** opencode has a built-in guard for when the same tool call repeats 3 times with identical input — it prompts the user to confirm rather than continuing. This is the protection against "the model is stuck in a loop." I leave it at the default.

---

## Section E — Behavioral Questions

### E1 — Vague or Shifting Requirements

> Describe a situation where requirements were unclear or kept changing. How did you work with stakeholders to get clarity and still deliver?

At Accenture I joined a recently-started project customizing our software for a client. The engagement was still getting its footing — there was plenty of work, but it hadn't been broken down into assignments, so most of the ~15 people I worked with regularly had nothing formally on their plates.

Rather than wait, I went to my direct manager for a quick scoping chat — what's most pressing, where can I help. From that I sketched a rough breakdown of the backlog into ownership-sized pieces, confirmed with whoever each piece belonged to, and picked up my share. I also ended up handling a lot of the client communication because my English was stronger than most of the team's, and that had been a bottleneck.

We went from "nothing assigned" to an organized breakdown in a little over a week, and moved past the project's early stage about a week ahead of schedule. What I took from it: unclear requirements are usually a communication problem first. A short conversation plus a written breakdown people can react to gets you further than waiting for clarity to show up.

### E2 — Advocating for New Technology

> Tell me about a time you pushed for adopting a new AI tool, framework, or cloud service. How did you build the case, handle objections, and measure success?

I was on a planning project using o9, and people rotated in and out roughly every two months. Every newcomer needed the same onboarding on the software and conventions, which kept pulling senior people away from their actual work.

I suggested building an AI agent as an always-on teaching assistant and drove it end to end. The existing docs were copyrighted so we couldn't feed them to the model, so I wrote new original documentation covering the same ground. I tuned `temperature` and `top-k` and documented the reasoning rather than just the values, so nobody would undo them later without knowing why. We started on a company-owned model, moved to Copilot once the concept proved out, and had a Python-based agent planned once the MVP was approved. I shipped the MVP and demoed it to justify access to better tooling.

We held our delivery level steady through every newcomer cycle — it normally dipped a bit each time because the experts were busy training. The case for the better tools was carried by a working prototype, not a deck.

### E3 — Owning a Failure

> Share a significant technical failure or production bug you were responsible for. How did you take ownership, fixed it, communicated to stakeholders, and prevented recurrence?

While building the log-redaction layer for the harness in this assessment, I realized my first pass only handled JSON patterns like `"ssn": "123-45-6789"`. But the prompts are free text — things like `Date of birth: 1947-03-12` or `Resident: Margaret Thompson` aren't JSON, so they went straight to the logs unredacted. For a HIPAA-covered elderly-care CRM, that's a real defect.

I found it during a self-audit before anything shipped, documented it honestly in the security write-up (Section C2) rather than quietly patching it, and rebuilt the redaction as four independent layers — JSON, fenced multi-line blocks, colon-separated field patterns, and format-only patterns that catch SSNs/phones/emails/dates regardless of field name. I also flipped the default logging to metadata-only, so prompt and output content isn't logged unless you explicitly opt in. Then I added regression tests in `tests/harness.test.ts` feeding a real free-text prompt through and asserting none of the PHI values survive.

All 42 tests pass, including the redaction ones. The takeaway for me was that a single regex is fragile — making each layer cover the others' blind spots, and defaulting to "don't log content at all," is what actually keeps the next dev's mistake from leaking PHI.
