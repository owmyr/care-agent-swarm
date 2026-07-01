import { APIConnectionTimeoutError, BadRequestError, RateLimitError } from '@anthropic-ai/sdk';
import type { HarnessClient, HarnessMessageResponse } from '../harness/index.js';

type SDKHeaders = Record<string, string | null | undefined>;

export type ScriptedBehavior =
  | { kind: 'rate_limit_once'; retryAfterSeconds: number; after?: ScriptedBehavior }
  | { kind: 'rate_limit_always'; retryAfterSeconds: number }
  | { kind: 'timeout_always' }
  | { kind: 'hang' }
  | { kind: 'bad_request_always'; message: string }
  | {
      kind: 'success';
      content: string | Record<string, unknown>;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      /**
       * Match on the system prompt's content and return a per-match response.
       * The first matching rule wins; if none match, `default` is returned.
       * This lets a single fake return JSON for sub-agent calls and prose
       * for the orchestrator's summary-synthesis call.
       */
      kind: 'scripted';
      rules: Array<{ matcher: RegExp; content: string | Record<string, unknown> }>;
      default: string | Record<string, unknown>;
    }
  | { kind: 'throw_for_subagent'; failingSubagents: string[]; otherwise: ScriptedBehavior };

export interface FakeAnthropicClientOptions {
  behavior: ScriptedBehavior;
  model?: string;
  requestIdPrefix?: string;
}

export class FakeAnthropicClient implements HarnessClient {
  private callCount = 0;
  private lastSystemPrompt = '';
  private readonly requestIdPrefix: string;

  constructor(private readonly options: FakeAnthropicClientOptions) {
    this.requestIdPrefix = options.requestIdPrefix ?? 'req_fake';
  }

  get callCount$(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
  }

  async messagesCreate(args: {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: string; content: string }>;
  }): Promise<HarnessMessageResponse> {
    this.callCount += 1;
    this.lastSystemPrompt = args.system;
    const behavior = this.resolveBehavior(args);
    return this.applyBehavior(behavior, args);
  }

  messages = {
    create: (args: unknown): Promise<HarnessMessageResponse> => {
      const a = args as Parameters<FakeAnthropicClient['messagesCreate']>[0];
      return this.messagesCreate(a);
    },
  };

  private resolveBehavior(
    args: Parameters<FakeAnthropicClient['messagesCreate']>[0],
  ): ScriptedBehavior {
    const b: ScriptedBehavior = this.options.behavior;
    if (b.kind === 'throw_for_subagent') {
      const sys = args.system.toLowerCase();
      for (const failing of b.failingSubagents) {
        if (sys.includes(failing.toLowerCase())) {
          return {
            kind: 'bad_request_always',
            message: `Simulated failure for sub-agent: ${failing}`,
          };
        }
      }
      return b.otherwise;
    }
    if (b.kind === 'rate_limit_once') {
      if (this.callCount === 1) return b;
      return b.after ?? { kind: 'success', content: 'ok' };
    }
    return b;
  }

  private applyBehavior(
    behavior: ScriptedBehavior,
    _args: Parameters<FakeAnthropicClient['messagesCreate']>[0],
  ): HarnessMessageResponse | Promise<HarnessMessageResponse> {
    switch (behavior.kind) {
      case 'rate_limit_once':
        throw new RateLimitError(
          429,
          undefined,
          'rate limited (simulated)',
          buildHeaders({ 'retry-after': String(behavior.retryAfterSeconds) }),
        );
      case 'rate_limit_always':
        throw new RateLimitError(
          429,
          undefined,
          'rate limited (simulated)',
          buildHeaders({ 'retry-after': String(behavior.retryAfterSeconds) }),
        );
      case 'timeout_always':
        throw new APIConnectionTimeoutError({
          message: 'request timeout (simulated)',
        });
      case 'hang':
        // Never resolves — proves the harness-owned timeout fires.
        return new Promise<HarnessMessageResponse>(() => {});
      case 'bad_request_always':
        throw new BadRequestError(400, undefined, behavior.message, buildHeaders({}));
      case 'success':
        return this.buildSuccess(behavior.content, behavior.inputTokens, behavior.outputTokens);
      case 'scripted': {
        for (const rule of behavior.rules) {
          if (rule.matcher.test(this.lastSystemPrompt)) {
            return this.buildSuccess(rule.content);
          }
        }
        return this.buildSuccess(behavior.default);
      }
      case 'throw_for_subagent':
        return this.buildSuccess('ok');
    }
  }

  private buildSuccess(
    content: string | Record<string, unknown>,
    inputTokens = 50,
    outputTokens = 100,
  ): HarnessMessageResponse {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    return {
      id: `msg_${Math.random().toString(36).slice(2, 10)}`,
      type: 'message',
      role: 'assistant',
      model: this.options.model ?? 'claude-sonnet-4-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      _request_id: `${this.requestIdPrefix}_${String(this.callCount).padStart(4, '0')}`,
    };
  }
}

function buildHeaders(headers: Record<string, string>): SDKHeaders {
  return headers;
}
