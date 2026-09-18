# AGENTS.md

> Project context for opencode. Loaded automatically into every session.

## Project

**Multi-Agent Swarm AI Orchestration Layer** (`care-agent-swarm`).
High-resilience multi-agent system designed for residential healthcare workflows: resident
intake orchestration, clinical summaries, regulatory compliance validation, compassionate
family communication, and self-healing incident reporting workflows with immutable audit trails.

Core Architectural Components:
1. LLM Harness Module (resilience, circuit breaker, PHI redaction, Retry-After honoring)
2. Agent Swarm for resident intake (orchestrator + 3 sub-agents via Promise.allSettled)
3. Dynamic Incident Reporting Workflow (classify → route → validate-loop → escalate → audit)

## Stack

- **Language**: TypeScript 5.x (target ES2022, strict mode, ESNext modules)
- **Runtime**: Node.js 20+ (developed on 22)
- **LLM client**: `@anthropic-ai/sdk` (Client SDK — direct API, we own the harness retry/timeout policies)
- **Schema validation**: `zod` (single source of truth, `z.infer` for types)
- **Logging**: `pino` (built-in `redact` for sensitive fields)
- **Tests**: `vitest` (harness accepts an injected `sleep` fn so backoff tests don't need real timers)
- **Lint/format**: `biome` (one tool, fast)
- **Run**: `tsx` for direct TS execution (`npm run demo`)

## Commands

```bash
npm install          # install deps
npm run build        # tsc --noEmit (type-check only; emit is not the goal)
npm test             # vitest run (all tests, no watch)
npm run test:watch   # vitest watch mode
npm run dev          # tsx src/index.ts (smoke entry point)
npm run demo         # tsx src/demo/run-all.ts (the 3 demo scenarios, deterministic with fakes)
npm run lint         # biome check .
npm run lint:fix     # biome check --write .
npm run format       # biome format --write .
```

## Key files

```
src/harness/         # LLM harness (client, schemas, retry+circuit-breaker, logger, harness.ts)
src/agents/          # Orchestrator + medical-history, compliance, family-communication sub-agents
src/incident/        # classify → routes → validate-loop → workflow → audit
src/demo/            # fakes.ts (FakeAnthropicClient) + run-all.ts (3 demo scenarios)
data/                # sample-intake.json, sample-incident.json
tests/               # harness, swarm, incident test suites
docs/                # architecture.md, security.md, testing.md
.opencode/skills/    # llm-harness, agent-swarm, incident-workflow, demo-scenarios
```

## Conventions

- **Async-first**: every agent method is `async`; harness uses `AsyncAnthropic` paths.
- **Type hints everywhere**: Zod schema is the source of truth, derive TS types via `z.infer`.
- **Docstrings on public APIs**: describe contract, not implementation.
- **No inline comments** unless a non-obvious tradeoff is being documented.
- **Structured logging**: pino JSON output; sensitive fields redacted via `redact` config.
- **Secrets**: `ANTHROPIC_API_KEY` via `.env` (never committed). Default `DEMO_MODE=true` keeps the
  harness on `FakeAnthropicClient` for deterministic testing. Set `DEMO_MODE=false` to
  hit the real API (requires key).
- **Errors**: operational failures (rate limit, timeout, 5xx, output validation) return a typed
  `HarnessResult` with `status: degraded|failed`. Programmer errors (malformed schema, bad args)
  throw — they are bugs, not expected runtime conditions.
- **Tests**: assert on *policy* (call count, eventual success) not wall-clock timing. The
  harness accepts an injected `sleep` function (or `vi.fn().mockResolvedValue(undefined)`) to
  avoid real backoff sleeps. Explicit `expect(promise).resolves.toBeDefined()` for "never
  rejects" contracts.

## Architecture Highlights

- [x] Harness: schema validation, retry+backoff honoring `Retry-After`, redaction, timeout + graceful fallback
- [x] Harness: circuit breaker (CLOSED/OPEN/HALF_OPEN) + `_request_id` propagation
- [x] Swarm: orchestrator + 3 sub-agents, `Promise.allSettled`, `complete|partial|failed` status
- [x] Swarm: orchestrator uses harness to synthesize final summary (LLM agent, with fallback)
- [x] Incident: classify → `REQUIRED_FIELDS_BY_TYPE` → validate-loop → max-iter-guard → escalate → audit trail
- [x] Incident: `validationHistory` per-iteration records
- [x] Demo: FakeAnthropicClient with 3 deterministic scenario runs (rate-limit, sub-agent failure, loop guard)
- [x] Tests: harness retry/redaction/schema/timeout, swarm failure-continuation, incident loop-guard/audit
- [x] Documentation: README.md, docs/architecture.md, docs/security.md, docs/testing.md
- [x] `npm run build && npm test && npx biome check .` green
