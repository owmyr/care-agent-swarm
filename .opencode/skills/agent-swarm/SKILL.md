---
name: agent-swarm
description: Use when building or editing src/agents/* — orchestrator + 3 sub-agents for resident intake. Covers ownership boundaries between orchestrator and sub-agents, typed Zod message contracts, Promise.allSettled fault tolerance ("continue + flag incomplete"), anti-loop guards, and observability (trace IDs, per-agent structured logs). Trigger on any agent, orchestrator, sub-agent, or swarm fan-out change.
---

# Agent Swarm — Resident Intake

The swarm handles a new-resident intake form. The **orchestrator** coordinates three
**sub-agents** in parallel, continues if any fail, and synthesizes a final summary.

## Ownership boundaries (use ONLY this assignment)

| Agent | Owns | Reads | Writes |
|---|---|---|---|
| **Orchestrator** | fan-out, fault tolerance, final synthesis (LLM), status enum | Intake form | `IntakeOrchestrationResult` |
| **Medical History** | parse + summarize clinical notes | clinical notes | structured `MedicalSummary` |
| **Regulatory Compliance** | validate care plan vs state regs | care plan + state | compliance report with score + violations |
| **Family Communication** | draft plain-language welcome | resident + family + facility | letter (subject, body, key points) |

The orchestrator does NOT re-validate medical, compliance, or family-domain logic. Each sub-agent
owns its domain end-to-end. The orchestrator is a coordinator + synthesizer, not a re-doer.

## Typed message contract (Zod)

All inter-agent messages are Zod schemas. The orchestrator and sub-agents exchange typed
`HarnessResult<SubAgentOutput>` envelopes — never raw strings, never `any`.

```ts
// contracts.ts
export const MedicalInput = z.object({ residentName: z.string(), dateOfBirth: z.string(), rawClinicalNotes: z.string(), admissionDate: z.string() });
export const MedicalOutput = z.object({ summary: z.string(), conditions: z.array(z.string()), medications: z.array(z.string()), allergies: z.array(z.string()), riskLevel: z.enum(['low','medium','high']), flaggedConcerns: z.array(z.string()) });
// ... ComplianceInput/Output, FamilyInput/Output
```

## Fault tolerance — Promise.allSettled

```ts
const [medical, compliance, family] = await Promise.allSettled([
  processMedicalHistory(input),
  validateCompliance(input),
  draftFamilyCommunication(input),
]);
```

NEVER `Promise.all` — one rejection would cancel the others and violate the "continue and flag"
requirement. `allSettled` always resolves with per-promise `{status: 'fulfilled' | 'rejected', value|reason}`.

For each settled result:
- `fulfilled` with `HarnessResult.status === 'ok'` → success, store `parsedContent`
- `fulfilled` with `status === 'degraded'|'failed'` → flag as incomplete, store error
- `rejected` → flag as incomplete, store reason message

## Status enum

```ts
type IntakeStatus = 'complete' | 'partial' | 'failed';
```

- `complete` — all 3 sub-agents returned `status: 'ok'`
- `partial` — at least 1 success and at least 1 failure
- `failed` — all 3 failed

## Orchestrator as LLM agent

The orchestrator uses the harness to synthesize a 2-3 sentence executive `summary` from the
sub-agent results. If THAT call fails, fall back to a generic template
("Intake processed. N of 3 sub-agents completed successfully. Incomplete: ..."). This makes
the orchestrator a real LLM agent (faithful to the "Orchestrator agent" wording in the assessment)
and demonstrates harness reuse at the top of the stack.

## Anti-loop guards

- No retry loops in the orchestrator. Sub-agents get one harness call each (with the harness's
  own internal retry for transient errors). Don't add another retry layer on top.
- Cap synthesis call attempts: same as sub-agent default.

## Observability

Every agent binds a `traceId` (UUID) via `logger.child({ traceId, agent: 'medical-history' })`.
Logs include: agent name, traceId, sub-agent name, attempt count, duration, status, requestId.

The `IntakeOrchestrationResult` includes `traceId` so the full intake trace is reconstructable
from logs.

## When editing src/agents/* — checklist

- [ ] Each sub-agent has typed Zod input + output
- [ ] All sub-agents run via the harness (never direct SDK call)
- [ ] `Promise.allSettled` (not `.all`)
- [ ] Status enum computed from sub-agent success count
- [ ] Orchestrator synthesis has a generic fallback
- [ ] Sensitive fields marked in `sensitiveFields` (dob, medications, diagnosis, mrn, ssn)
- [ ] No comments unless documenting a non-obvious tradeoff
