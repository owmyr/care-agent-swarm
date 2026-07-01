import { createHash, randomUUID } from 'node:crypto';
import type { ZodSchema } from 'zod';
import {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
} from './circuit-breaker.js';
import { type HarnessClient, createRealClient, isClientAvailable } from './client.js';
import { type Logger, defaultLogger } from './logger.js';
import {
  classifyError,
  computeBackoffMs,
  extractRetryAfterMs,
  getStatusCode,
  isRetryable,
} from './retry.js';
import {
  type HarnessCallOptions,
  HarnessCallOptionsSchema,
  type HarnessError,
  type HarnessResult,
  HarnessResultSchema,
} from './schemas.js';

export interface LLMHarnessConfig {
  apiKey?: string;
  model: string;
  maxAttempts: number;
  timeoutMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  jitterMs: number;
  circuitBreaker: CircuitBreakerOptions;
}

export interface LLMHarnessDeps {
  client: HarnessClient;
  logger: Logger;
  config: LLMHarnessConfig;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  circuitBreaker: CircuitBreaker;
}

export interface CreateHarnessOptions {
  apiKey?: string;
  model?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterMs?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  client?: HarnessClient;
  logger?: Logger;
  logLevel?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createHarness(options: CreateHarnessOptions = {}): LLMHarness {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const client =
    options.client ??
    (isClientAvailable(apiKey)
      ? createRealClient({ apiKey, timeoutMs: options.timeoutMs })
      : undefined);
  if (!client) {
    throw new Error(
      'LLMHarness requires a client. Provide `client` in options or set ANTHROPIC_API_KEY (or wire FakeAnthropicClient for demo mode).',
    );
  }
  const config: LLMHarnessConfig = {
    apiKey,
    model: options.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
    maxAttempts:
      options.maxAttempts ?? Number.parseInt(process.env.HARNESS_MAX_ATTEMPTS ?? '3', 10),
    timeoutMs: options.timeoutMs ?? Number.parseInt(process.env.HARNESS_TIMEOUT_MS ?? '20000', 10),
    baseBackoffMs:
      options.baseBackoffMs ?? Number.parseInt(process.env.HARNESS_BASE_BACKOFF_MS ?? '500', 10),
    maxBackoffMs:
      options.maxBackoffMs ?? Number.parseInt(process.env.HARNESS_MAX_BACKOFF_MS ?? '30000', 10),
    jitterMs: options.jitterMs ?? Number.parseInt(process.env.HARNESS_JITTER_MS ?? '1000', 10),
    circuitBreaker: {
      failureThreshold:
        options.circuitFailureThreshold ??
        Number.parseInt(process.env.CIRCUIT_FAILURE_THRESHOLD ?? '5', 10),
      cooldownMs:
        options.circuitCooldownMs ??
        Number.parseInt(process.env.CIRCUIT_COOLDOWN_MS ?? '30000', 10),
    },
  };
  const logger = options.logger ?? defaultLogger(options.logLevel);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const circuitBreaker = new CircuitBreaker({
    failureThreshold: config.circuitBreaker.failureThreshold,
    cooldownMs: config.circuitBreaker.cooldownMs,
    now,
    onStateChange: (from, to) => logger.info({ from, to }, 'circuit_breaker_state_change'),
  });
  const deps: LLMHarnessDeps = { client, logger, config, sleep, now, circuitBreaker };
  return new LLMHarness(deps);
}

export class LLMHarness {
  constructor(private readonly deps: LLMHarnessDeps) {}

  getCircuitState(): CircuitState {
    return this.deps.circuitBreaker.getState();
  }

  resetCircuit(): void {
    this.deps.circuitBreaker.reset();
  }

