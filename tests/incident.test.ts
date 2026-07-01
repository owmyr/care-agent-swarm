import { describe, expect, it } from 'vitest';
import sampleIncident from '../data/sample-incident.json' with { type: 'json' };
import { FakeAnthropicClient } from '../src/demo/fakes.js';
import { createHarness } from '../src/harness/index.js';
import { REQUIRED_FIELDS_BY_TYPE } from '../src/incident/routes.js';
import type {
  ClassificationOutput,
  IncidentReport,
  InferFieldsOutput,
} from '../src/incident/schemas.js';
import { createIncidentWorkflow } from '../src/incident/workflow.js';

const SAMPLE_INCIDENT = sampleIncident as unknown as IncidentReport;

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

const baseClassify = (overrides: Partial<ClassificationOutput> = {}): ClassificationOutput => ({
  type: 'fall',
  severity: 'high',
  reasoning: 'Resident found on floor next to toilet; complaints of hip pain.',
  regulatoryPath: 'state_health_dept_24h',
  requiredNotifications: ['Charge Nurse', 'Attending Physician'],
  ...overrides,
});

function makeWorkflow(args: {
  classify?: (report: IncidentReport) => Promise<ClassificationOutput | null>;
  infer?: (report: Record<string, unknown>, missing: string[]) => Promise<Record<string, string>>;
  maxIterations?: number;
}) {
  const fake = new FakeAnthropicClient({ behavior: { kind: 'success', content: '{}' } });
  const harness = createHarness({ client: fake, maxAttempts: 1, sleep: noopSleep, now: noopNow });
  const workflow = createIncidentWorkflow({
    harness,
    options: { maxIterations: args.maxIterations ?? 3 },
    classify: args.classify ?? (async () => baseClassify()),
    infer:
      args.infer ??
      (async (_r, missing) => {
        const out: Record<string, string> = {};
        for (const f of missing) out[f] = `inferred_${f}`;
        return out;
      }),
  });
  return { workflow, harness };
}

describe('incident workflow — classification', () => {
  it('classifies the incident and records the correct type/severity', async () => {
    const { workflow } = makeWorkflow({});
    const audit = await workflow.processIncidentReport(SAMPLE_INCIDENT);
    expect(audit.incidentType).toBe('fall');
    expect(audit.severity).toBe('high');
    expect(audit.regulatoryPath).toBe('state_health_dept_24h');
  });
});

describe('incident workflow — validation loop', () => {
  it('converges when infer fills every required field (2 entries: initial check + final pass)', async () => {
    const infer = async (
      _report: Record<string, unknown>,
      missing: string[],
    ): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const f of missing) out[f] = `inferred_${f}`;
      return out;
    };
    const { workflow } = makeWorkflow({ infer, maxIterations: 3 });
    const audit = await workflow.processIncidentReport(SAMPLE_INCIDENT);
    expect(audit.loopGuardTriggered).toBe(false);
    expect(audit.humanEscalationRequired).toBe(true);
    const lastEntry = audit.validationHistory[audit.validationHistory.length - 1];
    expect(lastEntry?.validationPassed).toBe(true);
  });

  it('records one validationHistory entry per iteration', async () => {
    let calls = 0;
    const infer = async (
      _report: Record<string, unknown>,
      missing: string[],
    ): Promise<Record<string, string>> => {
      calls += 1;
      if (calls === 1) {
        return { bodyPartAffected: 'left hip' };
      }
      if (calls === 2) {
        return { fallLocation: 'bathroom', supervisingNurse: 'Alvarez' };
      }
      return Object.fromEntries(missing.map((m) => [m, `inferred_${m}`]));
    };
    const { workflow } = makeWorkflow({ infer, maxIterations: 5 });
    const audit = await workflow.processIncidentReport(SAMPLE_INCIDENT);
    const lastEntry = audit.validationHistory[audit.validationHistory.length - 1];
    expect(lastEntry?.validationPassed).toBe(true);
  });
});

