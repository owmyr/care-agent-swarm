import 'dotenv/config';
import { FakeAnthropicClient } from './demo/fakes.js';
import { type HarnessClient, createHarness, createRealClient } from './harness/index.js';
import { defaultLogger } from './harness/logger.js';

const demoMode = (process.env.DEMO_MODE ?? 'true').toLowerCase() !== 'false';
const apiKey = process.env.ANTHROPIC_API_KEY;
const logger = defaultLogger('info');

logger.info(
  {
    demoMode,
    hasApiKey: Boolean(apiKey),
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
  },
  'startup',
);

if (demoMode) {
  logger.info(
    'DEMO_MODE=true: harness will use FakeAnthropicClient for any client not explicitly provided.',
  );
} else if (!apiKey) {
  logger.error('DEMO_MODE=false but ANTHROPIC_API_KEY is not set. Exiting.');
  process.exit(1);
} else {
  logger.info('DEMO_MODE=false: harness will use the real Anthropic API.');
}

const client: HarnessClient = demoMode
  ? new FakeAnthropicClient({
      behavior: { kind: 'success', content: 'Hello from the smoke entry.' },
    })
  : createRealClient({ apiKey });

const harness = createHarness({ client, logLevel: 'info' });
const result = await harness.call({
  systemPrompt: 'You are a concise greeter.',
  userPrompt: 'Say hello in one short sentence.',
  maxTokens: 64,
  temperature: 0,
});

process.stdout.write(`${result.content}\n`);
if (result.status === 'failed' && !demoMode) {
  process.exit(1);
}
