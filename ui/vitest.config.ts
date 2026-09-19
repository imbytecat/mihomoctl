import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    allowOnly: !process.env.CI,
    maxWorkers: 2,
    restoreMocks: true,
    attachmentsDir: 'test-results/attachments',
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/*.test.ts', 'packages/*/tests/*.test.ts'],
          testTimeout: 10_000,
        },
      },
      {
        extends: true,
        publicDir: 'dist',
        optimizeDeps: { entries: ['tests/browser/host.html'], include: ['yaml'] },
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          testTimeout: 60_000,
          expect: { poll: { timeout: 15_000, interval: 50 } },
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({ actionTimeout: 15_000 }),
            instances: [{ browser: 'chromium' }],
            screenshotDirectory: 'test-results/screenshots',
            trace: {
              mode: 'retain-on-failure',
              tracesDir: 'test-results/traces',
            },
          },
        },
      },
    ],
  },
});
