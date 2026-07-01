import 'dotenv/config';
import sampleIncident from '../../data/sample-incident.json' with { type: 'json' };
import sampleIntake from '../../data/sample-intake.json' with { type: 'json' };
import { type ResidentIntakeForm, ResidentIntakeFormSchema } from '../agents/contracts.js';
import { createOrchestrator } from '../agents/orchestrator.js';
import { createHarness } from '../harness/index.js';
import { REQUIRED_FIELDS_BY_TYPE } from '../incident/routes.js';
import {
  type ClassificationOutput,
  type IncidentReport,
  IncidentReportSchema,
} from '../incident/schemas.js';
import { createIncidentWorkflow } from '../incident/workflow.js';
import { FakeAnthropicClient } from './fakes.js';
import {
  renderBanner,
  renderIncidentAudit,
  renderIntakeResult,
  renderScenarioFooter,
  renderScenarioHeader,
} from './format.js';

const SAMPLE_INTAKE: ResidentIntakeForm = ResidentIntakeFormSchema.parse(sampleIntake);
const SAMPLE_INCIDENT: IncidentReport = IncidentReportSchema.parse(sampleIncident);

async function scenario1RateLimit(): Promise<void> {
  renderScenarioHeader(1, 'Harness: simulated rate-limit (429 + Retry-After)');
  const fake = new FakeAnthropicClient({
    behavior: {
      kind: 'rate_limit_once',
      retryAfterSeconds: 1,
      after: {
        kind: 'success',
        content: 'Hello from the resilient harness!',
      },
    },
  });
  const harness = createHarness({
    client: fake,
    baseBackoffMs: 200,
    jitterMs: 0,
    maxAttempts: 3,
    timeoutMs: 5000,
    logLevel: 'warn',
  });
  const result = await harness.call({
    systemPrompt: 'You are a friendly greeter.',
    userPrompt: 'Say hello in one short sentence.',
    maxTokens: 64,
    temperature: 0,
  });
  const lines: string[] = [];
  lines.push(`Result status: ${result.status}`);
  lines.push(`Attempts: ${result.attempts}`);
  lines.push(`Content: "${result.content}"`);
  lines.push(`Request ID: ${result.requestId ?? '(none)'}`);
  lines.push(`Duration: ${result.durationMs}ms`);
  lines.push(`Fake client call count: ${fake.callCount$}`);
  renderScenarioFooter(1, lines);
}

async function scenario2SwarmPartial(): Promise<void> {
  renderScenarioHeader(2, 'Agent Swarm: sub-agent failure + continue-and-flag');
  const fake = new FakeAnthropicClient({
    behavior: {
      kind: 'throw_for_subagent',
      failingSubagents: ['family-communication', 'patient and family communication'],
      // Sub-agent calls return JSON; the orchestrator's summary-synthesis call
      // (system prompt about "care-intake coordinator") returns a prose summary.
      otherwise: {
        kind: 'scripted',
        rules: [
          {
            matcher: /care-intake coordinator/i,
            content:
              'Intake processed for Margaret Thompson. Medical history and compliance sub-agents completed successfully; family communication sub-agent failed and was flagged as incomplete. Care team should review the family welcome letter before the resident is admitted.',
          },
        ],
        default: successJsonForMedicalAndCompliance(),
      },
    },
  });
  const harness = createHarness({
    client: fake,
    baseBackoffMs: 100,
    jitterMs: 0,
    maxAttempts: 1,
    logLevel: 'warn',
  });
  const orchestrator = createOrchestrator({ harness });
  const result = await orchestrator.orchestrateResidentIntake(SAMPLE_INTAKE);
  renderIntakeResult(result);
  renderScenarioFooter(2, [
    `Intake status: ${result.status}`,
    `Incomplete sub-agents: ${result.incomplete.join(', ') || '(none)'}`,
    `Flagged issues: ${result.flaggedIssues.length}`,
    `Next steps: ${result.nextSteps.join(' | ') || '(none)'}`,
    `Total duration: ${result.totalDurationMs}ms`,
  ]);
}

