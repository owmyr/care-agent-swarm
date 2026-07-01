# Residential Care CRM — AI Layer

AI layer for a CRM and operating system for owners of residential elderly care facilities. Implements resident intake, care plan management, staff scheduling, incident reporting, family communication, and regulatory compliance as a system of LLM-powered agents with resilience, observability, and audit trails.

Built for the **Accodal AI-Focused Full Stack Developer** technical assessment (Section B).

---

## Quick start

```bash
# install (Node 20+; developed on Node 22)
npm install

# run the 3 video scenarios deterministically (no API key required)
npm run demo

# run the test suite (42 tests, < 1s)
npm test

# type-check
npm run build

# lint + format
npm run lint
npm run format
```

The default `DEMO_MODE=true` keeps the harness on a deterministic `FakeAnthropicClient` so the demo, tests, and video are reproducible without an API key.

> **Note:** `npm run demo` **always** uses scripted `FakeAnthropicClient` (deterministic for the 3 video scenarios). To exercise the real API, use `npm run dev` (a one-shot smoke call against the real Anthropic endpoint).

To use a real Anthropic API instead:

```bash
cp .env.example .env
# edit .env, set ANTHROPIC_API_KEY=sk-ant-...
# set DEMO_MODE=false
npm run dev
```

---

## Architecture

```
                              ┌──────────────────────┐
                              │   Intake Form        │
                              │  (ResidentIntakeForm)│
                              └──────────┬───────────┘
                                         │
                              ┌──────────▼───────────┐
                              │   Orchestrator Agent │  (LLM agent — uses harness)
                              │  (Promise.allSettled)│
                              └──┬──────────┬────────┬┘
                                 │          │        │
                    ┌────────────▼─┐  ┌─────▼─────┐ ┌▼──────────────────┐
                    │  Medical     │  │ Compliance│ │ Family            │
                    │  History     │  │           │ │ Communication     │
                    │  Sub-Agent   │  │ Sub-Agent │ │ Sub-Agent         │
                    └──────┬───────┘  └─────┬─────┘ └──────┬────────────┘
                           │                │              │
                           └────────┬───────┴──────────────┘
                                    │
                       ┌────────────▼─────────────┐
                       │   LLM Harness             │
                       │  - Zod I/O schemas        │
                       │  - Retry + backoff        │
                       │  - Circuit breaker        │
                       │  - Pino redaction         │
                       │  - Timeout + fallback     │
                       │  - _request_id trace      │
                       └────────────┬─────────────┘
                                    │
                              ┌─────▼──────┐
                              │  Anthropic │
                              │  Messages  │
                              │    API     │
                              └────────────┘


                  ┌────────────────────────────┐
                  │  Incident Report           │
                  │  (free text + metadata)    │
                  └─────────────┬──────────────┘
                                │
                  ┌─────────────▼──────────────┐
                  │  Workflow                  │
                  │  1. Classify (LLM)          │
                  │  2. Route (deterministic)   │
                  │  3. Validate (loop,         │
                  │     max-iter guard)        │
                  │  4. Escalate if needed      │
                  │  5. Audit trail (JSON)      │
                  └────────────────────────────┘
```

See `docs/architecture.md` for the deep dive.

---

## Components

| Component | File | Responsibility |
|---|---|---|
| **LLM Harness** | `src/harness/*` | The only thing that calls the Anthropic API. Zod I/O validation, retry+backoff (owns the policy; SDK retries disabled), circuit breaker, pino redaction, configurable timeout → graceful fallback, `_request_id` propagation. |
| **Orchestrator** | `src/agents/orchestrator.ts` | Resident intake coordinator. Fans out 3 sub-agents via `Promise.allSettled`; continues on failure, flags incomplete; synthesizes a final summary via the harness (with generic-text fallback). |
| **Medical History** | `src/agents/medical-history.ts` | Parses + summarizes clinical notes. |
| **Compliance** | `src/agents/compliance.ts` | Validates care plan against CMS + state regs. |
| **Family Communication** | `src/agents/family-communication.ts` | Drafts a plain-language welcome letter. |
| **Incident Workflow** | `src/incident/*` | Classify → route → validate-loop (with `REQUIRED_FIELDS_BY_TYPE` + `maxIterations` guard) → escalate → JSON audit trail with `validationHistory` per iteration. |
| **Demo Runner** | `src/demo/run-all.ts` | The 3 video scenarios in one run, deterministic via `FakeAnthropicClient`. |
| **Tests** | `tests/*` | Policy-based asserts (call count, eventual success), `vi.useFakeTimers()` for backoff, `expect(promise).resolves.toBeDefined()` for never-throws contracts. |

---

## Architecture decisions

### Why Promise.allSettled for the swarm
A `Promise.all` would cancel the whole intake on a single sub-agent failure. `allSettled` lets the orchestrator continue, collect partial results, and explicitly flag what's incomplete — the assessment's exact requirement.