  async call<T = unknown>(
    options: HarnessCallOptions,
    outputSchema?: ZodSchema<T>,
  ): Promise<HarnessResult<T>> {
    const traceId = randomUUID();
    const startedAt = this.deps.now();
    const inputParse = HarnessCallOptionsSchema.safeParse(options);
    if (!inputParse.success) {
      const msg = inputParse.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return this.buildResult({
        status: 'failed',
        content: '',
        attempts: 0,
        durationMs: this.deps.now() - startedAt,
        fallback: false,
        error: { kind: 'validation', message: `Invalid HarnessCallOptions: ${msg}` },
        traceId,
        model: options.model ?? this.deps.config.model,
      });
    }
    const validated = inputParse.data;
    const logContent =
      validated.logContent === true ||
      (validated.logContent === undefined && process.env.HARNESS_LOG_CONTENT === 'true');
    const log = this.deps.logger.child({
      traceId,
      model: validated.model ?? this.deps.config.model,
    });
    const sensitive = validated.sensitiveFields ?? [];

    if (!this.deps.circuitBreaker.canRequest()) {
      log.warn('circuit_open_short_circuit');
      return this.buildResult({
        status: 'failed',
        content: '',
        attempts: 0,
        durationMs: this.deps.now() - startedAt,
        fallback: false,
        error: { kind: 'circuit_open', message: 'Circuit breaker is open' },
        traceId,
        model: validated.model ?? this.deps.config.model,
      });
    }

    const maxAttempts = validated.maxAttempts ?? this.deps.config.maxAttempts;
    let lastError: HarnessError | undefined;
    let attempts = 0;
    let lastContent = '';
    let requestId: string | undefined;
    let model: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      attempts = attempt + 1;
      const attemptLog = log.child({ attempt });
      const timeoutMs = validated.timeoutMs ?? this.deps.config.timeoutMs;
      try {
        const res = await withHarnessTimeout(
          this.deps.client.messages.create({
            model: validated.model ?? this.deps.config.model,
            max_tokens: validated.maxTokens ?? 1024,
            system: validated.systemPrompt,
            messages: [{ role: 'user', content: validated.userPrompt }],
            temperature: validated.temperature,
          }),
          timeoutMs,
          attemptLog,
        );
        requestId = res._request_id;
        model = res.model;
        const text = extractText(res);
        inputTokens = res.usage?.input_tokens;
        outputTokens = res.usage?.output_tokens;
        lastContent = text;

        attemptLog.info(
          {
            requestId,
            durationMs: this.deps.now() - startedAt,
            inputTokens,
            outputTokens,
            hasOutputSchema: outputSchema !== undefined,
            promptHash: sha256Short(validated.userPrompt),
            ...(logContent
              ? {
                  sensitive: {
                    prompt: redactStringValue(validated.userPrompt, sensitive),
                    output: redactOutputString(text, sensitive),
                  },
                }
              : {}),
          },
          'llm_call_success',
        );

        if (outputSchema) {
          const validation = validateOutput(text, outputSchema, attemptLog);
          if (validation.ok) {
            this.deps.circuitBreaker.recordSuccess();
            return this.buildResult({
              status: 'ok',
              content: text,
              parsedContent: validation.parsed,
              attempts,
              durationMs: this.deps.now() - startedAt,
              fallback: false,
              requestId,
              traceId,
              model,
              inputTokens,
              outputTokens,
            });
          }
          lastError = {
            kind: 'output_validation',
            message: validation.error,
            retryable: attempt < maxAttempts - 1,
          };
          attemptLog.warn({ error: lastError }, 'output_validation_failed');
          if (attempt < maxAttempts - 1) {
            await this.sleepWithBackoff(attempt, lastError, log);
            continue;
          }
          break;
        }

        this.deps.circuitBreaker.recordSuccess();
        return this.buildResult({
          status: 'ok',
          content: text,
          attempts,
          durationMs: this.deps.now() - startedAt,
          fallback: false,
          requestId,
          traceId,
          model,
          inputTokens,
          outputTokens,
        });
      } catch (error) {
        const kind = classifyError(error);
        const statusCode = getStatusCode(error);
        const retryable = isRetryable(kind);
        lastError = {
          kind,
          message: error instanceof Error ? error.message : String(error),
          statusCode,
          retryable,
        };
        attemptLog.warn({ error: lastError, statusCode, attempt }, 'llm_call_failed');
        if (
          kind === 'rate_limit' ||
          kind === 'timeout' ||
          kind === 'connection' ||
          kind === 'server' ||
          kind === 'conflict'
        ) {
          this.deps.circuitBreaker.recordFailure();
        }
        if (attempt < maxAttempts - 1 && retryable) {
          await this.sleepWithBackoff(attempt, error, log);
          continue;
        }
        break;
      }
    }

