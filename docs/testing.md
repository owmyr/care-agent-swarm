# Testing Architecture & Verification Philosophy

This document outlines the testing patterns, design decisions, and verification strategy implemented in the **Multi-Agent Swarm AI Orchestration Layer**.

---

## 1. Core Testing Philosophy: Contract Over Implementation

In production AI and multi-agent systems, tests must assert on **observable system contracts and policies**, never on internal wall-clock delays or incidental implementation details.

### Rule 1: Assert on Contract Invariants, Not Internal Timers
*Fragile Approach*: Asserting that a function called `sleep(1000)` or waiting 1 second in real time. If backoff jitter or retry math changes slightly, tests break while behavior remains correct.
*Engineered Approach*: Assert that following a transient `429 RateLimitError`, the harness performs exactly the expected number of retry attempts (`attempts === 2`), succeeds eventually (`status === 'ok'`), and returns the target payload.

### Rule 2: Client Dependency Injection Over Fragile Module Mocks
*Fragile Approach*: Using `vi.mock('@anthropic-ai/sdk')`. Module-level mocks are notoriously brittle across bundlers, pollute global test scopes, and break whenever library internal export trees change.
*Engineered Approach*: Define a minimal, decoupled `HarnessClient` interface:
```ts
export interface HarnessClient {
  messages: {
    create(args: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal; timeout?: number }): Promise<Anthropic.Message>;
  };
}
```
Both the production Anthropic SDK and the test-suite `FakeAnthropicClient` implement this interface. The identical production code path executes across production, deterministic tests, and terminal demos.

### Rule 3: Structured Log Assertion Over String Scraping
*Fragile Approach*: Checking if log outputs contain a human-readable string like `'Retrying request in 1000ms'`.
*Engineered Approach*: Intercept structured JSON log events via custom Pino destinations and assert on machine-readable payload fields:
```ts
const attemptLog = captured.find((c) => c.msg === 'llm_call_success');
expect(attemptLog).toBeDefined();
expect(attemptLog?.obj.requestId).toMatch(/^req_/);
```

### Rule 4: Explicit Failure-Mode First Testing
Happy paths are simple; resilience systems are proven in failure modes. The test suite systematically tests:
- Rate-limiting (429) recovery honoring `Retry-After`.
- Non-retryable error short-circuiting (400 `BadRequestError` must fail immediately without wasting tokens).
- Circuit breaker state transitions (`CLOSED` -> `OPEN` -> `HALF_OPEN` -> `CLOSED`).
- Timeout races degrading gracefully rather than crashing processes.
- Sub-agent failure isolation in concurrent swarm execution.
- Missing field inference and hard loop-guard halts in incident workflows.

---

## 2. Injected Sleep & Deterministic Backoff

Backoff and retry algorithms normally incur real wall-clock delays during test runs, turning test suites into slow, multi-second bottlenecks.

The harness accepts an optional `sleep` parameter:
```ts
export interface HarnessOptions {
  sleep?: (ms: number) => Promise<void>;
  // ...
}
```
During tests, a zero-delay mocked sleep (`() => Promise.resolve()`) is injected. This allows verifying multi-attempt backoff logic, `Retry-After` header parsing, and retry counters in **under 300ms** across all 42 test suites without flakiness or timeouts.

---

## 3. Test Suite Matrix

The project maintains 42 automated tests executed with Vitest:

| Suite | File | Tests | Key Invariants Verified |
|---|---|---|---|
| **Harness Resilience** | `tests/harness.test.ts` | 25 | Rate-limit retries; `Retry-After` honoring; circuit breaker state machine; 4-layer PHI redaction; timeout races; schema validation retries. |
| **Swarm Orchestration** | `tests/swarm.test.ts` | 6 | `Promise.allSettled` fault isolation; partial status calculation; sub-agent failure flagging; orchestrator summary synthesis with generic fallback. |
| **Incident Workflow** | `tests/incident.test.ts` | 11 | Dynamic classification; single-pass convergence; iterative missing field inference; loop guard triggering after `maxIterations: 3`; automated human escalation. |

---

## 4. Running Verification

```bash
# Execute entire test suite
npm test

# Run tests in watch mode
npm run test:watch

# Static typecheck
npm run build

# Fast Biome lint and format check
npm run lint
```
