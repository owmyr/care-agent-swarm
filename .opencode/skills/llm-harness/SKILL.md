---
name: llm-harness
description: Use when building or editing src/harness/* — defines the reusable LLM harness wrapping @anthropic-ai/sdk. Covers schema validation (Zod), exponential backoff with jitter honoring Retry-After, circuit breaker (CLOSED/OPEN/HALF_OPEN), pino redaction, configurable timeout with graceful fallback, _request_id propagation, and client DI for testability. Trigger on any harness module, retry policy, circuit breaker, or LLM call wrapper change.
---

# LLM Harness

The harness is the only thing in this system that talks to Anthropic. Every agent goes through it.

## Core Capabilities

1. **Input + output schema validation** — Zod. `HarnessCallOptions` schema (parsed at the entry
   of `call()`) + per-agent output schema. On output validation failure, retry the call once
   before giving up.
2. **Retry with exponential backoff on rate-limit or 5xx** — Own the policy. Set SDK `maxRetries=0`
   so the SDK doesn't double-retry under us. Honor `Retry-After` header from 429s.
3. **Request/response logging with redaction** — pino with `redact: ['*.ssn', ...]` + per-call
   `sensitiveFields`. **Default logging is metadata-only** (no prompt/output content); the
   caller opts in via `logContent: true` on `HarnessCallOptions` or the
   `HARNESS_LOG_CONTENT=true` env var. When opted in, the four-layer redaction is applied:
   JSON tree-walk (parse → walk with `sensitiveFields` → re-stringify), fenced-block
   (`"""..."""` / ` ```...``` `), colon-separated `Field: value`, and format-only
   (SSN/phone/email/date). Default PHI allowlist:
   `ssn, dob, dateOfBirth, diagnosis, medications, mrn, api_key, token`.
4. **Configurable timeout with graceful fallback** — harness-owned `withHarnessTimeout` race
   (works for any client, including `FakeAnthropicClient`) + SDK-native `timeout` as
   backup. On `APITimeoutError` → return `HarnessResult` with `status: 'degraded'`, never
   throw for operational failures.

## Architecture

```
client (DI) → retry+jitter+RetryAfter → circuitBreaker → sdk.messages.create
                                                                       ↓
                                                              output validation
                                                                       ↓
                                                       HarnessResult { status, content, ... }
```

The SDK does NOT retry under us (`maxRetries: 0` at the Anthropic client). We own the entire
retry policy. This makes the circuit breaker + backoff reasoning coherent.

## Key types

```ts
type HarnessStatus = 'ok' | 'degraded' | 'failed';

interface HarnessResult<T> {
  status: HarnessStatus;
  content: string;
  parsedContent?: T;
  attempts: number;
  durationMs: number;
  fallback: boolean;
  error?: { kind: 'rate_limit' | 'timeout' | 'server' | 'validation' | 'circuit_open'; message: string; statusCode?: number };
  requestId?: string;   // _request_id from Anthropic
  traceId: string;      // per-call UUID for log correlation
}
```

`status`:
- `ok` — success
- `degraded` — fallback content returned (e.g., timeout → empty/cached response, but we kept going)
- `failed` — could not produce a usable result; caller should branch / fail soft

## Retry policy

`isRetryable(error)`: retry on `RateLimitError` (429), `APIConnectionError`, `APITimeoutError`,
`InternalServerError` (>=500). Do NOT retry on `BadRequestError` (400), `AuthenticationError` (401),
`PermissionDeniedError` (403), `NotFoundError` (404) — those are programmer errors or auth issues
that won't fix themselves.

`backoff(attempt)`:
- If `Retry-After` header present and parseable → use it (capped at 60s)
- Otherwise → `min(baseMs * 2^attempt + jitter, maxMs)`
- `baseMs = 500`, `maxMs = 30_000`, `jitter = random(0..1000)` ms
- Jitter prevents thundering herd (cited in Section A1)

`maxAttempts = 3` (1 initial + 2 retries) by default; configurable per-call.

## Circuit breaker

State: `CLOSED` (normal) → `OPEN` (after `failureThreshold=5` consecutive failures) → `HALF_OPEN`
(after `cooldownMs=30_000`) → `CLOSED` (on probe success) or back to `OPEN` (on probe failure).

When `OPEN`, harness short-circuits with `HarnessResult { status: 'failed', error.kind: 'circuit_open' }`
immediately (no LLM call). Caller decides whether to use cached/fallback content.

## Timeout

Pass `timeoutMs` through to the SDK via `client.withOptions({ timeout: timeoutMs })` on each call.
Default 20s. On `APITimeoutError` → `status: 'degraded'`, not a hard failure (caller can retry or
fall back).

## Client DI

```ts
export interface HarnessClient {
  messages: { create(args: any, opts?: any): Promise<any> };
}
```

The real `AsyncAnthropic.messages` satisfies this. `FakeAnthropicClient` (in `src/demo/fakes.ts`)
also satisfies it for deterministic testing and video recording. Harness accepts a `client` param;
default factory builds real `Anthropic` from `ANTHROPIC_API_KEY` if present, else fake.

## When editing harness/* — checklist

- [ ] Did you keep `maxRetries: 0` on the SDK? (we own retry)
- [ ] Did you honor `Retry-After`?
- [ ] Did the circuit breaker state transition? Add a unit test.
- [ ] Did you keep default logging metadata-only (no prompt/output content unless `logContent: true`)?
- [ ] Did you log with redaction when `logContent: true`? Verify by grepping logs for a known sensitive value (test should set `logContent: true` since the default omits content entirely).
- [ ] Did you propagate `_request_id`?
- [ ] Operational failures return a result; programmer errors throw.
