// Per-test control of the third-party stubs. The services forward X-One-Time-Uuid downstream, so a stub that matches
// on the test's own uuid only affects that test, even with many workers running at once.
import type { APIRequestContext } from '@playwright/test';

export interface FaultStub {
  method?: string;
  urlPathPattern: string;
  status: number;
  jsonBody?: unknown;
  delayMs?: number;
}

export interface JournalEntry { url: string; method: string; headers: Record<string, string>; body: any }

export class WireMock {
  private readonly created: string[] = [];

  constructor(private readonly request: APIRequestContext, private readonly baseUrl: string) {}

  async stubFor(uuid: string, stub: FaultStub): Promise<void> {
    const response = await this.request.post(`${this.baseUrl}/__admin/mappings`, {
      data: {
        priority: 1,
        request: {
          method: stub.method ?? 'ANY',
          urlPathPattern: stub.urlPathPattern,
          headers: { 'X-One-Time-Uuid': { equalTo: uuid } },
        },
        response: {
          status: stub.status,
          headers: { 'Content-Type': 'application/json' },
          jsonBody: stub.jsonBody ?? { error: 'stubbed failure' },
          fixedDelayMilliseconds: stub.delayMs,
        },
      },
    });
    if (!response.ok()) throw new Error(`WireMock refused the stub: ${response.status()}`);
    this.created.push(((await response.json()) as { id: string }).id);
  }

  /** The requests the services made to third parties while handling the call with this uuid. */
  async requests(uuid: string, urlPathPattern?: string): Promise<JournalEntry[]> {
    const response = await this.request.post(`${this.baseUrl}/__admin/requests/find`, {
      data: { method: 'ANY', urlPathPattern: urlPathPattern ?? '.*', headers: { 'X-One-Time-Uuid': { equalTo: uuid } } },
    });
    const { requests } = (await response.json()) as { requests: { url: string; method: string; headers: Record<string, string>; body: string }[] };
    return requests.map((r) => {
      let body: unknown = r.body;
      try { body = JSON.parse(r.body); } catch { /* keep the text */ }
      return { url: r.url, method: r.method, headers: r.headers, body };
    });
  }

  async cleanup(): Promise<void> {
    for (const id of this.created.splice(0)) await this.request.delete(`${this.baseUrl}/__admin/mappings/${id}`);
  }
}
