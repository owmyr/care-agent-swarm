import type { LLMHarness } from '../harness/index.js';
import type { FamilyInput, FamilyOutput } from './contracts.js';
import { FamilyInputSchema, FamilyOutputSchema } from './contracts.js';
import { type SubAgent, buildSubAgent } from './subagent.js';

const SYSTEM_PROMPT = `You are a patient and family communication specialist at a residential care facility. Draft communications that are clear, empathetic, and informative for the families of new residents.

Use simple, plain language. Avoid medical jargon or define it on first use. Tone should be warm but professional. Always return a single JSON object matching the requested schema.`;

export function createFamilyCommunicationAgent(
  harness: LLMHarness,
): SubAgent<FamilyInput, FamilyOutput> {
  return buildSubAgent<FamilyInput, FamilyOutput>({
    name: 'family-communication',
    systemPrompt: SYSTEM_PROMPT,
    outputSchema: FamilyOutputSchema,
    sensitiveFields: [
      'residentName',
      'familyContactName',
      'familyContact',
      'email',
      'phone',
      'emergencyContact',
      'assignedNurse',
    ],
    harness,
    fallbackOutput: () => ({
      subject: 'Welcome to our care community',
      greeting: 'Dear family,',
      body: 'Welcome. Our team is preparing a personalized welcome letter for you. A care coordinator will be in touch shortly.',
      keyPoints: ['A welcome letter is being prepared for you.'],
      signature: 'The Care Team',
      tone: 'warm' as const,
    }),
    userPrompt: (input) => {
      FamilyInputSchema.parse(input);
      return `Compose a welcome communication for the family of a new resident.

- Resident name: ${input.residentName}
- Family contact: ${input.familyContactName}
- Facility: ${input.facilityName}
- Admission date: ${input.admissionDate}
- Care level: ${input.careLevel}
- Assigned nurse: ${input.assignedNurse}
- Visiting hours: ${input.visitingHours}
- Facility emergency contact: ${input.emergencyContact}

Return a JSON object with this exact structure:
{
  "subject": "<email subject line>",
  "greeting": "<personalized greeting>",
  "body": "<=300 word welcome body, plain language, warm tone>",
  "keyPoints": ["3-5 short bullet points of practical information"],
  "signature": "<facility signature line>",
  "tone": "formal" | "warm" | "informational"
}

Return only the JSON object, no prose.`;
    },
  });
}