### Why backoff with jitter (and why honor `Retry-After`)
The Anthropic API returns `Retry-After` on 429s. Ignoring it and blindly backing off is incorrect: the server told us exactly when to retry. We honor it first, then fall back to exponential backoff with jitter (`base * 2^attempt + random(0..jitterMs)`). Jitter prevents thundering herd when many clients retry at the same tick.

### Why we own the retry policy (SDK `maxRetries: 0`)
The Anthropic SDK natively retries 408/409/429/5xx (default 2 retries). If we leave that on *and* add our own retry, we'd retry up to 2 × 3 = 6 times. To make the retry/circuit-breaker reasoning coherent end-to-end, we set `maxRetries: 0` and own the policy in the harness.

### Why a circuit breaker
A naïve retry policy will hammer a failing provider and waste tokens. The circuit breaker (CLOSED → OPEN after N consecutive failures → HALF_OPEN after cooldown → CLOSED on probe success) short-circuits requests when the provider is known-bad, and the harness returns `status: 'failed', error.kind: 'circuit_open'`. The caller can choose to fail soft or wait.

### Why Zod everywhere
Zod is the single source of truth: schemas define both runtime validation and (via `z.infer`) TypeScript types. Every agent declares typed input + output; the harness validates the LLM's response against the output schema and retries once on validation failure. The audit trail in the incident workflow is itself validated by a Zod schema.

### Why pino with built-in `redact`
PHI in logs is a compliance issue. Pino's `redact: ['*.ssn', '*.dob', ...]` is a battle-tested native feature. We layer on a per-call `sensitiveFields` allowlist and a regex-based string redaction for when PHI is embedded in a serialized prompt.

### Why the hybrid classify / deterministic validate design
Pure LLM validation is unreliable (the LLM can hallucinate "validation passed"). Pure rules without LLM can't classify free-text incident descriptions. The hybrid: LLM classifies the type, a deterministic `REQUIRED_FIELDS_BY_TYPE` table says which fields are required, the LLM infers/fills missing values, and a deterministic re-check enforces the policy. The audit trail is reproducible because the validation step is deterministic.

### Why client DI
`FakeAnthropicClient` implements the same interface as `Anthropic.messages.create`. The harness accepts a `client` param. This makes the demo deterministic (no real API needed) and the tests reliable (no flaky network), and the same code path runs in production.

---

## Running the 3 required video scenarios

All three run with `npm run demo`:

1. **Harness handles a simulated rate-limit** — `FakeAnthropicClient` returns `RateLimitError(429, Retry-After: 1)` once, then succeeds. The harness waits 1s and retries. Narration: "We honor `Retry-After`, then exponential backoff with jitter."

2. **Swarm with sub-agent failure** — `FakeAnthropicClient` is rigged to throw for the family-communication sub-agent. The orchestrator's `Promise.allSettled` continues, the family agent is flagged as `incomplete`, and a final summary is synthesized via the harness. Narration: "Naive `Promise.all` would cancel the whole intake. `allSettled` lets us continue and flag."

3. **Incident loop guard** — the workflow's `infer` is rigged to never fill any field. After `maxIterations: 3`, `loopGuardTriggered: true`, `humanEscalationRequired: true`, and the audit trail records all 3 iterations. Narration: "The deterministic required-fields check + max-iter guard guarantees we never loop forever."

---

## Common pitfalls (avoided)

