---
name: demo-scenarios
description: Use when building or editing src/demo/* or when planning the 10-15 min video walkthrough. Encodes the 3 exact scenarios the assessment requires on video: (1) harness handling a simulated rate-limit (429 + Retry-After), (2) agent swarm running end-to-end with a sub-agent failure, (3) incident workflow hitting its max-iteration loop guard. Also includes narratable script outline and a time budget. Trigger whenever touching demo code or planning the recording.
---

# Demo Scenarios (Video Walkthrough)

The assessment requires the video to demonstrate these **3 exact moments**. Use ONLY these.

## Time budget (10–15 min total)

| Segment | Time | Content |
|---|---|---|
| Intro | 0:00–1:30 | Architecture diagram, file tree, what each module does |
| Scenario 1 — Harness rate-limit | 1:30–4:00 | Show retry policy, circuit breaker, run demo 1 |
| Scenario 2 — Swarm sub-agent failure | 4:00–8:00 | Show Promise.allSettled, run demo 2 with one agent rigged to fail |
| Scenario 3 — Incident loop guard | 8:00–12:00 | Show REQUIRED_FIELDS_BY_TYPE, run demo 3 with non-converging validator |
| Tests | 12:00–13:30 | `npm test`, point at retry/failure/loop-guard tests |
| Close | 13:30–15:00 | Architecture decisions, what I'd add with more time |

## Scenario 1 — Harness: simulated rate-limit (429 + Retry-After)

`FakeAnthropicClient` returns `RateLimitError` with a `Retry-After: 2` header on the first call,
then succeeds. The demo:
- Logs the first attempt
- Shows the harness reading `Retry-After: 2` and waiting 2s
- Logs the retry attempt succeeding
- Prints the final `HarnessResult { status: 'ok', attempts: 2, requestId: 'req_...' }`

**Narration point**: "We own the retry policy — the SDK's native retries are disabled so this
reasoning is coherent end-to-end. The harness honors the `Retry-After` header from Anthropic
rather than always using exponential backoff."

## Scenario 2 — Swarm: sub-agent failure

`FakeAnthropicClient` is rigged to throw for one specific sub-agent (family-communication) and
succeed for the other two. The demo:
- Shows `Promise.allSettled` starting all three in parallel
- Shows the family-comm agent failing; medical and compliance succeeding
- The orchestrator continues, synthesizes a summary via the harness
- Final `IntakeOrchestrationResult { status: 'partial', results: { ... }, incomplete: ['family-communication'], summary: '...' }`

**Narration point**: "A naive `Promise.all` would have cancelled the whole intake. `allSettled`
lets us continue and explicitly flag what's incomplete — the assessment's exact requirement."

## Scenario 3 — Incident: loop guard non-convergence

The validator is rigged to never converge — every iteration, the LLM-inferred fields leave at
least one required field empty. After `maxIterations=3`:
- `validationHistory` shows 3 iterations, each with `missingFields` non-empty
- `loopGuardTriggered: true`
- `humanEscalationRequired: true`
- `escalationReason: 'Max iterations reached with N fields still missing'`

**Narration point**: "The deterministic required-fields check + max-iteration guard guarantees
we never loop forever and that the audit trail is reproducible. The LLM classifies and infers;
the policy is enforced in code."

## Determinism

`DEMO_MODE=true` (default in `.env.example`) forces all 3 scenarios onto `FakeAnthropicClient`.
The video is identical every recording run — no flaky real API behavior.

## Restore-after-modification note

Scenario 2 and 3 rig the fakes via flags/script args. The harness and workflow code is
unchanged. The recording script reverts to default after the run. No live edits to source
during recording.

## What NOT to include in the video

- Live real-API calls (use fakes; no API key required; deterministic)
- Editing source files during recording (pre-scripted)
- Wall-clock waits longer than ~3s (fake-timer behaviors are narrated, not shown)
- Any dependency installation mid-recording (do it before)

## When editing src/demo/* — checklist

- [ ] All 3 scenarios runnable with `npm run demo`
- [ ] Each scenario prints structured, scannable output (not just JSON dumps)
- [ ] Scenarios use the real harness/swarm/incident code (not separate demo-only code paths)
- [ ] Resetting fakes between scenarios so re-runs are identical
- [ ] `DEMO_MODE=true` is the default; `DEMO_MODE=false` requires `ANTHROPIC_API_KEY` and prints a clear warning
