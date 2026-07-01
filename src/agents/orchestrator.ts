import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LLMHarness, Logger } from '../harness/index.js';
import { defaultLogger } from '../harness/index.js';
import { createComplianceAgent } from './compliance.js';
import {
  type IntakeOrchestrationResult,
  type ResidentIntakeForm,
  ResidentIntakeFormSchema,
  type SubAgentResult,
} from './contracts.js';
import type {
  ComplianceInput,
  ComplianceOutput,
  FamilyInput,
  FamilyOutput,
  MedicalInput,
  MedicalOutput,
} from './contracts.js';
import { createFamilyCommunicationAgent } from './family-communication.js';
import { createMedicalHistoryAgent } from './medical-history.js';
import type { SubAgent } from './subagent.js';

export interface OrchestratorDeps {
  harness: LLMHarness;
  logger?: Logger;
  medicalAgent?: SubAgent<MedicalInput, MedicalOutput>;
  complianceAgent?: SubAgent<ComplianceInput, ComplianceOutput>;
  familyAgent?: SubAgent<FamilyInput, FamilyOutput>;
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const logger = deps.logger ?? defaultLogger().child({ component: 'orchestrator' });
  const medical = deps.medicalAgent ?? createMedicalHistoryAgent(deps.harness);
  const compliance = deps.complianceAgent ?? createComplianceAgent(deps.harness);
  const family = deps.familyAgent ?? createFamilyCommunicationAgent(deps.harness);

  return {
    async orchestrateResidentIntake(form: ResidentIntakeForm): Promise<IntakeOrchestrationResult> {
      const traceId = randomUUID();
      const log = logger.child({ traceId, residentId: form.residentId });
      const start = Date.now();
      const intakeId = `intake_${traceId.slice(0, 8)}`;

      ResidentIntakeFormSchema.parse(form);
      log.info('intake_started');

      const [medicalRes, complianceRes, familyRes] = await Promise.allSettled([
        safeProcess(medical, {
          residentName: form.residentName,
          dateOfBirth: form.dateOfBirth,
          admissionDate: form.admissionDate,
          rawClinicalNotes: form.rawClinicalNotes,
        }),
        safeProcess(compliance, {
          residentName: form.residentName,
          careLevel: form.careLevel,
          carePlan: form.carePlan,
          state: form.state,
        }),
        safeProcess(family, {
          residentName: form.residentName,
          familyContactName: form.familyContact.name,
          facilityName: form.facilityName,
          admissionDate: form.admissionDate,
          careLevel: form.careLevel,
          assignedNurse: form.assignedNurse,
          visitingHours: form.visitingHours,
          emergencyContact: form.familyContact.phone ?? 'the front desk',
        }),
      ]);

      const medicalResult = toSubAgentResult('medical-history', medicalRes);
      const complianceResult = toSubAgentResult('regulatory-compliance', complianceRes);
      const familyResult = toSubAgentResult('family-communication', familyRes);

      const successCount = [medicalResult, complianceResult, familyResult].filter(
        (r) => r.success,
      ).length;
      const incomplete = [medicalResult, complianceResult, familyResult]
        .filter((r) => !r.success)
        .map((r) => r.name);

      const status: IntakeOrchestrationResult['status'] =
        successCount === 3 ? 'complete' : successCount === 0 ? 'failed' : 'partial';

      const summary = await synthesizeSummary(deps.harness, {
        intakeId,
        residentName: form.residentName,
        medical: medicalResult,
        compliance: complianceResult,
        family: familyResult,
        successCount,
        total: 3,
      });

      const flaggedIssues = collectFlaggedIssues(medicalResult, complianceResult);
      const nextSteps = buildNextSteps(flaggedIssues, incomplete, status);

      const result: IntakeOrchestrationResult = {
        intakeId,
        residentId: form.residentId,
        status,
        completedAt: new Date().toISOString(),
        results: {
          medicalHistory: medicalResult,
          compliance: complianceResult,
          familyCommunication: familyResult,
        },
        summary,
        flaggedIssues,
        incomplete,
        nextSteps,
        totalDurationMs: Date.now() - start,
        traceId,
      };

      log.info(
        { status, successCount, totalDurationMs: result.totalDurationMs },
        'intake_completed',
      );
      return result;
    },
  };
}

