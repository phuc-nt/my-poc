import os from 'node:os';
import { defineConfig } from '@playwright/test';
import { loadEnv } from './src/env';

const env = loadEnv();
// Each pipeline stage keeps its own reports (scripts/pipeline.sh sets PW_STAGE).
const results = process.env.PW_STAGE ? `results/${process.env.PW_STAGE}` : 'results';
const skip = [!env.allowWrite && '@write', !env.stubs && '@stub', !env.apiDocs && '@apidocs'].filter(Boolean) as string[];

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  // One worker per pooled account: two workers never share a user.
  workers: Math.min(env.accounts.pool.length, Number(process.env.PW_WORKERS ?? os.cpus().length)),
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  grepInvert: skip.length ? new RegExp(skip.join('|')) : undefined,
  globalSetup: process.env.PW_ONLY_FRAMEWORK ? undefined : './src/global-setup.ts',
  outputDir: `${results}/artifacts`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${results}/html`, open: 'never' }],
    ['junit', { outputFile: `${results}/junit.xml` }],
  ],
  metadata: { environment: env.name, allowWrite: env.allowWrite, stubs: env.stubs },
});
