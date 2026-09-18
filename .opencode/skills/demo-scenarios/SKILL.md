---
name: demo-scenarios
description: Guide for running and inspecting the 3 interactive terminal demonstration scenarios in src/demo/*: (1) harness handling simulated rate-limiting (429 + Retry-After), (2) multi-agent swarm fault tolerance and partial failure handling, (3) incident workflow hitting max-iteration loop guard and triggering automated human escalation.
---

# Interactive Demonstration Scenarios

The system provides 3 deterministic, zero-API-key interactive scenarios showcasing core architectural capabilities.

## Running the Scenarios

```bash
npm run demo
```

All 3 scenarios run against `FakeAnthropicClient`, executing in ~1 second with structured ANSI terminal rendering.

---

## Scenario 1 — Harness: Simulated Rate-Limit (429 + Retry-After)

`FakeAnthropicClient` returns `RateLimitError` with a `Retry-After: 1` header on the first call, then succeeds.

**Behavior verified**:
- Logs the first attempt with `msg: llm_call_failed` and `kind: rate_limit`.
- Harness parses `Retry-After: 1` and waits before retrying.
- Logs the retry attempt succeeding with `msg: llm_call_success`.
- Returns `HarnessResult { status: 'ok', attempts: 2, requestId: 'req_fake_0002' }`.
- Key architecture invariant: Anthropic SDK native retries are disabled (`maxRetries: 0`) so the harness maintains single-point ownership over backoff and retry accounting.

---

## Scenario 2 — Swarm: Sub-Agent Failure & Continuation

`FakeAnthropicClient` is configured to throw a non-retryable error for one specific sub-agent (`family-communication`) while succeeding for `medical-history` and `regulatory-compliance`.

**Behavior verified**:
- Orchestrator uses `Promise.allSettled` to execute all three sub-agents concurrently.
- Family communication fails; medical and compliance succeed.
- The orchestrator isolates the failure, computes `status: 'partial'`, and marks `incomplete: ['family-communication']`.
- The orchestrator calls the harness to synthesize a multi-agent executive summary reconciling the completed results and highlighting missing components.
- Key architecture invariant: Auxiliary agent failures never crash the broader intake workflow.

---

## Scenario 3 — Incident: Loop Guard Non-Convergence & Human Escalation

The inference simulator is configured to leave at least one required field missing across each iteration, preventing convergence.

**Behavior verified**:
- Evaluates missing regulatory fields against `REQUIRED_FIELDS_BY_TYPE`.
- Iterates up to `maxIterations: 3`.
- Hits the loop guard: sets `loopGuardTriggered: true` and `humanEscalationRequired: true`.
- Generates an immutable `IncidentAuditTrail` recording all 3 iteration passes in `validationHistory`.
- Key architecture invariant: Guaranteed termination of agentic loops with automatic human escalation for regulatory review.

---

## Determinism & Offline Operation

`DEMO_MODE=true` (default in `.env.example`) routes all 3 scenarios to `FakeAnthropicClient`. Terminal runs are 100% deterministic and require zero API keys or external network requests.
