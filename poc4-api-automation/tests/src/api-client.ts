// One client per (service, caller). It fills path templates, adds X-One-Time-Uuid, enforces the read-only guard and
// records every call so a failing test can attach the conversation, masked.
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import type { EnvConfig, ServiceName } from './env';
import { maskBody, maskHeaders } from './mask';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface CallOptions {
  /** Values for {name} placeholders in the path template. */
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** A raw body with its own content type, for malformed-input tests. */
  rawBody?: { data: string; contentType: string };
  headers?: Record<string, string>;
  /** undefined: a fresh UUID. null: send no X-One-Time-Uuid. A string: send exactly that. */
  uuid?: string | null;
  /** false: put path params in the URL as they are (to test raw "|"). */
  encodePath?: boolean;
}

export interface ApiResult {
  service: ServiceName;
  method: Method;
  template: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: any;
  text: string;
  uuid: string | null;
  ms: number;
}

export interface CallRecord {
  request: { method: Method; url: string; headers: Record<string, string>; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown; ms: number };
}

export type HeaderSource = () => Promise<Record<string, string>>;

export class WriteBlockedError extends Error {}

export class ApiClient {
  constructor(
    readonly service: ServiceName,
    private readonly request: APIRequestContext,
    private readonly env: EnvConfig,
    private readonly authHeaders: HeaderSource,
    private readonly log: CallRecord[],
  ) {}

  get(template: string, options: CallOptions = {}) { return this.call('GET', template, options); }
  post(template: string, options: CallOptions = {}) { return this.call('POST', template, options); }
  put(template: string, options: CallOptions = {}) { return this.call('PUT', template, options); }
  delete(template: string, options: CallOptions = {}) { return this.call('DELETE', template, options); }

  async call(method: Method, template: string, options: CallOptions = {}): Promise<ApiResult> {
    if (method !== 'GET' && !this.env.allowWrite) {
      throw new WriteBlockedError(`${method} ${template} blocked: ${this.env.name} is read-only (allowWrite=false)`);
    }
    const path = template.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = options.params?.[name];
      if (value === undefined) throw new Error(`Missing path param ${name} for ${template}`);
      return options.encodePath === false ? value : encodeURIComponent(value);
    });
    const uuid = options.uuid === undefined ? randomUUID() : options.uuid;
    const headers: Record<string, string> = { accept: 'application/json', ...(await this.authHeaders()), ...options.headers };
    if (uuid !== null) headers['X-One-Time-Uuid'] = uuid;
    const query = Object.fromEntries(Object.entries(options.query ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;
    const url = `${this.env.services[this.service]}${path}`;

    const started = Date.now();
    const response = await this.request.fetch(url, {
      method,
      headers: options.rawBody ? { ...headers, 'content-type': options.rawBody.contentType } : headers,
      params: query,
      data: options.rawBody ? options.rawBody.data : options.body,
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    const ms = Date.now() - started;
    const text = await response.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : undefined; } catch { /* not JSON: keep the text */ }
    const result: ApiResult = { service: this.service, method, template, url: response.url(), status: response.status(), headers: response.headers(), body, text, uuid, ms };
    this.log.push({
      request: { method, url: maskBody(result.url) as string, headers: maskHeaders(headers), body: maskBody(options.body ?? options.rawBody?.data) },
      response: { status: result.status, headers: maskHeaders(result.headers), body: maskBody(body), ms },
    });
    return result;
  }
}
