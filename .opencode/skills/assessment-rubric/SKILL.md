---
name: assessment-rubric
description: Use when writing or reviewing any of the assessment's written responses (Sections A, C, D, E), the README, or docs/architecture.md. Encodes the grading signals each section is looking for: cite tools/patterns/real tradeoffs (A), specific mitigations + compliance audit logging (C), show a rejected/modified AI test + dev-agent OS (D), STAR with real examples (E). Use ONLY when the work in progress is a written response or a doc directly graded by a reviewer.
---

# Assessment Rubric (Sections A, C, D, E + README)

The assessment grades on "working code and clear thinking — not theoretical answers." Every
written response must demonstrate depth, specificity, and real tradeoffs.

## Section A — Conceptual Questions (cite tools, patterns, **tradeoffs**)

### A1 — AI Provider Resilience
- Name the pattern (circuit breaker: CLOSED/OPEN/HALF_OPEN).
- Name the *specific* library/API surface (e.g., `Retry-After` header, `_request_id`).
- Discuss real tradeoffs: aggressive retry vs thundering herd; jitter to avoid herd; circuit
  open vs stale cache; degraded mode vs hard fail.
- Reference the harness: "we set `maxRetries: 0` on the SDK because we own the retry policy."
- Discuss user-facing degradation: typed `HarnessResult { status: 'degraded' }` vs raising;
  partial success in a multi-agent context.

### A2 — Agent & Sub-Agent Design Principles
- Ownership boundaries (the swarm SKILL.md captures this — cite it).
- Communication contract: typed Zod messages vs free-form JSON.
- Runaway-loop prevention: max iterations, anti-repeated-state guards, "allSettled" vs "all".
- Contradicting outputs: who resolves conflicts (the orchestrator as synthesizer).
- Observability: trace IDs, per-agent structured logs, request IDs propagated end-to-end.

### A3 — Workflow Automation vs. Custom Code
- Signals to use managed (n8n/Make): < X automations/month, non-engineers own, no SLA, fast
  iteration on workflows.
- Signals to switch to custom: regulatory audit requirements, custom validation logic, need to
  embed in product, complex data flow, SLA, evolving requirements, IP-sensitive.
- Real-world signals from the assessment itself: "structured JSON audit trail for every
  execution" is a *strong* signal toward custom code.

## Section C — Auth & Security Audit

### C1 — Auth architecture
- API keys: env var, never committed, `.env` in `.gitignore`, `.env.example` for repo.
- Rotation: documented procedure, not yet implemented (or: out of scope, here's how).
- Permission scoping: minimum required. For this build, the only secret is `ANTHROPIC_API_KEY`
  used by the harness. No user auth (out of scope for the AI layer).

### C2 — Self-audit
- Attack surfaces: (1) prompt injection in user-supplied clinical notes → mitigated by Zod
  output schema forcing structured fields; (2) PHI in logs → mitigated by pino `redact` config
  with PHI allowlist; (3) API key leak → mitigated by env-var + gitignore; (4) LLM returning
  PII not in input → output schema validation; (5) runaway LLM cost → circuit breaker + max
  iterations; (6) unauthorized actions against the harness → not in scope (no auth layer in
  this build).
- First thing I'd fix with more time: rate-limiting + auth on the orchestrator endpoint if
  this were exposed as a service.
- Audit logging: structured JSON per call (agent, traceId, requestId, attempts, duration,
  status, error kind), with redacted input/output, retained for compliance review.

## Section D — AI-Assisted Testing & Dev Workflow

### D1 — How you tested with AI
- MUST show one rejected/modified AI test with a reason. Example: AI suggested asserting on
  exact backoff sleep duration (e.g., `expect(sleep).toHaveBeenCalledWith(2000)`) — rejected
  because it tests implementation, not policy. Modified to assert `attempts === 2` and
  eventual `status: 'ok'`, which tests the *contract* not the timing.
- Log in `docs/ai-testing-log.md` as we go.

### D2 — Dev Agent OS
- Be specific: tool names, configurations, how you verify AI output rather than blindly
  accepting. Include opencode (this), the model, the skills system, permission hardening,
  the prep layer (AGENTS.md + skills), how I run tests after each change, how I use the
  explore subagent for code search, the `doom_loop` guard, etc.

## Section E — Behavioral Questions (STAR format with **real** examples)

For E1/E2/E3, the user supplies real examples. My drafts include:
- STAR structure (Situation / Task / Action / Result)
- Quantified results where possible
- Clear ownership ("I", not "we")
- Specific tools/technologies named
- Lesson learned or what changed because of it
- Placeholders marked with `<!-- TODO: your real example -->` for the user to fill

## README + docs/architecture.md

- README: setup (prereqs, install, env, run), run-the-3-scenarios commands, file tree, link
  to architecture.md.
- architecture.md: deep dive on harness / swarm / incident with diagrams and tradeoff
  discussion. Feeds Section A1/A2 narrative.
- "Common pitfalls" table (from the planning analysis): API key in code, `allSettled` vs
  `all`, loop without guard, invalid LLM JSON, blocking timeout, sensitive logs, real backoff
  in tests.

## Anti-patterns to avoid in written answers

- ❌ Generic advice ("use retries", "log everything") without naming the specific tool/pattern.
- ❌ Listing features without tradeoffs ("the harness retries 3 times" — so what? what changes
     if retries are 5? what's the thundering herd risk?).
- ❌ "We use Zod" without saying why Zod over Pydantic/io-ts/JSON Schema.
- ❌ "We have tests" without naming what the tests assert or the testing principle.
- ❌ Section D without a concrete rejected/modified example.
- ❌ Section E without a real example (the user must supply these).
