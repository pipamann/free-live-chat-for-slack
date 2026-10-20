import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ALLOWED_ORIGINS: 'https://example.com, https://shop.example.com/',
            SLACK_CHANNEL_ID: 'C0SUPPORT',
            SLACK_BOT_TOKEN: 'xoxb-test',
            SLACK_SIGNING_SECRET: 'test-signing-secret',
            TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
            TICKET_WEBHOOK_URL: 'https://tickets.example.com/hook',
            TICKET_WEBHOOK_SECRET: 'ticket-secret',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
    },
  };
});
