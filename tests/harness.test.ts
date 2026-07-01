import {
  APIConnectionError,
  APIConnectionTimeoutError,
  BadRequestError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FakeAnthropicClient } from '../src/demo/fakes.js';
import { CircuitBreaker } from '../src/harness/circuit-breaker.js';
import { type LLMHarness, createHarness } from '../src/harness/index.js';
import {
  classifyError,
  computeBackoffMs,
  extractRetryAfterMs,
  isRetryable,
} from '../src/harness/retry.js';

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

let harness: LLMHarness;
let fake: FakeAnthropicClient;

beforeEach(() => {
  fake = new FakeAnthropicClient({ behavior: { kind: 'success', content: 'ok' } });
  harness = createHarness({
    client: fake,
    maxAttempts: 3,
    baseBackoffMs: 10,
    jitterMs: 0,
    sleep: noopSleep,
    now: noopNow,
    circuitFailureThreshold: 100,
  });
});

afterEach(() => {
  fake.reset();
});

describe('harness.call — happy path', () => {
  it('returns ok on first call', async () => {
    const result = await harness.call({
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(result.status).toBe('ok');
    expect(result.attempts).toBe(1);
    expect(result.content).toBe('ok');
    expect(result.requestId).toMatch(/^req_fake_/);
    expect(result.fallback).toBe(false);
    expect(fake.callCount$).toBe(1);
  });

  it('validates output against the provided Zod schema', async () => {
    const schema = z.object({ name: z.string(), n: z.number() });
    const goodFake = new FakeAnthropicClient({
      behavior: { kind: 'success', content: { name: 'X', n: 1 } },
    });
    const h = createHarness({ client: goodFake, maxAttempts: 1, sleep: noopSleep, now: noopNow });
    const result = await h.call<{ name: string; n: number }>(
      { systemPrompt: 's', userPrompt: 'u' },
      schema,
    );
    expect(result.status).toBe('ok');
    expect(result.parsedContent).toEqual({ name: 'X', n: 1 });
  });

  it('rejects invalid input via the Zod schema and returns failed (no throw, no LLM call)', async () => {
    const result = await harness.call({
      systemPrompt: '',
      userPrompt: 'u',
    });
    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(0);
    expect(fake.callCount$).toBe(0);
    expect(result.error?.kind).toBe('validation');
  });
});

describe('harness.call — retry policy', () => {
  it('retries on rate-limit (429) and succeeds on the second attempt', async () => {
    fake = new FakeAnthropicClient({
      behavior: {
        kind: 'rate_limit_once',
        retryAfterSeconds: 0,
        after: { kind: 'success', content: 'recovered' },
      },
    });
    harness = createHarness({
      client: fake,
      maxAttempts: 3,
      baseBackoffMs: 5,
      jitterMs: 0,
      sleep: noopSleep,
      now: noopNow,
    });
    const result = await harness.call({ systemPrompt: 's', userPrompt: 'u' });
    expect(result.status).toBe('ok');
    expect(result.attempts).toBe(2);
    expect(result.content).toBe('recovered');
  });

  it('returns degraded (not throw) on timeout', async () => {
    fake = new FakeAnthropicClient({ behavior: { kind: 'timeout_always' } });
    harness = createHarness({
      client: fake,
      maxAttempts: 2,
      baseBackoffMs: 1,
      jitterMs: 0,
      sleep: noopSleep,
      now: noopNow,
    });
    const result = await harness.call({ systemPrompt: 's', userPrompt: 'u' });
    expect(result.status).toBe('degraded');
    expect(result.fallback).toBe(true);
    expect(result.error?.kind).toBe('timeout');
  });

  it('harness-owned timeout fires when the client hangs (proves the race, not just error classification)', async () => {
    fake = new FakeAnthropicClient({ behavior: { kind: 'hang' } });
    const sleepCalls: number[] = [];
    const sleepSpy = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
    harness = createHarness({
      client: fake,
      maxAttempts: 1,
      sleep: sleepSpy,
      now: noopNow,
    });
    const start = Date.now();
    const result = await harness.call({
      systemPrompt: 's',
      userPrompt: 'u',
      timeoutMs: 50,
    });
    const elapsed = Date.now() - start;
    expect(result.status).toBe('degraded');
    expect(result.error?.kind).toBe('timeout');
    // The harness timed out within a small multiple of the configured timeout — not the SDK default (10s).
    expect(elapsed).toBeLessThan(2000);
  });

  it('does NOT retry on non-retryable 400 (BadRequestError)', async () => {
    fake = new FakeAnthropicClient({ behavior: { kind: 'bad_request_always', message: 'bad' } });
    harness = createHarness({
      client: fake,
      maxAttempts: 5,
      baseBackoffMs: 1,
      jitterMs: 0,
      sleep: noopSleep,
      now: noopNow,
    });
    const result = await harness.call({ systemPrompt: 's', userPrompt: 'u' });
    expect(result.attempts).toBe(1);
    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('validation');
  });

  it('returns failed (not throw) when all attempts fail with non-degradable error', async () => {
    fake = new FakeAnthropicClient({ behavior: { kind: 'bad_request_always', message: 'no' } });
    harness = createHarness({
      client: fake,
      maxAttempts: 1,
      baseBackoffMs: 1,
      jitterMs: 0,
      sleep: noopSleep,
      now: noopNow,
    });
    const result = await harness.call({ systemPrompt: 's', userPrompt: 'u' });
    expect(result.status).toBe('failed');
    expect(result.fallback).toBe(false);
  });
});

describe('redaction in the harness log payload', () => {
  it('redacts sensitive fields from the prompt payload logged on success', async () => {
    const captured: Array<{ obj: unknown; msg: unknown }> = [];
    const makeLogger = (): unknown => {
      const log: Record<string, unknown> = {};
      const handler = function (this: unknown, obj: unknown, msg?: unknown) {
        captured.push({ obj, msg });
      };
      log.info = handler;
      log.warn = handler;
      log.error = handler;
      log.debug = handler;
      log.child = () => log;
      return log;
    };
    const fakeLogger = makeLogger();
    const successFake = new FakeAnthropicClient({ behavior: { kind: 'success', content: 'safe' } });
    const h = createHarness({
      client: successFake,
      maxAttempts: 1,
      sleep: noopSleep,
      now: noopNow,
      logger: fakeLogger as never,
    });
    await h.call({
      systemPrompt: 's',
      userPrompt: JSON.stringify({ ssn: '123-45-6789', name: 'Margaret' }),
      sensitiveFields: ['ssn'],
      logContent: true,
    });
    const successLog = captured.find((c) => c.msg === 'llm_call_success');
    expect(successLog).toBeDefined();
    const obj = successLog?.obj as { sensitive: { prompt: string; output: string } };
    expect(obj.sensitive.prompt).not.toContain('123-45-6789');
    expect(obj.sensitive.prompt).toContain('[REDACTED]');
  });

  it('redacts free-text PHI in colon-separated "Field: value" patterns (not just JSON)', async () => {
    const captured: Array<{ obj: unknown; msg: unknown }> = [];
    const makeLogger = (): unknown => {
      const log: Record<string, unknown> = {};
      const handler = function (this: unknown, obj: unknown, msg?: unknown) {
        captured.push({ obj, msg });
      };
      log.info = handler;
      log.warn = handler;
      log.error = handler;
      log.debug = handler;
      log.child = () => log;
      return log;
    };
    const fakeLogger = makeLogger();
    const successFake = new FakeAnthropicClient({ behavior: { kind: 'success', content: 'safe' } });
    const h = createHarness({
      client: successFake,
      maxAttempts: 1,
      sleep: noopSleep,
      now: noopNow,
      logger: fakeLogger as never,
    });
    // Simulate a real free-text medical-history prompt with PHI in colon-separated form
    // AND a fenced triple-quote block (Raw clinical notes) that exercises the block-redaction layer.
    const prompt = [
      'Resident: Margaret Thompson',
      'Date of birth: 1947-03-12',
      'SSN: 123-45-6789',
      'Phone: +1-415-555-0142',
      'Email: sarah.thompson@example.com',
      'Admission date: 2026-06-20',
      '',
      'Raw clinical notes:',
      '"""',
      '78-year-old female with hypertension. Allergic to penicillin. HbA1c 7.1.',
      '"""',
    ].join('\n');
    await h.call({
      systemPrompt: 's',
      userPrompt: prompt,
      sensitiveFields: ['residentName', 'dateOfBirth', 'ssn', 'phone', 'email', 'rawClinicalNotes'],
      logContent: true,
    });
    const successLog = captured.find((c) => c.msg === 'llm_call_success');
    const obj = successLog?.obj as { sensitive: { prompt: string; output: string } };
    // No real PHI value should remain in the logged prompt.
    expect(obj.sensitive.prompt).not.toContain('Margaret Thompson');
    expect(obj.sensitive.prompt).not.toContain('1947-03-12');
    expect(obj.sensitive.prompt).not.toContain('123-45-6789');
    expect(obj.sensitive.prompt).not.toContain('+1-415-555-0142');
    expect(obj.sensitive.prompt).not.toContain('sarah.thompson@example.com');
    // Block redaction must catch the multi-line Raw clinical notes narrative.
    expect(obj.sensitive.prompt).not.toContain('78-year-old');
    expect(obj.sensitive.prompt).not.toContain('hypertension');
    expect(obj.sensitive.prompt).not.toContain('Penicillin');
    // Redaction markers should be present (field-name redaction, layer 2/3).
    expect(obj.sensitive.prompt).toMatch(/Resident:\s*\[REDACTED\]/);
    expect(obj.sensitive.prompt).toMatch(/Date of birth:\s*\[REDACTED\]/);
    expect(obj.sensitive.prompt).toMatch(/Phone:\s*\[REDACTED\]/);
    expect(obj.sensitive.prompt).toMatch(/Email:\s*\[REDACTED\]/);
    expect(obj.sensitive.prompt).toMatch(/SSN:\s*\[REDACTED\]/);
  });

  it('layer 3: PHI format patterns redact even when field name is not in sensitiveFields (defense in depth)', async () => {
    const captured: Array<{ obj: unknown; msg: unknown }> = [];
    const makeLogger = (): unknown => {
      const log: Record<string, unknown> = {};
      const handler = function (this: unknown, obj: unknown, msg?: unknown) {
        captured.push({ obj, msg });
      };
      log.info = handler;
      log.warn = handler;
      log.error = handler;
      log.debug = handler;
      log.child = () => log;
      return log;
    };
    const fakeLogger = makeLogger();
    const successFake = new FakeAnthropicClient({ behavior: { kind: 'success', content: 'safe' } });
    const h = createHarness({
      client: successFake,
      maxAttempts: 1,
      sleep: noopSleep,
      now: noopNow,
      logger: fakeLogger as never,
    });
    // Deliberately do NOT pass any sensitiveFields — layer 3 must still catch PHI formats.
    const prompt = 'Contact: 123-45-6789 or call +1-415-555-0142 or email x@y.com on 2026-06-25.';
    await h.call({ systemPrompt: 's', userPrompt: prompt, logContent: true });
    const successLog = captured.find((c) => c.msg === 'llm_call_success');
    const obj = successLog?.obj as { sensitive: { prompt: string; output: string } };
    expect(obj.sensitive.prompt).toContain('[REDACTED-SSN]');
    expect(obj.sensitive.prompt).toContain('[REDACTED-PHONE]');
    expect(obj.sensitive.prompt).toContain('[REDACTED-EMAIL]');
    expect(obj.sensitive.prompt).toContain('[REDACTED-DATE]');
  });

  it('DEFAULT: log payload contains NO prompt or output content (metadata-only)', async () => {
    const captured: Array<{ obj: unknown; msg: unknown }> = [];
    const makeLogger = (): unknown => {
      const log: Record<string, unknown> = {};
      const handler = function (this: unknown, obj: unknown, msg?: unknown) {
        captured.push({ obj, msg });
      };
      log.info = handler;
      log.warn = handler;
      log.error = handler;
      log.debug = handler;
      log.child = () => log;
      return log;
    };
    const fakeLogger = makeLogger();
    const successFake = new FakeAnthropicClient({ behavior: { kind: 'success', content: 'safe' } });
    const h = createHarness({
      client: successFake,
      maxAttempts: 1,
      sleep: noopSleep,
      now: noopNow,
      logger: fakeLogger as never,
    });
    await h.call({ systemPrompt: 's', userPrompt: 'sensitive thing' });
    const successLog = captured.find((c) => c.msg === 'llm_call_success');
    const obj = successLog?.obj as Record<string, unknown>;
    expect(obj).toBeDefined();
    expect(obj).not.toHaveProperty('sensitive');
    expect(obj).not.toHaveProperty('prompt');
    expect(obj).not.toHaveProperty('output');
  });

  it('DEFAULT: log payload contains NO clinical narrative even when a medical prompt is sent', async () => {
    const captured: Array<{ obj: unknown; msg: unknown }> = [];
    const makeLogger = (): unknown => {
      const log: Record<string, unknown> = {};
      const handler = function (this: unknown, obj: unknown) {
        captured.push({ obj, msg: 'llm_call_success' });
      };
      log.info = handler;
      log.warn = handler;
      log.error = handler;
      log.debug = handler;
      log.child = () => log;
      return log;
    };
    const fakeLogger = makeLogger();
    const successFake = new FakeAnthropicClient({ behavior: { kind: 'success', content: 'safe' } });
    const h = createHarness({
      client: successFake,
      maxAttempts: 1,
      sleep: noopSleep,
      now: noopNow,
      logger: fakeLogger as never,
    });
    const prompt = [
      'Resident: Margaret Thompson',
      'Date of birth: 1947-03-12',
      '',
      'Raw clinical notes:',
      '"""',
      '78-year-old female with hypertension, type 2 diabetes, on lisinopril and metformin.',
      'Allergic to penicillin. HbA1c 7.1.',
      '"""',
    ].join('\n');
    await h.call({ systemPrompt: 's', userPrompt: prompt });
    const json = captured.map((c) => JSON.stringify(c.obj)).join('\n');
    expect(json).not.toContain('Margaret Thompson');
    expect(json).not.toContain('1947-03-12');
    expect(json).not.toContain('78-year-old');
    expect(json).not.toContain('hypertension');
    expect(json).not.toContain('lisinopril');
    expect(json).not.toContain('metformin');
    expect(json).not.toContain('penicillin');
    expect(json).not.toContain('HbA1c');
  });

  it('logContent:true: output JSON arrays are redacted via the object-tree walk (not just regex)', async () => {
    const captured: Array<{ obj: unknown; msg: unknown }> = [];
    const makeLogger = (): unknown => {
      const log: Record<string, unknown> = {};
      const handler = function (this: unknown, obj: unknown, msg?: unknown) {
        captured.push({ obj, msg });
      };
      log.info = handler;
      log.warn = handler;
      log.error = handler;
      log.debug = handler;
      log.child = () => log;
      return log;
    };
    const fakeLogger = makeLogger();
    const outputJson = {
      summary: 'Elderly with HTN, T2DM.',
      conditions: ['Hypertension', 'Type 2 Diabetes'],
      medications: ['Lisinopril 10mg', 'Metformin 500mg'],
      allergies: ['Penicillin'],
      riskLevel: 'medium',
      flaggedConcerns: [],
    };
    const successFake = new FakeAnthropicClient({
      behavior: { kind: 'success', content: JSON.stringify(outputJson) },
    });
    const h = createHarness({
      client: successFake,
      maxAttempts: 1,
      sleep: noopSleep,
      now: noopNow,
      logger: fakeLogger as never,
    });
    await h.call({
      systemPrompt: 's',
      userPrompt: 'synthesize a summary',
      sensitiveFields: ['conditions', 'medications', 'allergies', 'summary'],
      logContent: true,
    });
    const successLog = captured.find((c) => c.msg === 'llm_call_success');
    const obj = successLog?.obj as { sensitive: { output: string } };
    // Array values must be redacted (not regex-only — the object tree is walked).
    expect(obj.sensitive.output).not.toContain('Hypertension');
    expect(obj.sensitive.output).not.toContain('Type 2 Diabetes');
    expect(obj.sensitive.output).not.toContain('Lisinopril 10mg');
    expect(obj.sensitive.output).not.toContain('Metformin 500mg');
    expect(obj.sensitive.output).not.toContain('Penicillin');
    // Non-sensitive fields survive.
    expect(obj.sensitive.output).toContain('medium');
  });

  it('logContent:true: raw clinical notes block is fully redacted (multi-line)', async () => {
    const captured: Array<{ obj: unknown; msg: unknown }> = [];
    const makeLogger = (): unknown => {
      const log: Record<string, unknown> = {};
      const handler = function (this: unknown, obj: unknown, msg?: unknown) {
        captured.push({ obj, msg });
      };
      log.info = handler;
      log.warn = handler;
      log.error = handler;
      log.debug = handler;
      log.child = () => log;
      return log;
    };
    const fakeLogger = makeLogger();
    const successFake = new FakeAnthropicClient({ behavior: { kind: 'success', content: 'safe' } });
    const h = createHarness({
      client: successFake,
      maxAttempts: 1,
      sleep: noopSleep,
      now: noopNow,
      logger: fakeLogger as never,
    });
    const prompt = [
      'Resident: Margaret Thompson',
      '',
      'Raw clinical notes:',
      '"""',
      '78-year-old female with hypertension.',
      'Type 2 diabetes, on lisinopril and metformin.',
      'Allergic to penicillin. HbA1c 7.1.',
      'Family reports sundowning.',
      '"""',
    ].join('\n');
    await h.call({
      systemPrompt: 's',
      userPrompt: prompt,
      sensitiveFields: ['residentName', 'rawClinicalNotes'],
      logContent: true,
    });
    const obj = captured.find((c) => c.msg === 'llm_call_success')?.obj as {
      sensitive: { prompt: string };
    };
    // Multi-line block must be redacted entirely.
    expect(obj.sensitive.prompt).toContain('[REDACTED-BLOCK]');
    expect(obj.sensitive.prompt).not.toContain('78-year-old');
    expect(obj.sensitive.prompt).not.toContain('hypertension');
    expect(obj.sensitive.prompt).not.toContain('lisinopril');
    expect(obj.sensitive.prompt).not.toContain('sundowning');
  });
});

describe('harness.call — circuit breaker', () => {
  it('opens after threshold consecutive failures and short-circuits subsequent calls', async () => {
    fake = new FakeAnthropicClient({ behavior: { kind: 'timeout_always' } });
    const h = createHarness({
      client: fake,
      maxAttempts: 1,
      baseBackoffMs: 1,
      jitterMs: 0,
      sleep: noopSleep,
      now: noopNow,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 60_000,
    });
    expect(h.getCircuitState()).toBe('closed');
    const r1 = await h.call({ systemPrompt: 's', userPrompt: 'u' });
    const r2 = await h.call({ systemPrompt: 's', userPrompt: 'u' });
    expect(r1.status).toBe('degraded');
    expect(r2.status).toBe('degraded');
    expect(h.getCircuitState()).toBe('open');
    const r3 = await h.call({ systemPrompt: 's', userPrompt: 'u' });
    expect(r3.error?.kind).toBe('circuit_open');
    expect(r3.attempts).toBe(0);
  });
});

describe('retry helpers', () => {
  it('classifies errors correctly', () => {
    expect(classifyError(new RateLimitError(429, undefined, 'x', {}))).toBe('rate_limit');
    expect(classifyError(new APIConnectionTimeoutError({ message: 'x' }))).toBe('timeout');
    expect(classifyError(new APIConnectionError({ message: 'x' }))).toBe('connection');
    expect(classifyError(new BadRequestError(400, undefined, 'x', {}))).toBe('validation');
  });

  it('isRetryable returns true for 429/timeout/connection/server/conflict', () => {
    expect(isRetryable('rate_limit')).toBe(true);
    expect(isRetryable('timeout')).toBe(true);
    expect(isRetryable('connection')).toBe(true);
    expect(isRetryable('server')).toBe(true);
    expect(isRetryable('conflict')).toBe(true);
    expect(isRetryable('auth')).toBe(false);
    expect(isRetryable('validation')).toBe(false);
    expect(isRetryable('not_found')).toBe(false);
  });

  it('computeBackoffMs applies exponential growth and jitter, capped at max', () => {
    const r0 = computeBackoffMs({
      attempt: 0,
      baseMs: 100,
      maxMs: 10_000,
      jitterMs: 0,
      random: () => 0,
    });
    const r1 = computeBackoffMs({
      attempt: 1,
      baseMs: 100,
      maxMs: 10_000,
      jitterMs: 0,
      random: () => 0,
    });
    const r2 = computeBackoffMs({
      attempt: 2,
      baseMs: 100,
      maxMs: 10_000,
      jitterMs: 0,
      random: () => 0,
    });
    const capped = computeBackoffMs({
      attempt: 20,
      baseMs: 100,
      maxMs: 5_000,
      jitterMs: 0,
      random: () => 0,
    });
    expect(r0).toBe(100);
    expect(r1).toBe(200);
    expect(r2).toBe(400);
    expect(capped).toBeLessThanOrEqual(5_000);
  });

  it('extractRetryAfterMs honors Retry-After header in seconds', () => {
    const err = new RateLimitError(429, undefined, 'x', { 'retry-after': '7' });
    expect(extractRetryAfterMs(err, 999)).toBe(7_000);
  });

  it('extractRetryAfterMs falls back to default when no header', () => {
    const err = new RateLimitError(429, undefined, 'x', {});
    expect(extractRetryAfterMs(err, 1_234)).toBe(1_234);
  });
});

describe('circuit breaker', () => {
  it('transitions closed → open → half_open → closed on probe success', () => {
    let now = 1_000_000;
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: () => now });
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    now += 50;
    expect(cb.getState()).toBe('open');
    now += 60;
    expect(cb.getState()).toBe('half_open');
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('half_open → open on probe failure', () => {
    let now = 1_000_000;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => now });
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    now += 200;
    expect(cb.getState()).toBe('half_open');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });
});

describe('createRealClient — SDK retry disabled', () => {
  it('the Anthropic SDK accepts and exposes maxRetries: 0 (proves the contract createRealClient relies on)', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const probe = new Anthropic({ apiKey: 'test-key', maxRetries: 0 });
    expect(probe.maxRetries).toBe(0);
  });

  it('createRealClient constructs without error and returns a HarnessClient', async () => {
    const { createRealClient } = await import('../src/harness/client.js');
    const real = createRealClient({ apiKey: 'test-key' });
    expect(real).toBeDefined();
    expect(typeof real.messages.create).toBe('function');
  });
});
