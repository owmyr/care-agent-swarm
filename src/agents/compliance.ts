import type { LLMHarness } from '../harness/index.js';
import type { ComplianceInput, ComplianceOutput } from './contracts.js';
import { ComplianceInputSchema, ComplianceOutputSchema } from './contracts.js';
import { type SubAgent, buildSubAgent } from './subagent.js';

const SYSTEM_PROMPT = `You are a regulatory compliance specialist for US residential care facilities. Evaluate the care plan against CMS (Centers for Medicare & Medicaid Services) standards and state regulations.

Be rigorous and identify any gaps. Always return a single JSON object matching the requested schema. Use "critical" severity for life-safety issues, "major" for regulatory non-compliance, "minor" for advisory findings.`;

export function createComplianceAgent(
  harness: LLMHarness,
): SubAgent<ComplianceInput, ComplianceOutput> {
  return buildSubAgent<ComplianceInput, ComplianceOutput>({
    name: 'regulatory-compliance',
    systemPrompt: SYSTEM_PROMPT,
    outputSchema: ComplianceOutputSchema,
    sensitiveFields: ['residentName', 'state', 'careLevel', 'carePlan'],
    harness,
    fallbackOutput: () => ({
      compliant: false,
      score: 0,
      violations: [
        {
          requirement: 'Automated compliance review',
          finding: 'Could not be performed; manual review required.',
          severity: 'major' as const,
        },
      ],
      recommendations: ['Conduct manual compliance review of the care plan.'],
      requiresImmediateAction: true,
    }),
    userPrompt: (input) => {
      ComplianceInputSchema.parse(input);
      return `Resident: ${input.residentName}
State: ${input.state}
Care level: ${input.careLevel}

Care plan:
- Daily activities: ${input.carePlan.dailyActivities.join('; ') || '(none specified)'}
- Medical supervision: ${input.carePlan.medicalSupervision || '(none specified)'}
- Emergency protocol: ${input.carePlan.emergencyProtocol || '(none specified)'}
- Nutrition plan: ${input.carePlan.nutritionPlan || '(none specified)'}
- Mobility assistance: ${input.carePlan.mobilityAssistance || '(none specified)'}

Return a JSON object with this exact structure:
{
  "compliant": <true|false>,
  "score": <0-100, percentage of requirements met>,
  "violations": [
    { "requirement": "...", "finding": "...", "severity": "critical" | "major" | "minor" }
  ],
  "recommendations": ["actions to bring the plan into compliance"],
  "requiresImmediateAction": <true|false>
}

Return only the JSON object, no prose.`;
    },
  });
}