    const degraded = this.shouldDegrade(lastError);
    const status: HarnessResult['status'] = degraded ? 'degraded' : 'failed';
    log.warn({ error: lastError, attempts, status }, 'llm_call_exhausted');
    return this.buildResult({
      status,
      content: lastContent,
      attempts,
      durationMs: this.deps.now() - startedAt,
      fallback: degraded,
      error: lastError,
      requestId,
      traceId,
      model,
      inputTokens,
      outputTokens,
    });
  }

  private async sleepWithBackoff(attempt: number, error: unknown, log: Logger): Promise<void> {
    const retryAfterMs = extractRetryAfterMs(error, 0);
    let waitMs: number;
    if (retryAfterMs > 0) {
      waitMs = Math.min(retryAfterMs, this.deps.config.maxBackoffMs);
      log.info({ waitMs, source: 'retry_after_header' }, 'retry_backoff');
    } else {
      waitMs = computeBackoffMs({
        attempt,
        baseMs: this.deps.config.baseBackoffMs,
        maxMs: this.deps.config.maxBackoffMs,
        jitterMs: this.deps.config.jitterMs,
      });
      log.info({ waitMs, source: 'exponential_jitter' }, 'retry_backoff');
    }
    await this.deps.sleep(waitMs);
  }

  private shouldDegrade(error: HarnessError | undefined): boolean {
    if (!error) return true;
    return (
      error.kind === 'timeout' || error.kind === 'connection' || error.kind === 'output_validation'
    );
  }

  private buildResult<T>(input: {
    status: HarnessResult['status'];
    content: string;
    parsedContent?: T;
    attempts: number;
    durationMs: number;
    fallback: boolean;
    error?: HarnessError;
    requestId?: string;
    traceId: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
  }): HarnessResult<T> {
    const candidate = { ...input, parsedContent: input.parsedContent as unknown };
    return HarnessResultSchema.parse(candidate) as HarnessResult<T>;
  }
}

function extractText(res: { content: Array<{ type: string; text?: string }> }): string {
  const blocks = res.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(
      (b): b is { type: string; text: string } =>
        b && b.type === 'text' && typeof b.text === 'string',
    )
    .map((b) => b.text)
    .join('');
}

function validateOutput<T>(
  text: string,
  schema: ZodSchema<T>,
  log: Logger,
): { ok: true; parsed: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'json_parse_failed' };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    log.debug({ issues: result.error.issues }, 'output_schema_validation_failed');
    return { ok: false, error: result.error.message };
  }
  return { ok: true, parsed: result.data };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate: string = fenced && typeof fenced[1] === 'string' ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('no_json_in_response');
  }
}

function redactForLog(obj: unknown, sensitive: string[]): unknown {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'string') {
        return redactStringValue(value, sensitive);
      }
      return value;
    }
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);
    if (Array.isArray(value)) return value.map(visit);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (sensitive.some((f) => f.toLowerCase() === k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = visit(v);
      }
    }
    return out;
  };
  return visit(obj);
}

/**
 * Redact a string that may be JSON (e.g. an LLM output). If it parses as JSON,
 * walk the tree with redactForLog (handles nested arrays/objects correctly)
 * and re-stringify. Otherwise fall back to regex/string redaction.
 */