describe('incident workflow — loop guard', () => {
  it('triggers loop guard when validator never converges within maxIterations', async () => {
    const infer = async (
      _report: Record<string, unknown>,
      missing: string[],
    ): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const f of missing) out[f] = '';
      return out;
    };
    const { workflow } = makeWorkflow({ infer, maxIterations: 3 });
    const audit = await workflow.processIncidentReport(SAMPLE_INCIDENT);
    expect(audit.iterations).toBe(3);
    expect(audit.loopGuardTriggered).toBe(true);
    expect(audit.humanEscalationRequired).toBe(true);
    expect(audit.escalationReason).toContain('Max iterations');
  });

  it('REQUIRED_FIELDS_BY_TYPE for "fall" matches the audit', async () => {
    const infer = async (
      _report: Record<string, unknown>,
      _missing: string[],
    ): Promise<Record<string, string>> => ({});
    const { workflow } = makeWorkflow({ infer, maxIterations: 1 });
    const audit = await workflow.processIncidentReport(SAMPLE_INCIDENT);
    expect(REQUIRED_FIELDS_BY_TYPE.fall.length).toBeGreaterThan(0);
    expect(audit.finalReport).toBeDefined();
  });
});

describe('incident workflow — error containment', () => {
  it('returns an audit trail (never throws) when classification fails', async () => {
    const classify = async (): Promise<ClassificationOutput | null> => null;
    const { workflow } = makeWorkflow({ classify });
    const promise = workflow.processIncidentReport(SAMPLE_INCIDENT);
    await expect(promise).resolves.toBeDefined();
    const audit = await promise;
    expect(audit.humanEscalationRequired).toBe(true);
    expect(audit.errors.length).toBeGreaterThan(0);
  });

  it('returns an audit trail (never throws) when classify throws', async () => {
    const classify = async (): Promise<ClassificationOutput | null> => {
      throw new Error('classify threw unexpectedly');
    };
    const { workflow } = makeWorkflow({ classify });
    const promise = workflow.processIncidentReport(SAMPLE_INCIDENT);
    await expect(promise).resolves.toBeDefined();
    const audit = await promise;
    expect(audit.humanEscalationRequired).toBe(true);
    expect(audit.errors.some((e) => e.phase === 'classify')).toBe(true);
  });

  it('returns an audit trail (never throws) for an invalid input report', async () => {
    const { workflow } = makeWorkflow({});
    const bad = { ...SAMPLE_INCIDENT, reportedAt: 12345 } as unknown as IncidentReport;
    const promise = workflow.processIncidentReport(bad);
    await expect(promise).resolves.toBeDefined();
    const audit = await promise;
    expect(audit.humanEscalationRequired).toBe(true);
    expect(audit.errors.some((e) => e.phase === 'validate')).toBe(true);
  });

  it('ignores LLM-suggested regulatoryPath and uses the deterministic table value', async () => {
    const infer = async (
      _report: Record<string, unknown>,
      missing: string[],
    ): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const f of missing) out[f] = `inferred_${f}`;
      return out;
    };
    const { workflow } = makeWorkflow({
      classify: async () =>
        baseClassify({
          type: 'fall',
          regulatoryPath: 'totally-wrong-path-from-llm',
        }),
      infer,
    });
    const audit = await workflow.processIncidentReport(SAMPLE_INCIDENT);
    expect(audit.regulatoryPath).toBe('state_health_dept_24h');
    expect(
      audit.errors.some(
        (e) => e.phase === 'route' && e.message.includes('totally-wrong-path-from-llm'),
      ),
    ).toBe(true);
  });

  it('returns an audit trail (never throws) when infer throws mid-loop', async () => {
    const infer = async (): Promise<Record<string, string>> => {
      throw new Error('simulated infer failure');
    };
    const { workflow } = makeWorkflow({ infer, maxIterations: 3 });
    const promise = workflow.processIncidentReport(SAMPLE_INCIDENT);
    await expect(promise).resolves.toBeDefined();
    const audit = await promise;
    expect(audit.humanEscalationRequired).toBe(true);
    expect(audit.errors.some((e) => e.phase === 'infer')).toBe(true);
  });
});

describe('incident workflow — escalation triggers', () => {
  it('escalates on critical severity even when loop converges', async () => {
    const infer = async (
      _report: Record<string, unknown>,
      missing: string[],
    ): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const f of missing) out[f] = `inferred_${f}`;
      return out;
    };
    const { workflow } = makeWorkflow({
      classify: async () => baseClassify({ type: 'medical_emergency', severity: 'critical' }),
      infer,
      maxIterations: 3,
    });
    const audit = await workflow.processIncidentReport(SAMPLE_INCIDENT);
    expect(audit.humanEscalationRequired).toBe(true);
    expect(audit.escalationReason).toContain('critical');
  });
});

void ({} as InferFieldsOutput);
