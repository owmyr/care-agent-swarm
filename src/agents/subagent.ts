import type { ZodSchema } from 'zod';
import type { HarnessResult, LLMHarness } from '../harness/index.js';

export interface SubAgent<TIn, TOut> {
  readonly name: string;
  readonly sensitiveFields?: string[];
  readonly systemPrompt: string;
  process(input: TIn): Promise<HarnessResult<TOut>>;
}

export function buildSubAgent<TIn, TOut>(args: {
  name: string;
  systemPrompt: string;
  userPrompt: (input: TIn) => string;
  outputSchema: ZodSchema<TOut>;
  sensitiveFields?: string[];
  harness: LLMHarness;
  temperature?: number;
  maxTokens?: number;
  fallbackOutput?: () => TOut;
}): SubAgent<TIn, TOut> {
  return {
    name: args.name,
    systemPrompt: args.systemPrompt,
    sensitiveFields: args.sensitiveFields,
    async process(input: TIn): Promise<HarnessResult<TOut>> {
      const result = await args.harness.call<TOut>(
        {
          systemPrompt: args.systemPrompt,
          userPrompt: args.userPrompt(input),
          temperature: args.temperature ?? 0.2,
          maxTokens: args.maxTokens ?? 1024,
          sensitiveFields: args.sensitiveFields,
          outputJson: true,
        },
        args.outputSchema,
      );
      if (result.status !== 'ok' && args.fallbackOutput) {
        const fallback = args.fallbackOutput();
        return { ...result, status: 'degraded', parsedContent: fallback, fallback: true };
      }
      return result;
    },
  };
}
