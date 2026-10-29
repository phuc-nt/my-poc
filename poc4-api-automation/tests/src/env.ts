// Loads the target environment: envs/<TEST_ENV>.json, with ${VAR} placeholders filled from the process environment
// and secrets read from env vars only. No URL, token or key of a real environment lives in this repository.
import fs from 'node:fs';
import path from 'node:path';

export type ServiceName = 'a' | 'b';

export type AuthConfig =
  | { kind: 'oauth-mock'; tokenUrl: string; userPasswordEnv: string; backofficeClientId: string; backofficeSecretEnv: string }
  | { kind: 'env-token'; userTokenEnvPrefix: string; backofficeTokenEnv: string };

export interface EnvConfig {
  name: string;
  /** A production target is refused outright, whatever the other flags say. */
  production: boolean;
  /** false: the client refuses every non-GET call and @write tests are skipped. */
  allowWrite: boolean;
  /** false: the third parties are real (or unreachable to us), so @stub tests are skipped. */
  stubs: boolean;
  /** Whether /v3/api-docs is reachable on this environment. */
  apiDocs: boolean;
  envFile?: string;
  services: Record<ServiceName, string>;
  auth: AuthConfig;
  keys: { internalEnv: string; partnerEnv: string };
  wiremockUrl?: string;
  /** Test users, one per parallel worker. A worker never touches another worker's user. */
  accounts: { pool: string[]; locked?: string };
  tcuPool?: string[];
}

const ENV_DIR = path.join(__dirname, '..', 'envs');

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

function substitute<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
      const found = process.env[name];
      if (found === undefined) throw new Error(`The environment config needs ${name}, which is not set`);
      return found;
    }) as T;
  }
  if (Array.isArray(value)) return value.map(substitute) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)])) as T;
  }
  return value;
}

/** Throws when the config would let the suite run where it must not. */
export function guard(config: EnvConfig): EnvConfig {
  if (config.production || /prod/i.test(config.name)) {
    throw new Error(`Refusing to run against ${config.name}: the suite never targets production`);
  }
  if (config.stubs && !config.wiremockUrl) throw new Error(`${config.name}: stubs=true needs wiremockUrl`);
  if (config.accounts.pool.length === 0) throw new Error(`${config.name}: the account pool is empty`);
  return config;
}

let cached: EnvConfig | undefined;

export function loadEnv(name = process.env.TEST_ENV ?? 'local'): EnvConfig {
  if (cached && cached.name === name) return cached;
  const raw = JSON.parse(fs.readFileSync(path.join(ENV_DIR, `${name}.json`), 'utf8')) as EnvConfig;
  loadEnvFile(path.join(ENV_DIR, raw.envFile ?? `${name}.env`));
  const config = substitute(raw);
  // The pipeline can always narrow what a run may do, never widen it.
  if (process.env.PW_ALLOW_WRITE === 'false') config.allowWrite = false;
  if (process.env.PW_STUBS === 'false') config.stubs = false;
  cached = guard(config);
  return cached;
}

export function secret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Secret ${name} is not set (pipeline secret store, or envs/<env>.env locally)`);
  return value;
}
