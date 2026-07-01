import type { LLMHarness } from '../harness/index.js';
import type { MedicalInput, MedicalOutput } from './contracts.js';
import { MedicalInputSchema, MedicalOutputSchema } from './contracts.js';
import { type SubAgent, buildSubAgent } from './subagent.js';

const SYSTEM_PROMPT = `You are a geriatric nursing specialist. Analyze the clinical notes provided and produce a structured summary of the resident's medical history.

Be objective, precise, and use appropriate clinical terminology. Always return a single JSON object that matches the requested schema exactly. Never invent information that is not present in the notes. If a section has no findings, return an empty array.`;

export function createMedicalHistoryAgent(
  harness: LLMHarness,
): SubAgent<MedicalInput, MedicalOutput> {
  return buildSubAgent<MedicalInput, MedicalOutput>({
    name: 'medical-history',
    systemPrompt: SYSTEM_PROMPT,
    outputSchema: MedicalOutputSchema,
    sensitiveFields: [
      'residentName',
      'dateOfBirth',
      'medications',
      'diagnosis',
      'conditions',
      'mrn',
      'ssn',
      'rawClinicalNotes',
      'allergies',
    ],
    harness,
    fallbackOutput: () => ({
      summary: 'Medical history could not be parsed automatically; manual review required.',
      conditions: [],
      medications: [],
      allergies: [],
      riskLevel: 'medium' as const,
      flaggedConcerns: ['Automated medical summary unavailable — needs manual review.'],
    }),
    userPrompt: (input) => {
      MedicalInputSchema.parse(input);
      return `Resident: ${input.residentName}
Date of birth: ${input.dateOfBirth}
Admission date: ${input.admissionDate}

Raw clinical notes:
"""
${input.rawClinicalNotes}
"""

Return a JSON object with the following structure:
{
  "summary": "<=200 word plain-language summary of the medical history>",
  "conditions": ["list of medical conditions identified"],
  "medications": ["list of medications mentioned"],
  "allergies": ["list of allergies identified; empty array if none"],
  "riskLevel": "low" | "medium" | "high",
  "flaggedConcerns": ["specific concerns requiring immediate clinical attention; empty array if none"]
}

Return only the JSON object, no prose.`;
    },
  });
}