function redactOutputString(value: string, sensitive: string[]): string {
  const tryParseJson = (text: string): unknown | null => {
    const trimmed = text.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence && typeof fence[1] === 'string') {
        try {
          return JSON.parse(fence[1]);
        } catch {
          return null;
        }
      }
      return null;
    }
  };
  const parsed = tryParseJson(value);
  if (parsed !== null) {
    const redacted = redactForLog(parsed, sensitive);
    try {
      return JSON.stringify(redacted);
    } catch {
      return redactStringValue(value, sensitive);
    }
  }
  return redactStringValue(value, sensitive);
}

function redactStringValue(value: string, sensitive: string[]): string {
  let out = value;
  // Layer 1: JSON-style "field": "value" patterns (existing).
  for (const field of sensitive) {
    const re = new RegExp(`("${field}"\\s*:\\s*)"[^"]*"`, 'gi');
    out = out.replace(re, `$1"[REDACTED]"`);
  }
  // Layer 2: Fenced blocks (""" ... """ and ``` ... ```). Catches multi-line free-text
  // payloads like the "Raw clinical notes" block where the value spans many lines and
  // a colon-pattern regex would only catch the label line, not the narrative body.
  out = out.replace(/"""\n[\s\S]*?\n"""/g, '[REDACTED-BLOCK]');
  out = out.replace(/```\n[\s\S]*?\n```/g, '[REDACTED-BLOCK]');
  // Layer 3: Colon-separated "Field name: value" patterns (new — catches free-text
  // prompts like "Date of birth: 1947-03-12" and "Resident: Margaret Thompson").
  // Field-name matching is case-insensitive and separator-flexible (space / underscore / camelCase).
  // The value class `[^[\n,;"]+` excludes `[` so we don't re-rewrite redaction markers
  // (e.g. the [REDACTED-BLOCK] produced by layer 2) as plain [REDACTED].
  for (const field of sensitive) {
    const variants = fieldNameVariants(field);
    for (const variant of variants) {
      const re = new RegExp(`(^|\\n|\\s)(${variant})\\s*[:=]\\s*([^\\[\\n,;"]+)`, 'gi');
      out = out.replace(re, (_match, lead, key, _val) => `${lead}${key}: [REDACTED]`);
    }
  }
  // Layer 4: Known PHI format patterns (always redact, regardless of field names).
  // SSN, US phone with optional country code, email, ISO-ish dates (YYYY-MM-DD).
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]');
  out = out.replace(/\b\+?\d{1,2}-\d{3}-\d{3}-\d{4}\b/g, '[REDACTED-PHONE]');
  out = out.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[REDACTED-EMAIL]');
  out = out.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '[REDACTED-DATE]');
  return out;
}

function fieldNameVariants(field: string): string[] {
  const lower = field.toLowerCase();
  // Split camelCase BEFORE lowercasing (e.g., "dateOfBirth" -> "date Of Birth" -> "date of birth").
  const camelSplit = field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const spaceSep = camelSplit.replace(/_/g, ' ');
  const noSpaces = lower.replace(/[_ ]/g, '');
  // Stem variants: strip "name" / "id" / "number" / "num" suffix so "residentName" matches "Resident".
  const stemSpace = spaceSep.replace(/(name|id|number|num)$/i, '').trim();
  const stemNoSpace = stemSpace.replace(/\s+/g, '');
  return [lower, camelSplit, spaceSep, noSpaces, stemSpace, stemNoSpace].filter(
    (v, i, arr) => v.length > 0 && arr.indexOf(v) === i,
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race an LLM call against a harness-owned timeout. Works for any HarnessClient
 * (real Anthropic or FakeAnthropicClient). The timeout is in addition to whatever
 * timeout the underlying client uses (real client uses SDK-native cancellation).
 */
async function withHarnessTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  log: Logger,
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Harness timeout after ${timeoutMs}ms`);
      (err as Error & { __harnessTimeout?: boolean }).__harnessTimeout = true;
      log.warn({ timeoutMs }, 'harness_timeout');
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sha256Short(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export { CircuitBreaker };
