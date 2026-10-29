// Gets bearer tokens for test users and the back-office client, cached per worker until shortly before expiry.
import type { APIRequestContext } from '@playwright/test';
import { EnvConfig, secret } from './env';

export class TokenProvider {
  private cache = new Map<string, { token: string; until: number }>();

  constructor(private readonly env: EnvConfig, private readonly request: APIRequestContext) {}

  /** A user token for userId. ttlSeconds (mock IdP only) makes a fresh, uncached token, negative for an expired one. */
  async user(userId: string, ttlSeconds?: number): Promise<string> {
    const auth = this.env.auth;
    if (auth.kind === 'env-token') {
      const index = this.env.accounts.pool.indexOf(userId) + 1;
      return secret(`${auth.userTokenEnvPrefix}${index}`);
    }
    const username = userId.slice(userId.indexOf('|') + 1);
    return this.fetch(`user:${userId}`, ttlSeconds, {
      grant_type: 'password',
      username,
      password: secret(auth.userPasswordEnv),
    });
  }

  async backoffice(): Promise<string> {
    const auth = this.env.auth;
    if (auth.kind === 'env-token') return secret(auth.backofficeTokenEnv);
    return this.fetch('backoffice', undefined, {
      grant_type: 'client_credentials',
      client_id: auth.backofficeClientId,
      client_secret: secret(auth.backofficeSecretEnv),
    });
  }

  private async fetch(key: string, ttl: number | undefined, form: Record<string, string>): Promise<string> {
    const hit = this.cache.get(key);
    if (ttl === undefined && hit && hit.until > Date.now()) return hit.token;
    const auth = this.env.auth as Extract<typeof this.env.auth, { kind: 'oauth-mock' }>;
    const response = await this.request.post(auth.tokenUrl, { form: ttl === undefined ? form : { ...form, ttl: String(ttl) } });
    if (!response.ok()) throw new Error(`Token request for ${key} failed with ${response.status()}`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    if (ttl === undefined) this.cache.set(key, { token: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 });
    return body.access_token;
  }
}