| Pitfall | How we avoid it |
|---|---|
| API key in code | `.env` in `.gitignore`, `.env.example` for the repo, harness reads from env only |
| `Promise.all` in the orchestrator | `Promise.allSettled` — one failure doesn't cancel the others |
| Loop without guard | `maxIterations` enforced; on hit, `loopGuardTriggered: true` + escalate |
| Invalid JSON from LLM | Harness retries once on `ValidationError`; demo fakes return valid JSON |
| Blocking timeout | Harness-owned `withHarnessTimeout` race (works for any client) + SDK-native `timeout` as backup; on timeout → `status: 'degraded'`, not a hard fail |
| Sensitive logs | pino `redact: ['*.ssn', ...]` + per-call `sensitiveFields` + regex redaction on string payloads |
| Real backoff in tests | `vi.useFakeTimers()` not used here (we inject `sleep`); harness accepts a `sleep` fn for testability |
| 401 ≠ 429 (don't simulate rate-limit with a bad key) | `FakeAnthropicClient` throws a real `RateLimitError(429, {retry-after})` |
| Module-level mocking fragility | Client DI: harness accepts a `client` param, `FakeAnthropicClient` satisfies the same interface |

---

## Project structure

```
accodal-care-crm-ai/
├── README.md                          ← this file
├── AGENTS.md                          ← opencode project context (always-loaded)
├── opencode.json                      ← opencode config (skills path, permissions, references)
├── package.json
├── tsconfig.json
├── biome.json
├── vitest.config.ts
├── .env.example
├── .gitignore
│
├── data/
│   ├── sample-intake.json             ← Margaret Thompson, 78, assisted living
│   └── sample-incident.json           ← Robert Chen, 82, fall in bathroom (incomplete)
│
├── docs/
│   ├── architecture.md                ← deep dive: harness/swarm/incident diagrams + tradeoffs
│   ├── ai-testing-log.md              ← Section D1: rejected/modified AI test + reason
│   └── written-responses.md           ← Sections A, C, D, E
│
├── src/
│   ├── index.ts                       ← entry point (smoke)
│   ├── harness/                       ← LLM harness (the only thing that calls the API)
│   │   ├── client.ts                  ← Anthropic client factory + DI interface
│   │   ├── schemas.ts                 ← Zod schemas (HarnessInput/HarnessResult + error kinds)
│   │   ├── retry.ts                   ← backoff+jitter, Retry-After parsing, error classification
│   │   ├── circuit-breaker.ts         ← CLOSED/OPEN/HALF_OPEN state machine
│   │   ├── logger.ts                  ← pino factory with built-in redact (PHI allowlist)
│   │   ├── harness.ts                 ← LLMHarness class
│   │   └── index.ts
│   ├── agents/                        ← orchestrator + 3 sub-agents
│   │   ├── contracts.ts               ← Zod schemas for all agent I/O
│   │   ├── subagent.ts                ← SubAgent factory
│   │   ├── medical-history.ts
│   │   ├── compliance.ts
│   │   ├── family-communication.ts
│   │   ├── orchestrator.ts
│   │   └── index.ts
│   ├── incident/                      ← dynamic incident reporting workflow
│   │   ├── schemas.ts                 ← Zod schemas for incident + audit trail
│   │   ├── routes.ts                  ← REQUIRED_FIELDS_BY_TYPE + regulatory paths
│   │   ├── classify.ts                ← LLM classification + field inference
│   │   ├── workflow.ts                ← the loop with max-iter guard
│   │   └── index.ts
│   └── demo/                          ← the 3 video scenarios
│       ├── fakes.ts                   ← FakeAnthropicClient (deterministic)
│       ├── run-all.ts                 ← runs all 3 scenarios
│       └── format.ts
│
├── tests/
│   ├── harness.test.ts                ← 25 tests: retry/redaction/schema/timeout/circuit/logContent
│   ├── swarm.test.ts                  ← 6 tests: complete/partial/failed + never-throws
│   └── incident.test.ts               ← 11 tests: classification, loop, guard, error containment
│
└── .opencode/
    └── skills/                        ← 5 skills (load on-demand)
        ├── llm-harness/SKILL.md
        ├── agent-swarm/SKILL.md
        ├── incident-workflow/SKILL.md
        ├── demo-scenarios/SKILL.md
        └── assessment-rubric/SKILL.md
```

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DEMO_MODE` | `true` | `true` → use `FakeAnthropicClient` (deterministic, no API key). `false` → use real `Anthropic` (requires `ANTHROPIC_API_KEY`). |
| `ANTHROPIC_API_KEY` | _(unset)_ | Required when `DEMO_MODE=false`. Read from env only. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` | Default model for the harness. |
| `HARNESS_MAX_ATTEMPTS` | `3` | Retry attempts (1 initial + N-1 retries). |
| `HARNESS_TIMEOUT_MS` | `20000` | Per-call timeout (ms). |
| `HARNESS_BASE_BACKOFF_MS` | `500` | Base for exponential backoff. |
| `HARNESS_MAX_BACKOFF_MS` | `30000` | Cap for backoff and `Retry-After` honoring. |
| `HARNESS_JITTER_MS` | `1000` | Random jitter added to each backoff (prevents thundering herd). |
| `HARNESS_LOG_CONTENT` | `false` | When `true`, logs the full prompt + output (with the four-layer redaction applied). Default is metadata-only. |
| `CIRCUIT_FAILURE_THRESHOLD` | `5` | Consecutive failures before the breaker opens. |
| `CIRCUIT_COOLDOWN_MS` | `30000` | Time in OPEN before transitioning to HALF_OPEN. |
| `LOG_LEVEL` | `info` | pino level. |

---

## Security

- **API keys**: read from `process.env.ANTHROPIC_API_KEY` only. Never committed (`.env` in `.gitignore`). `.env.example` documents the variable but holds no value.
- **PHI in logs**: pino `redact: ['*.ssn', '*.dob', '*.diagnosis', '*.medications', '*.mrn', '*.apiKey', '*.token', ...]`. Each agent declares its own `sensitiveFields`; the harness also applies regex-based string redaction for sensitive keys serialized into prompts.
- **Permissions in opencode**: `opencode.json` denies `git push` and `rm -rf`; requires approval for other git/network actions; reads of `.env*` are denied by default. See the file for the exact policy.

See `docs/written-responses.md` Section C for the full self-audit and `docs/architecture.md` for the operational observability design.
