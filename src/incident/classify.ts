import { z } from 'zod';
import type { LLMHarness } from '../harness/index.js';
import {
  type ClassificationOutput,
  ClassificationOutputSchema,
  type IncidentReport,
} from './schemas.js';

const CLASSIFY_SYSTEM_PROMPT = `You are a clinical incident classifier for a residential elderly care facility. Given a free-text incident description, classify it into the most specific incident type from the controlled vocabulary, assign a severity, and identify the regulatory notification path.

Be conservative with severity — when in doubt, lean higher. Always return a single JSON object matching the requested schema.`;

const INFER_SYSTEM_PROMPT = `You are a clinical documentation specialist. Given an incident report and a list of fields that are missing for regulatory compliance, infer plausible values for those fields using ONLY information present in the report.

- If a field cannot be inferred with reasonable confidence, return it as an empty string.
- Do not fabricate facts not supported by the report.
- Return a single JSON object with a "fields" key mapping each requested field to a value (or empty string).`;

export async function classifyIncident(
  harness: LLMHarness,
  report: IncidentReport,
): Promise<ClassificationOutput | null> {
  const result = await harness.call<ClassificationOutput>(
    {
      systemPrompt: CLASSIFY_SYSTEM_PROMPT,
      userPrompt: buildClassifyPrompt(report),
      maxTokens: 512,
      temperature: 0.1,
      outputJson: true,
      sensitiveFields: ['residentName', 'description', 'immediateActionsTaken'],
    },
    ClassificationOutputSchema,
  );
  if (result.status !== 'ok' || !result.parsedContent) return null;
  return result.parsedContent;
}

function buildClassifyPrompt(report: IncidentReport): string {
  return `Classify this incident report:

Incident ID: ${report.incidentId}
Reported at: ${report.reportedAt}
Reported by: ${report.reportedBy}
Resident: ${report.residentName} (${report.residentId})
Location: ${report.location}
Description: ${report.description}
Witnesses: ${report.witnesses.length > 0 ? report.witnesses.join('; ') : 'none'}
Immediate actions taken: ${report.immediateActionsTaken}

Return a JSON object with this exact structure:
{
  "type": "fall" | "medication_error" | "elopement" | "abuse_allegation" | "medical_emergency" | "property_damage" | "physical_altercation" | "other",
  "severity": "low" | "medium" | "high" | "critical",
  "reasoning": "<short justification>",
  "regulatoryPath": "<agency and timing, e.g. 'state_health_dept_24h'>",
  "requiredNotifications": ["<recipient 1>", "<recipient 2>"]
}

Return only the JSON object.`;
}

const InferFieldsInputSchema = z.record(z.string(), z.string());

export async function inferMissingFields(
  harness: LLMHarness,
  report: IncidentReport,
  missing: string[],
): Promise<Record<string, string>> {
  if (missing.length === 0) return {};
  const result = await harness.call<{ fields: Record<string, string>; reasoning: string }>(
    {
      systemPrompt: INFER_SYSTEM_PROMPT,
      userPrompt: buildInferPrompt(report, missing),
      maxTokens: 600,
      temperature: 0.1,
      outputJson: true,
      sensitiveFields: ['residentName', 'description', 'immediateActionsTaken'],
    },
    // schema for the harness's output validation
    z.object({ fields: InferFieldsInputSchema, reasoning: z.string() }),
  );
  if (result.status !== 'ok' || !result.parsedContent) return {};
  return result.parsedContent.fields;
}

function buildInferPrompt(report: IncidentReport, missing: string[]): string {
  return `Incident report (current state):
${JSON.stringify(report, null, 2)}

Missing fields to infer (in order of regulatory priority): ${missing.join(', ')}

For each missing field, infer the most plausible value from the description, witnesses, and immediate-actions fields. If a value cannot be reasonably inferred, return an empty string for that field.

Return a JSON object with this exact structure:
{
  "fields": { "<fieldName>": "<inferred value or empty string>" },
  "reasoning": "<short note explaining which fields you could and could not infer>"
}

Return only the JSON object.`;
}
