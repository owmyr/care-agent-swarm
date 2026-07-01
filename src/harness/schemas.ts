import { z } from 'zod';

export const HarnessStatusSchema = z.enum(['ok', 'degraded', 'failed']);
export type HarnessStatus = z.infer<typeof HarnessStatusSchema>;

export const HarnessErrorKindSchema = z.enum([
  'rate_limit',
  'timeout',
  'server',
  'validation',
  'output_validation',
  'circuit_open',
  'connection',
  'auth',
  'forbidden',
  'not_found',
  'unprocessable',
  'conflict',
  'abort',
  'unknown',
]);
export type HarnessErrorKind = z.infer<typeof HarnessErrorKindSchema>;

export const HarnessErrorSchema = z.object({
  kind: HarnessErrorKindSchema,
  message: z.string(),
  statusCode: z.number().optional(),
  retryable: z.boolean().optional(),
});
export type HarnessError = z.infer<typeof HarnessErrorSchema>;

export const HarnessCallOptionsSchema = z.object({
  systemPrompt: z.string().min(1),
  userPrompt: z.string().min(1),
  model: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  temperature: z.number().min(0).max(1).optional(),
  sensitiveFields: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  outputJson: z.boolean().optional(),
  logContent: z.boolean().optional(),
});
export type HarnessCallOptions = z.infer<typeof HarnessCallOptionsSchema>;

export const HarnessResultSchema = z.object({
  status: HarnessStatusSchema,
  content: z.string(),
  parsedContent: z.unknown().optional(),
  attempts: z.number().int().min(0),
  durationMs: z.number().min(0),
  fallback: z.boolean(),
  error: HarnessErrorSchema.optional(),
  requestId: z.string().optional(),
  traceId: z.string(),
  model: z.string().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
});
export type HarnessResult<T = unknown> = Omit<
  z.infer<typeof HarnessResultSchema>,
  'parsedContent'
> & {
  parsedContent?: T;
};

export const HARNESS_SCHEMA_VERSION = 1;
