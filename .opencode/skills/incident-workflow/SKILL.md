---
name: incident-workflow
description: Use when building or editing src/incident/* — dynamic incident reporting workflow. Covers classify (LLM) → route (REQUIRED_FIELDS_BY_TYPE table) → validate-loop (max-iter guard) → escalate-to-human → structured JSON audit trail with validationHistory per iteration. Trigger on any incident, classification, routing, validation, escalation, or audit trail change.
---

# Incident Reporting Workflow

When a staff member files an incident, the workflow:
1. **Classifies** the incident type via the LLM
2. **Routes** to the correct regulatory notification path (deterministic per type)
3. **Loops** through a validation step until all required fields are filled
4. **Escalates** to a human reviewer if the loop does not converge within `maxIterations`
5. **Outputs** a structured JSON audit trail (every iteration recorded)

## Why the hybrid classify / deterministic validate design

Pure LLM validation is unreliable (the LLM can hallucinate "validation passed"). Pure rules
without LLM can't classify free-text descriptions. The hybrid:
- LLM does what it's good at: interpret free text → classify type, infer field values from prose
- Deterministic code does what it's good at: check field presence, enforce policy

This separation makes the audit trail trustworthy (the validation step is reproducible).

## REQUIRED_FIELDS_BY_TYPE

Static table in `routes.ts`. Each incident type maps to the regulatory-required fields.
Source of truth: this table. The LLM cannot redefine "required."

```ts
export const REQUIRED_FIELDS_BY_TYPE: Record<IncidentType, string[]> = {
  fall: ['bodyPartAffected', 'fallLocation', 'supervisingNurse', 'physicianNotified', 'injuryLevel'],
  medication_error: ['medicationName', 'dosageGiven', 'dosagePrescribed', 'pharmacistNotified', 'residentCondition'],
  elopement: ['durationMissing', 'foundLocation', 'policeNotified', 'familyNotified', 'preventionMeasures'],
  abuse_allegation: ['allegationType', 'accusedParty', 'witnessStatements', 'administrationNotified', 'ombudsmanNotified'],
  medical_emergency: ['vitalSigns', 'emergencyServicesContacted', 'hospitalTransfer', 'physicianNotified', 'familyNotified'],
  property_damage: ['damageExtent', 'estimatedCost', 'responsibleParty', 'insuranceNotified'],
  physical_altercation: ['partiesInvolved', 'injuriesSustained', 'witnessStatements', 'policeNotified', 'counselingArranged'],
  other: ['description', 'supervisorNotified', 'resolutionPlan'],
};
```

`REGULATORY_PATH_BY_TYPE`: which agency must be notified, with timing.

## The loop

```
classification → requiredFields = REQUIRED_FIELDS_BY_TYPE[class] →
loop (iter < maxIter):
  missing = requiredFields.filter(f => !report[f] || report[f] === '')
  record { iteration, missing, fieldsAdded, validationPassed: missing.length === 0 }
  if missing.length === 0: break (success)
  fieldsAdded = await llmInferFields(report, missing)  // harness call
  report = { ...report, ...fieldsAdded }
  iter++
if iter >= maxIter and still missing: loopGuardTriggered = true, humanEscalationRequired = true
```

Default `maxIterations = 3` (demo uses 3 to hit the guard fast). Configurable.

## Audit trail shape

```ts
interface IncidentAuditTrail {
  incidentId: string;
  traceId: string;
  processedAt: string;     // ISO
  incidentType: IncidentType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  regulatoryPath: string;  // e.g., 'state_health_dept_24h'
  iterations: number;
  loopGuardTriggered: boolean;
  humanEscalationRequired: boolean;
  validationHistory: Array<{
    iteration: number;
    missingFields: string[];
    fieldsAdded: string[];
    validationPassed: boolean;
    durationMs: number;
  }>;
  finalReport: Record<string, unknown>;
  notificationsSent: string[];
  escalationReason?: string;
  errors: Array<{ phase: 'classify' | 'infer' | 'validate'; message: string }>;
}
```

`errors[]` records operational failures but does NOT cause the workflow to throw. The workflow
always returns an audit trail — `humanEscalationRequired: true` is set on any unrecoverable
operational failure.

## Anti-runaway guarantees

- Hard cap `maxIterations` (default 3)
- Per-iteration timeout (via harness's own timeout)
- Workflow-level timeout is the harness's job, not duplicated here
- `loopGuardTriggered: true` is set the moment the cap is hit; do not try "one more iteration"
- The workflow never throws; it returns the audit trail with errors recorded

## When editing src/incident/* — checklist

- [ ] `REQUIRED_FIELDS_BY_TYPE` is the single source of required fields per type
- [ ] LLM classifies + infers; deterministic code validates
- [ ] `validationHistory` records every iteration
- [ ] `maxIterations` is enforced
- [ ] On loop guard: `loopGuardTriggered: true`, `humanEscalationRequired: true`
- [ ] On operational failure: record in `errors[]`, escalate, do not throw
- [ ] No comments unless documenting a non-obvious tradeoff