async function safeProcess<TIn, TOut>(agent: SubAgent<TIn, TOut>, input: TIn) {
  return agent.process(input);
}

function toSubAgentResult(
  name: string,
  settled: PromiseSettledResult<Awaited<ReturnType<SubAgent<unknown, unknown>['process']>>>,
): SubAgentResult & { name: string } {
  if (settled.status === 'rejected') {
    return {
      name,
      success: false,
      status: 'failed',
      attempts: 0,
      durationMs: 0,
      error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
    };
  }
  const r = settled.value;
  return {
    name,
    success: r.status === 'ok',
    status: r.status,
    attempts: r.attempts,
    durationMs: r.durationMs,
    error: r.error?.message,
    data: r.parsedContent,
    traceId: r.traceId,
  };
}

const SummaryInputSchema = z.object({
  intakeId: z.string(),
  residentName: z.string(),
  medical: z.object({ success: z.boolean(), status: z.string() }),
  compliance: z.object({ success: z.boolean(), status: z.string() }),
  family: z.object({ success: z.boolean(), status: z.string() }),
  successCount: z.number(),
  total: z.number(),
});

async function synthesizeSummary(
  harness: LLMHarness,
  input: Parameters<typeof synthesizeSummaryImpl>[1],
): Promise<string> {
  return synthesizeSummaryImpl(harness, input);
}

async function synthesizeSummaryImpl(
  harness: LLMHarness,
  input: {
    intakeId: string;
    residentName: string;
    medical: { success: boolean; status: string };
    compliance: { success: boolean; status: string };
    family: { success: boolean; status: string };
    successCount: number;
    total: number;
  },
): Promise<string> {
  const fallback = `Intake ${input.intakeId} for ${input.residentName}: ${input.successCount} of ${input.total} sub-agents completed successfully.`;
  const validated = SummaryInputSchema.safeParse(input);
  if (!validated.success) return fallback;

  const result = await harness.call({
    systemPrompt:
      'You are a care-intake coordinator. Produce a concise 2-3 sentence executive summary of a resident intake, including which sub-agents completed and any incomplete items. Plain prose, no JSON, no bullet points.',
    userPrompt: `Resident: ${input.residentName}
Intake ID: ${input.intakeId}
Medical history sub-agent: ${input.medical.success ? 'completed' : 'incomplete'} (${input.medical.status})
Compliance sub-agent: ${input.compliance.success ? 'completed' : 'incomplete'} (${input.compliance.status})
Family communication sub-agent: ${input.family.success ? 'completed' : 'incomplete'} (${input.family.status})

Write 2-3 sentences summarizing this intake for the care team.`,
    maxTokens: 256,
    temperature: 0.3,
    sensitiveFields: ['residentName'],
  });

  if (result.status !== 'ok' || !result.content) return fallback;
  return result.content.trim();
}

function collectFlaggedIssues(
  medical: SubAgentResult & { name: string },
  compliance: SubAgentResult & { name: string },
): string[] {
  const out: string[] = [];
  const medicalData = medical.data as MedicalOutput | undefined;
  if (medicalData?.flaggedConcerns?.length) {
    out.push(...medicalData.flaggedConcerns.map((c) => `Medical: ${c}`));
  }
  if (medicalData?.riskLevel === 'high') {
    out.push('Medical: high clinical risk level reported.');
  }
  const complianceData = compliance.data as ComplianceOutput | undefined;
  if (complianceData?.violations?.length) {
    for (const v of complianceData.violations) {
      out.push(`Compliance [${v.severity}]: ${v.requirement} — ${v.finding}`);
    }
  }
  if (complianceData?.requiresImmediateAction) {
    out.push('Compliance: requires immediate action.');
  }
  return out;
}

function buildNextSteps(
  flagged: string[],
  incomplete: string[],
  status: IntakeOrchestrationResult['status'],
): string[] {
  const steps: string[] = [];
  if (flagged.length) steps.push(`Review ${flagged.length} flagged issue(s) with the care team.`);
  if (incomplete.length) steps.push(`Retry or manually complete: ${incomplete.join(', ')}.`);
  if (status === 'complete' && !flagged.length)
    steps.push('Intake complete; proceed to care plan activation.');
  return steps;
}
