// Fails the run in seconds, with a clear message, when the target is not reachable, instead of a hundred timeouts.
import { request } from '@playwright/test';
import { loadEnv } from './env';

export default async function globalSetup(): Promise<void> {
  if (process.env.PW_SKIP_HEALTH === 'true') return;
  const env = loadEnv();
  const context = await request.newContext({ timeout: 10_000 });
  const down: string[] = [];
  for (const [name, base] of Object.entries(env.services)) {
    const response = await context.get(`${base}/health`).catch(() => undefined);
    if (!response?.ok()) down.push(`service-${name} (${response ? response.status() : 'unreachable'})`);
  }
  await context.dispose();
  if (down.length) throw new Error(`${env.name}: ${down.join(', ')} not healthy; is the environment up (docker compose up -d --wait)?`);
}
