# AI-Assisted Testing Log

This document captures the AI-generated tests that I **rejected or modified** during the Section B build, with the reasoning. This is the Section D1 evidence — "show at least one example of a test you rejected or modified and explain why."

The general pattern across all entries: **AI assistants tend to assert on implementation details (timing, internal state) rather than on the contract (policy, eventual outcome).** I rewrote every test in this directory to assert on contract.

---

## Rejected test #1 — wall-clock backoff assertion

**AI-suggested test** (paraphrased from a Claude-suggested `tests/harness.test.ts` draft):

```ts
it('waits 1 second before retrying when Retry-After is 1', async () => {
  const sleep = vi.fn().mockResolvedValue(undefined);
  const harness = createHarness({ ..., sleep, baseBackoffMs: 1000 });
  await harness.call({ systemPrompt: 's', userPrompt: 'u' });
  expect(sleep).toHaveBeenCalledWith(1000);
});
```

**Why rejected**: This asserts on the *internal sleep call*, not the *external contract*. The contract is "the harness retries once after the server told it to wait" — not "the harness called `sleep(1000)` specifically." If we change the backoff math (e.g., add a +/- 10% jitter to the `Retry-After` value, which Anthropic implicitly expects), the test breaks even though the behavior is correct. Worse, asserting on the exact sleep call encourages the test to be coupled to the implementation, which makes refactoring risky.

**Replaced with**:

```ts
it('retries on rate-limit (429) and succeeds on the second attempt', async () => {
  fake = new FakeAnthropicClient({
    behavior: {
      kind: 'rate_limit_once',
      retryAfterSeconds: 0,
      after: { kind: 'success', content: 'recovered' },
    },
  });
  const harness = createHarness({ client: fake, maxAttempts: 3, baseBackoffMs: 5, jitterMs: 0, sleep: noopSleep, ... });
  const result = await harness.call({ systemPrompt: 's', userPrompt: 'u' });
  expect(result.status).toBe('ok');
  expect(result.attempts).toBe(2);
  expect(result.content).toBe('recovered');
});
```

This asserts on the *contract*: after a rate-limit, the harness eventually succeeds, and the call count is what we expect. It doesn't care whether we sleep 1s or 1.1s, or whether we add jitter to the Retry-After, or whether we use a different sleep mechanism.

---

## Rejected test #2 — module-level mocking via `vi.mock`

**AI-suggested pattern** (from a Claude-suggested test scaffold):

```ts
import { Anthropic } from '@anthropic-ai/sdk';
vi.mock('@anthropic-ai/sdk');
const mockCreate = vi.mocked(Anthropic.prototype.messages.create);
mockCreate.mockRejectedValueOnce(new RateLimitError(429, ...));
```

**Why rejected**: Module-level mocking is fragile across vitest versions, the path-resolution behavior is finicky, and it bypasses the client interface we own. More importantly, it ties the test to `@anthropic-ai/sdk`'s module structure rather than to the harness's contract. If we ever switch SDKs, every test breaks.

**Replaced with** client DI: the harness accepts a `client: HarnessClient` param. The `FakeAnthropicClient` in `src/demo/fakes.ts` implements the same interface as `Anthropic.messages.create`. Tests construct a harness with a fake client, no mocking framework needed. See `tests/harness.test.ts` — every test follows this pattern.

The win: the same code path runs in production (real `Anthropic`), in the demo (`FakeAnthropicClient` for the 3 video scenarios), and in the tests (`FakeAnthropicClient` with scripted behavior). No mocks, no `vi.mock`, no module-path coupling.

---

## Rejected test #3 — string-matching the log line

**AI-suggested assertion**:

```ts
it('logs the retry attempt', async () => {
  // ...
  expect(logOutput).toContain('Retrying request, attempt 1, waiting 1000ms');
});
```

**Why rejected**: Asserting on the exact log string couples the test to a specific human-readable log message. If we change the log message (say, to add structured fields, or to localize, or to rephrase), every test breaks. The contract is "a log line at WARN level with the trace ID and attempt number" — not "the log line contains the literal string `Retrying request`."

**Replaced with**: capture the structured log payload via a fake logger, then assert on the *fields* of the captured payload:

```ts
const captured: Array<{ obj: unknown; msg: unknown }> = [];
// fakeLogger pushes { obj, msg } to captured
const attemptLog = captured.find((c) => c.msg === 'llm_call_success');
expect(attemptLog).toBeDefined();
const obj = attemptLog?.obj as { sensitive: { prompt: string; output: string } };
// logContent: true is required because the default logging is metadata-only — no `sensitive` field is present unless opted in.
expect(obj.sensitive.prompt).not.toContain('123-45-6789');  // redaction works
```

(Real test in `tests/harness.test.ts` passes `logContent: true` on the call; without it, the `sensitive` field is absent entirely.)

The test asserts on the structured shape of the log, not on the rendered string. Changing the human-readable message doesn't break the test.

---

## Rejected test #4 — testing the "happy path only"

**AI-suggested coverage** (from an initial draft): 4 tests, all on the happy path (`status === 'ok'`). The AI prioritized "make the green check show up" over "make the test suite document the failure modes."

**Why rejected**: The assessment specifically asks for resilience, fault tolerance, and a loop guard. A test suite that only covers the happy path is misleading. A reviewer reading the test file would conclude the system only handles the easy case.

**Replaced with** explicit failure-mode tests for every requirement:
- Harness: rate-limit retry, timeout → degraded, non-retryable 400 → no retry, circuit-breaker open → short-circuit
- Swarm: all-succeed (complete), one-fails (partial + flag incomplete), all-fail (failed + still-resolves), schema rejection at boundary, summary synthesis success
- Incident: classification, single-iteration convergence, multi-iteration record, loop guard non-convergence, error containment on classification failure, error containment on infer failure, critical-severity escalation

42 tests total. The failure-mode tests are the ones that prove the system meets the assessment's requirements; the happy-path tests are sanity checks.

---

## Rejected test #5 — asserting on `_request_id` being a string

**AI-suggested assertion**:

```ts
expect(typeof result.requestId).toBe('string');
```

**Why rejected**: Trivially true and not informative. The contract is that the request ID is *propagated from the API response* and is useful for support tickets, not that it has type `string` (which TypeScript already guarantees).

**Replaced with**:

```ts
expect(result.requestId).toMatch(/^req_/);  // Anthropic's request ID format
```

Or, in scenarios where we want to verify it round-trips to a real Anthropic response, the test would set up the fake to return a known `request-id` and assert on that exact value. The current test asserts on the format prefix because that's what the fakes produce and what we'd assert on in production (a non-empty `req_`-prefixed string is the only useful guarantee).

---

## Principles this log captures

1. **Assert on contract, not implementation.** Tests should survive a refactor of the internals.
2. **Use DI over module mocking.** The harness accepts a client; tests pass a fake. No `vi.mock` for SDK calls.
3. **Use structured-log capture, not string matching.** Assert on the fields of the log payload.
4. **Test failure modes explicitly.** A test suite that only covers the happy path is a documentation failure.
5. **Reject assertions on types when a domain assertion is possible.** `typeof === 'string'` is trivial; `=== 'req_xxx'` is meaningful.
6. **Use `vi.useFakeTimers()` sparingly and consciously** — or, in our case, inject a `sleep` function so backoff math is testable without any real waiting. The test asserts on call count and policy, not on real-time delays.

These principles are how I verify AI-generated work rather than blindly accepting it: every AI-suggested test that violates one of them is rewritten before commit. This is also documented in `docs/written-responses.md` Section D1.
