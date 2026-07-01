import type { IntakeOrchestrationResult } from '../agents/contracts.js';
import type { IncidentAuditTrail, IncidentType } from '../incident/schemas.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';

export function renderBanner(): void {
  process.stdout.write(
    `\n${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}\n` +
      `${BOLD}${CYAN}  Accodal Residential Care CRM — AI Layer (DEMO)${RESET}\n` +
      `${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}\n` +
      `${DIM}  Three scenarios required by the video walkthrough.${RESET}\n\n`,
  );
}

export function renderScenarioHeader(num: number, title: string): void {
  process.stdout.write(
    `\n${BOLD}── Scenario ${num} ──${RESET} ${title}\n` + `${DIM}${'─'.repeat(60)}${RESET}\n`,
  );
}

export function renderScenarioFooter(num: number, lines: string[]): void {
  process.stdout.write(`\n${DIM}  scenario ${num} summary:${RESET}\n`);
  for (const l of lines) process.stdout.write(`  ${l}\n`);
  process.stdout.write(`${DIM}${'─'.repeat(60)}${RESET}\n`);
}

export function renderIntakeResult(result: IntakeOrchestrationResult): void {
  const color = result.status === 'complete' ? GREEN : result.status === 'partial' ? YELLOW : RED;
  process.stdout.write(`\n  status: ${color}${BOLD}${result.status}${RESET}\n`);
  process.stdout.write(`  traceId: ${result.traceId}\n`);
  process.stdout.write(`  intakeId: ${result.intakeId}\n`);
  process.stdout.write(`  summary: ${result.summary}\n`);
  process.stdout.write(
    `  incomplete: ${result.incomplete.length === 0 ? '(none)' : result.incomplete.join(', ')}\n`,
  );
  process.stdout.write(
    `  flaggedIssues: ${result.flaggedIssues.length === 0 ? '(none)' : result.flaggedIssues.join(' | ')}\n`,
  );
  process.stdout.write(
    `  nextSteps: ${result.nextSteps.length === 0 ? '(none)' : result.nextSteps.join(' | ')}\n`,
  );
  process.stdout.write(
    `  results: medical=${result.results.medicalHistory.status} compliance=${result.results.compliance.status} family=${result.results.familyCommunication.status}\n`,
  );
}

export function renderIncidentAudit(
  audit: IncidentAuditTrail,
  required: IncidentType extends never ? never : string[],
): void {
  const color = audit.loopGuardTriggered || audit.humanEscalationRequired ? YELLOW : GREEN;
  process.stdout.write(
    `\n  incidentType: ${audit.incidentType} | severity: ${audit.severity} | regulatoryPath: ${audit.regulatoryPath}\n`,
  );
  process.stdout.write(
    `  iterations: ${audit.iterations} | loopGuard: ${audit.loopGuardTriggered} | humanEscalation: ${color}${audit.humanEscalationRequired}${RESET}\n`,
  );
  process.stdout.write(`  escalationReason: ${audit.escalationReason ?? '(none)'}\n`);
  process.stdout.write(`  required fields: ${required.join(', ')}\n`);
  process.stdout.write('  validationHistory:\n');
  for (const v of audit.validationHistory) {
    const passed = v.validationPassed ? `${GREEN}passed${RESET}` : `${YELLOW}failed${RESET}`;
    process.stdout.write(
      `    #${v.iteration} ${passed} | missing=[${v.missingFields.join(', ') || '∅'}] | added=[${v.fieldsAdded.join(', ') || '∅'}] | ${v.durationMs}ms\n`,
    );
  }
  process.stdout.write(`  notifications: ${audit.notificationsSent.join(' | ')}\n`);
  if (audit.errors.length) {
    process.stdout.write(
      `  errors: ${audit.errors.map((e) => `${e.phase}: ${e.message}`).join(' | ')}\n`,
    );
  }
}
