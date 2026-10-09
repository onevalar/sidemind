import { globSync } from 'node:fs';
import { homedir } from 'node:os';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'canvas.spec.ts',
  outputDir: '/tmp/chatgit-browser-tests',
  reporter: 'list',
  workers: 1,
  timeout: 180000,
  use: {
    actionTimeout: 15000,
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3080',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2,
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath:
        process.env.CHROME_PATH ||
        globSync(`${homedir()}/.agent-browser/browsers/chrome-*/chrome`)[0],
    },
  },
});
