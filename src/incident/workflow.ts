import type { LLMHarness } from '../harness/index.js';
import { classifyIncident, inferMissingFields } from './classify.js';
import {
  DEFAULT_NOTIFICATIONS_BY_TYPE,
  ESCALATION_REASON_BY_SEVERITY,
  REGULATORY_PATH_BY_TYPE,
  REQUIRED_FIELDS_BY_TYPE,
} from './routes.js';
import {
  type ClassificationOutput,
  type IncidentAuditTrail,
  IncidentAuditTrailSchema,
  type IncidentReport,
  IncidentReportSchema,
  type IncidentType,
  type IncidentWorkflowError,
  type Severity,
  type ValidationHistoryEntry,
} from './schemas.js';

const DEFAULT_MAX_ITERATIONS = 3;

export interface IncidentWorkflowOptions {
  maxIterations?: number;
}

export interface IncidentWorkflowDeps {
  harness: LLMHarness;
  options?: IncidentWorkflowOptions;
  classify?: (report: IncidentReport) => Promise<ClassificationOutput | null>;
  infer?: (report: Record<string, unknown>, missing: string[]) => Promise<Record<string, string>>;
}

export function createIncidentWorkflow(deps: IncidentWorkflowDeps) {
  const maxIterations = deps.options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const classify = deps.classify ?? ((r) => classifyIncident(deps.harness, r));
  const infer = deps.infer ?? ((r, m) => inferMissingFields(deps.harness, r as IncidentReport, m));

  return {
    async processIncidentReport(report: IncidentReport): Promise<IncidentAuditTrail> {
      const traceId = crypto.randomUUID();
      const errors: IncidentWorkflowError[] = [];

      // Boundary validation: parse the incoming report. On failure, escalate.
      const reportParse = IncidentReportSchema.safeParse(report);
      if (!reportParse.success) {
        const msg = reportParse.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        errors.push({ phase: 'validate', message: `Invalid IncidentReport: ${msg}` });
        return buildEscalationAudit(report, traceId, 'invalid_report', errors);
      }
      const validatedReport: IncidentReport = reportParse.data;

      let classification: ClassificationOutput | null = null;
      try {
        classification = await classify(validatedReport);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ phase: 'classify', message, kind: 'classification_threw' });
        return buildEscalationAudit(validatedReport, traceId, 'classify_threw', errors);
      }
      if (!classification) {
        errors.push({ phase: 'classify', message: 'Classification failed or returned no result.' });
        return buildEscalationAudit(validatedReport, traceId, 'classify_failed', errors);
      }

      // The LLM may *suggest* a regulatory path; we log it but never use it for routing.
      // The deterministic REGULATORY_PATH_BY_TYPE table is authoritative.
      if (
        classification.regulatoryPath &&
        classification.regulatoryPath !== REGULATORY_PATH_BY_TYPE[classification.type]
      ) {
        errors.push({
          phase: 'route',
          message: `LLM-suggested regulatoryPath '${classification.regulatoryPath}' ignored; using table value '${REGULATORY_PATH_BY_TYPE[classification.type]}'.`,
        });
      }

      const incidentType: IncidentType = classification.type;
      const severity: Severity = classification.severity;
      const regulatoryPath = REGULATORY_PATH_BY_TYPE[incidentType];

      const requiredFields = REQUIRED_FIELDS_BY_TYPE[incidentType];
      const validationHistory: ValidationHistoryEntry[] = [];
      const currentReport: Record<string, unknown> = { ...validatedReport };
      let loopGuardTriggered = false;
      let humanEscalationRequired = false;
      let escalationReason: string | undefined;

      for (let iter = 0; iter < maxIterations; iter += 1) {
        const iterStart = Date.now();
        const missing = requiredFields.filter((f) => isEmpty(currentReport[f]));
        const passed = missing.length === 0;
        const entry: ValidationHistoryEntry = {
          iteration: iter,
          missingFields: missing,
          fieldsAdded: [],
          validationPassed: passed,
          durationMs: 0,
        };
        if (passed) {
          entry.durationMs = Date.now() - iterStart;
          validationHistory.push(entry);
          break;
        }
        if (iter === maxIterations - 1) {
          entry.durationMs = Date.now() - iterStart;
          validationHistory.push(entry);
          loopGuardTriggered = true;
          humanEscalationRequired = true;
          escalationReason = `Max iterations (${maxIterations}) reached with ${missing.length} fields still missing: ${missing.join(', ')}`;
          break;
        }
        try {
          const inferred = await infer(currentReport, missing);
          const added: string[] = [];
          for (const [k, v] of Object.entries(inferred)) {
            if (v && v.trim().length > 0 && isEmpty(currentReport[k])) {
              (currentReport as Record<string, unknown>)[k] = v;
              added.push(k);
            }
          }
          entry.fieldsAdded = added;
          entry.durationMs = Date.now() - iterStart;
          validationHistory.push(entry);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          entry.inferError = message;
          entry.durationMs = Date.now() - iterStart;
          validationHistory.push(entry);
          errors.push({ phase: 'infer', message });
          humanEscalationRequired = true;
          escalationReason = `LLM field inference failed: ${message}`;
          break;
        }
      }

      if (!humanEscalationRequired && (severity === 'high' || severity === 'critical')) {
        humanEscalationRequired = true;
        escalationReason = ESCALATION_REASON_BY_SEVERITY[severity];
      }

      const notificationsSent = buildNotifications(incidentType, severity, humanEscalationRequired);
      if (
        humanEscalationRequired &&
        !notificationsSent.some((n) => n.toLowerCase().includes('human'))
      ) {
        notificationsSent.unshift(
          `Human Reviewer — ${escalationReason ?? ESCALATION_REASON_BY_SEVERITY[severity]}`,
        );
      }

      const finalReport: Record<string, unknown> = {};
      for (const k of requiredFields) finalReport[k] = currentReport[k];
      for (const k of [
        'incidentId',
        'reportedBy',
        'reportedAt',
        'residentId',
        'residentName',
        'location',
        'description',
        'witnesses',
        'immediateActionsTaken',
      ])
        finalReport[k] = currentReport[k];

      const audit: IncidentAuditTrail = {
        incidentId: validatedReport.incidentId,
        traceId,
        processedAt: new Date().toISOString(),
        incidentType,
        severity,
        regulatoryPath,
        iterations: validationHistory.length,
        loopGuardTriggered,
        humanEscalationRequired,
        escalationReason,
        validationHistory,
        finalReport,
        notificationsSent,
        errors,
      };

      // Self-check: validate the audit against its Zod schema. On failure, log but still return the audit
      // (the contract is "always return an audit trail" — we don't throw here).
      const auditParse = IncidentAuditTrailSchema.safeParse(audit);
      if (!auditParse.success) {
        errors.push({
          phase: 'validate',
          message: `Audit trail failed self-validation: ${auditParse.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        });
        audit.errors = errors;
      }

      return audit;
    },
  };
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function buildNotifications(type: IncidentType, severity: Severity, escalate: boolean): string[] {
  const base = [...DEFAULT_NOTIFICATIONS_BY_TYPE[type]];
  if (escalate) {
    if (severity === 'critical') base.unshift('Human Reviewer (CRITICAL — immediate review)');
    else if (severity === 'high') base.unshift('Human Reviewer (HIGH — same-day review)');
  }
  return base;
}

function buildEscalationAudit(
  report: IncidentReport,
  traceId: string,
  reason: string,
  errors: IncidentWorkflowError[],
): IncidentAuditTrail {
  return {
    incidentId: report.incidentId,
    traceId,
    processedAt: new Date().toISOString(),
    incidentType: 'other',
    severity: 'high',
    regulatoryPath: REGULATORY_PATH_BY_TYPE.other,
    iterations: 0,
    loopGuardTriggered: false,
    humanEscalationRequired: true,
    escalationReason: reason,
    validationHistory: [],
    finalReport: { ...report },
    notificationsSent: ['Human Reviewer — workflow unable to complete without manual intervention'],
    errors,
  };
}

// Re-export to keep a stable import surface for tests
export { REQUIRED_FIELDS_BY_TYPE, REGULATORY_PATH_BY_TYPE };
