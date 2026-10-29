// Validates responses against the committed OpenAPI contracts (contracts/service-*.json).
// Success bodies use the operation's own schema with additionalProperties:false added to every object, so a field
// that is renamed or added without updating the contract fails. Error bodies use the shared envelope below.
import fs from 'node:fs';
import path from 'node:path';
import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { ApiResult } from './api-client';
import type { ServiceName } from './env';

export const ERROR_ENVELOPE = {
  type: 'object',
  required: ['result', 'errors'],
  additionalProperties: false,
  properties: {
    result: { const: 'NG' },
    errors: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['code', 'messageId', 'message'],
        additionalProperties: false,
        properties: {
          code: { type: 'string', pattern: '^E\\d{3}$' },
          messageId: { type: 'string', pattern: '^E\\.[A-Z]+\\.\\d{4}$' },
          message: { type: 'string', minLength: 1 },
          field: { type: 'string' },
        },
      },
    },
  },
} as const;

export type OpenApi = { paths: Record<string, Record<string, any>>; components?: { schemas?: Record<string, any> } };

export function loadContract(service: ServiceName): OpenApi {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', `service-${service}.json`), 'utf8'));
}

function strict(schema: any): any {
  if (Array.isArray(schema)) return schema.map(strict);
  if (!schema || typeof schema !== 'object') return schema;
  const out = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, strict(v)]));
  if (out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

function rebase(schema: any, id: string): any {
  if (Array.isArray(schema)) return schema.map((s) => rebase(s, id));
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).map(([k, v]) =>
    [k, k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `${id}${v}` : rebase(v, id)]));
}

export class ContractValidator {
  private readonly ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false });
  private readonly specs = new Map<ServiceName, OpenApi>();
  private readonly compiled = new Map<string, ValidateFunction>();
  private readonly errorEnvelope: ValidateFunction;

  constructor(specs: Partial<Record<ServiceName, OpenApi>>) {
    addFormats(this.ajv);
    for (const [service, spec] of Object.entries(specs) as [ServiceName, OpenApi][]) {
      this.specs.set(service, spec);
      this.ajv.addSchema({ $id: `contract-${service}`, components: strict(spec.components ?? {}) });
    }
    this.errorEnvelope = this.ajv.compile(ERROR_ENVELOPE);
  }

  static fromFiles(): ContractValidator {
    return new ContractValidator({ a: loadContract('a'), b: loadContract('b') });
  }

  /** Returns readable problems; an empty list means the response matches the contract. */
  validate(result: ApiResult): string[] {
    if (result.status >= 400) {
      return this.errorEnvelope(result.body) ? [] : this.describe(this.errorEnvelope);
    }
    const spec = this.specs.get(result.service);
    const operation = spec?.paths[result.template]?.[result.method.toLowerCase()];
    if (!operation) return [`${result.method} ${result.template} is not in contract service-${result.service}`];
    const responses = operation.responses ?? {};
    const response = responses[String(result.status)] ?? responses['200'] ?? responses.default;
    const content = response?.content ?? {};
    const schema = (content['application/json'] ?? content['*/*'] ?? Object.values(content)[0])?.schema;
    if (!schema) return [];
    const key = `${result.service} ${result.method} ${result.template}`;
    let validate = this.compiled.get(key);
    if (!validate) {
      validate = this.ajv.compile(strict(rebase(schema, `contract-${result.service}`)));
      this.compiled.set(key, validate);
    }
    return validate(result.body) ? [] : this.describe(validate);
  }

  private describe(validate: ValidateFunction): string[] {
    return (validate.errors ?? []).map((e) =>
      `${e.instancePath || '(body)'} ${e.message}${e.keyword === 'additionalProperties' ? `: ${(e.params as any).additionalProperty}` : ''}`);
  }
}
