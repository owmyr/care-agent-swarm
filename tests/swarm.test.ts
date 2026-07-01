import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import sampleIntake from '../data/sample-intake.json' with { type: 'json' };
import type { ResidentIntakeForm } from '../src/agents/contracts.js';
import { createOrchestrator } from '../src/agents/orchestrator.js';
import { FakeAnthropicClient } from '../src/demo/fakes.js';
import { createHarness } from '../src/harness/index.js';

const SAMPLE_INTAKE = sampleIntake as unknown as ResidentIntakeForm;

function noopSleep(): Promise<void> {
  return Promise.resolve();
}

const noopNow = (() => {
  let t = 1_700_000_000_000;
  return () => {
    t += 1;
    return t;
  };
})();

const validMedical = {
  summary: 'Elderly with HTN, T2DM.',
  conditions: ['Hypertension', 'Type 2 Diabetes'],
  medications: ['Lisinopril 10mg'],
  allergies: ['Penicillin'],
  riskLevel: 'medium',
  flaggedConcerns: [],
};
const validCompliance = {
  compliant: true,
  score: 95,
  violations: [],
  recommendations: [],
  requiresImmediateAction: false,
};
const validFamily = {
  subject: 'Welcome to Sunrise Gardens',
  greeting: 'Dear Sarah,',
  body: 'Welcome.',
  keyPoints: ['Visiting hours 9-7'],
  signature: 'Sunrise Gardens Team',
  tone: 'warm',
};

describe('orchestrator — fault tolerance', () => {
  it('returns complete when all sub-agents succeed', async () => {
    const fake = new FakeAnthropicClient({
      behavior: {
        kind: 'success',
        content: JSON.stringify({ ...validMedical, ...validCompliance, ...validFamily }),
      },
    });
    const harness = createHarness({ client: fake, maxAttempts: 1, sleep: noopSleep, now: noopNow });
    const orchestrator = createOrchestrator({ harness });
    const result = await orchestrator.orchestrateResidentIntake(SAMPLE_INTAKE);
    expect(result.status).toBe('complete');
    expect(result.results.medicalHistory.success).toBe(true);
    expect(result.results.compliance.success).toBe(true);
    expect(result.results.familyCommunication.success).toBe(true);
    expect(result.incomplete).toEqual([]);
  });

  it('returns partial when one sub-agent fails (continues, flags incomplete)', async () => {
    const fake = new FakeAnthropicClient({
      behavior: {
        kind: 'throw_for_subagent',
        failingSubagents: ['patient and family communication'],
        otherwise: {
          kind: 'success',
          content: JSON.stringify({ ...validMedical, ...validCompliance }),
        },
      },
    });
    const harness = createHarness({ client: fake, maxAttempts: 1, sleep: noopSleep, now: noopNow });
    const orchestrator = createOrchestrator({ harness });
    const result = await orchestrator.orchestrateResidentIntake(SAMPLE_INTAKE);
    expect(result.status).toBe('partial');
    expect(result.results.medicalHistory.success).toBe(true);
    expect(result.results.compliance.success).toBe(true);
    expect(result.results.familyCommunication.success).toBe(false);
    expect(result.incomplete).toContain('family-communication');
  });

  it('returns failed when all sub-agents fail and still produces a result', async () => {
    const fake = new FakeAnthropicClient({
      behavior: { kind: 'bad_request_always', message: 'fail' },
    });
    const harness = createHarness({ client: fake, maxAttempts: 1, sleep: noopSleep, now: noopNow });
    const orchestrator = createOrchestrator({ harness });
    const result = await orchestrator.orchestrateResidentIntake(SAMPLE_INTAKE);
    expect(result.status).toBe('failed');
    expect(result.incomplete.length).toBe(3);
  });

  it('orchestrator promise always resolves (never throws) even on unexpected sub-agent exceptions', async () => {
    const fake = new FakeAnthropicClient({
      behavior: { kind: 'bad_request_always', message: 'x' },
    });
    const harness = createHarness({ client: fake, maxAttempts: 1, sleep: noopSleep, now: noopNow });
    const orchestrator = createOrchestrator({ harness });
    const promise = orchestrator.orchestrateResidentIntake(SAMPLE_INTAKE);
    await expect(promise).resolves.toBeDefined();
  });
});

describe('orchestrator — schema enforcement', () => {
  it('rejects invalid intake forms (Zod parse failure at the boundary)', async () => {
    const fake = new FakeAnthropicClient({ behavior: { kind: 'success', content: '{}' } });
    const harness = createHarness({ client: fake, maxAttempts: 1, sleep: noopSleep, now: noopNow });
    const orchestrator = createOrchestrator({ harness });
    const bad = {
      ...SAMPLE_INTAKE,
      careLevel: 'not_a_real_level',
    } as unknown as ResidentIntakeForm;
    await expect(orchestrator.orchestrateResidentIntake(bad)).rejects.toBeDefined();
  });
});

describe('orchestrator — summary synthesis uses the harness', () => {
  it('synthesizes a non-empty summary on success', async () => {
    const fake = new FakeAnthropicClient({
      behavior: {
        kind: 'success',
        content: JSON.stringify({ ...validMedical, ...validCompliance, ...validFamily }),
      },
    });
    const harness = createHarness({ client: fake, maxAttempts: 1, sleep: noopSleep, now: noopNow });
    const orchestrator = createOrchestrator({ harness });
    const result = await orchestrator.orchestrateResidentIntake(SAMPLE_INTAKE);
    expect(result.summary.length).toBeGreaterThan(0);
  });
});

// Reference the zod import so it isn't tree-shaken from type info
void z;
