import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AnthropicError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from '@anthropic-ai/sdk';

export type RetryableErrorKind =
  | 'rate_limit'
  | 'timeout'
  | 'connection'
  | 'server'
  | 'conflict'
  | 'validation'
  | 'auth'
  | 'not_found'
  | 'forbidden'
  | 'unprocessable'
  | 'abort'
  | 'unknown';

export function classifyError(error: unknown): RetryableErrorKind {
  if (error instanceof RateLimitError) return 'rate_limit';
  if (error instanceof APIConnectionTimeoutError) return 'timeout';
  if (error instanceof APIConnectionError) return 'connection';
  if (error instanceof APIUserAbortError) return 'abort';
  if (error instanceof InternalServerError) return 'server';
  if (error instanceof BadRequestError) return 'validation';
  if (error instanceof AuthenticationError) return 'auth';
  if (error instanceof PermissionDeniedError) return 'forbidden';
  if (error instanceof NotFoundError) return 'not_found';
  if (error instanceof UnprocessableEntityError) return 'unprocessable';
  if (error instanceof AnthropicError) {
    const status = (error as AnthropicError & { status?: number }).status;
    if (status === 429) return 'rate_limit';
    if (status === 408 || status === 499) return 'timeout';
    if (status === 409) return 'conflict';
    if (status && status >= 500) return 'server';
    return 'unknown';
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') return 'connection';
    if (error.message.toLowerCase().includes('timeout')) return 'timeout';
    if (error.message.toLowerCase().includes('fetch failed')) return 'connection';
  }
  return 'unknown';
}

export function isRetryable(kind: RetryableErrorKind): boolean {
  return (
    kind === 'rate_limit' ||
    kind === 'timeout' ||
    kind === 'connection' ||
    kind === 'server' ||
    kind === 'conflict'
  );
}

export function getStatusCode(error: unknown): number | undefined {
  if (error instanceof AnthropicError) {
    return (error as AnthropicError & { status?: number }).status;
  }
  return undefined;
}

export function extractRetryAfterMs(error: unknown, defaultMs: number): number {
  const fromHeader = getRetryAfterFromHeader(error);
  if (fromHeader !== null) return fromHeader;
  return defaultMs;
}

function getRetryAfterFromHeader(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as {
    headers?: Headers | Record<string, string | string[] | undefined>;
    response?: { headers?: Headers | Record<string, string | string[] | undefined> };
  };
  const sources = [candidate.headers, candidate.response?.headers].filter(Boolean) as Array<
    Headers | Record<string, string | string[] | undefined>
  >;
  for (const source of sources) {
    const raw = readHeader(source, 'retry-after');
    if (raw) {
      const asSeconds = Number.parseFloat(raw);
      if (!Number.isNaN(asSeconds)) return Math.round(asSeconds * 1000);
      const asDate = Date.parse(raw);
      if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
    }
  }
  return null;
}

function readHeader(
  source: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  if (typeof (source as Headers).get === 'function') {
    return (source as Headers).get(name) ?? undefined;
  }
  const lowered = name.toLowerCase();
  for (const [k, v] of Object.entries(source as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === lowered) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

export interface BackoffOptions {
  attempt: number;
  baseMs: number;
  maxMs: number;
  jitterMs: number;
  random?: () => number;
}

export function computeBackoffMs(options: BackoffOptions): number {
  const { attempt, baseMs, maxMs, jitterMs } = options;
  const random = options.random ?? Math.random;
  const exp = baseMs * 2 ** attempt;
  const jitter = Math.floor(random() * jitterMs);
  return Math.min(maxMs, exp + jitter);
}