async function scenario3LoopGuard(): Promise<void> {
  renderScenarioHeader(3, 'Incident Workflow: validation loop hits max-iteration guard');
  const fake = new FakeAnthropicClient({
    behavior: { kind: 'success', content: '{}' }, // default; overridden by classify/infer via the workflow's scripted behavior
  });
  const harness = createHarness({
    client: fake,
    baseBackoffMs: 50,
    jitterMs: 0,
    maxAttempts: 1,
    maxIterations: 3,
    logLevel: 'warn',
  } as never);

  // Use scripted classify + infer that intentionally leaves required fields empty.
  const classify = async (): Promise<ClassificationOutput> => ({
    type: 'fall',
    severity: 'high',
    reasoning: 'Resident found on floor next to toilet; complaints of hip pain.',
    regulatoryPath: 'state_health_dept_24h',
    requiredNotifications: ['Charge Nurse', 'Attending Physician'],
  });
  const infer = async (
    _report: Record<string, unknown>,
    missing: string[],
  ): Promise<Record<string, string>> => {
    // Deliberately never fill any field — to hit the loop guard.
    const fields: Record<string, string> = {};
    for (const f of missing) fields[f] = '';
    return fields;
  };

  const workflow = createIncidentWorkflow({
    harness,
    options: { maxIterations: 3 },
    classify,
    infer,
  });
  const audit = await workflow.processIncidentReport(SAMPLE_INCIDENT);
  renderIncidentAudit(audit, REQUIRED_FIELDS_BY_TYPE[audit.incidentType]);
  renderScenarioFooter(3, [
    `Incident type: ${audit.incidentType}`,
    `Severity: ${audit.severity}`,
    `Iterations: ${audit.iterations}`,
    `Loop guard triggered: ${audit.loopGuardTriggered}`,
    `Human escalation required: ${audit.humanEscalationRequired}`,
    `Reason: ${audit.escalationReason ?? '(none)'}`,
  ]);
}

function successJsonForMedicalAndCompliance(): string {
  // Generic JSON that satisfies the medical + compliance + family output schemas if
  // the test harness ever returns it. Each sub-agent has its own schema; the family
  // sub-agent will fail because it's rigged to throw, so this default is only used
  // for medical/compliance.
  return JSON.stringify({
    summary: 'Test summary',
    conditions: ['Hypertension'],
    medications: ['Lisinopril 10mg daily'],
    allergies: ['Penicillin'],
    riskLevel: 'medium',
    flaggedConcerns: [],
    compliant: true,
    score: 92,
    violations: [],
    recommendations: [],
    requiresImmediateAction: false,
    subject: 'Welcome',
    greeting: 'Dear family',
    body: 'Body',
    keyPoints: [],
    signature: 'Team',
    tone: 'warm',
  });
}

async function main(): Promise<void> {
  const demoMode = (process.env.DEMO_MODE ?? 'true').toLowerCase() !== 'false';
  const apiKey = process.env.ANTHROPIC_API_KEY;
  process.stdout.write(
    `\n  DEMO_MODE=${demoMode ? 'true' : 'false'}; ANTHROPIC_API_KEY=${apiKey ? 'set' : 'unset'}.\n  The 3 demo scenarios always use scripted FakeAnthropicClient (deterministic for video recording).\n  To hit the real API, see src/index.ts and set DEMO_MODE=false with a valid key.\n\n`,
  );
  renderBanner();
  await scenario1RateLimit();
  await scenario2SwarmPartial();
  await scenario3LoopGuard();
  process.stdout.write('\nAll 3 demo scenarios completed.\n');
}

void SAMPLE_INTAKE;

main().catch((err) => {
  process.stderr.write(
    `Demo failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exitCode = 1;
});
