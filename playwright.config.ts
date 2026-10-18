import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Uses the system Edge on Windows and Chrome elsewhere, so no browser download is needed.
// In CI set PLAYWRIGHT_CHANNEL=chromium after `playwright install chromium`.
const channel =
  process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chrome');

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    channel: channel === 'chromium' ? undefined : channel,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --import tsx tools/dev-runner/src/main.ts',
    url: 'http://localhost:5173/readyz',
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: { DEV_DATA_DIR: path.resolve('test-results', 'e2e-data'), SDLC_DEMO: '1' },
  },
});
