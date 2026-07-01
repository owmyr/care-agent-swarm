import Anthropic from '@anthropic-ai/sdk';

export interface HarnessCreateArgs {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
}

export interface HarnessClient {
  messages: {
    create: (args: HarnessCreateArgs) => Promise<HarnessMessageResponse>;
  };
}

export interface HarnessMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
  _request_id?: string;
}

export interface CreateClientOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

export function createRealClient(options: CreateClientOptions): HarnessClient {
  const client = new Anthropic({
    apiKey: options.apiKey,
    timeout: options.timeoutMs ?? 20_000,
    maxRetries: 0,
  });
  return {
    messages: {
      create: async (args) => {
        const res = await client.messages.create(
          args as unknown as Parameters<typeof client.messages.create>[0],
        );
        return res as unknown as HarnessMessageResponse;
      },
    },
  };
}

export function isClientAvailable(apiKey: string | undefined): boolean {
  return Boolean(apiKey && apiKey.length > 0);
}
