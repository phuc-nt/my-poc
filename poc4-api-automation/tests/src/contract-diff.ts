// Compares two OpenAPI documents and lists the changes that would break an existing client.
// Breaking: an operation removed, a new required parameter or request field, a type changed, a response field
// removed or renamed, an enum value removed. Everything else (new operations, new optional fields) is reported as info.
import type { OpenApi } from './contract';

export interface ContractDiff { breaking: string[]; info: string[] }

const METHODS = ['get', 'post', 'put', 'delete', 'patch'];

function resolver(spec: OpenApi) {
  return (schema: any): any => {
    let s = schema;
    for (let i = 0; s?.$ref && i < 20; i++) s = spec.components?.schemas?.[s.$ref.split('/').pop()];
    return s ?? {};
  };
}

function bodySchema(content: any): any {
  if (!content) return undefined;
  return (content['application/json'] ?? content['*/*'] ?? Object.values(content)[0] as any)?.schema;
}

export function diffContracts(before: OpenApi, after: OpenApi): ContractDiff {
  const breaking: string[] = [];
  const info: string[] = [];
  const oldOf = resolver(before);
  const newOf = resolver(after);

  // direction 'response': the client reads it, so removals break. 'request': the client writes it, so new requirements break.
  function compare(where: string, o: any, n: any, direction: 'request' | 'response', seen: Set<string>): void {
    const key = `${where}|${o?.$ref ?? ''}|${n?.$ref ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const a = oldOf(o);
    const b = newOf(n);
    if (a.type && b.type && a.type !== b.type) breaking.push(`${where}: type ${a.type} -> ${b.type}`);
    if (a.format && b.format && a.format !== b.format) breaking.push(`${where}: format ${a.format} -> ${b.format}`);
    if (a.enum && b.enum) {
      const removed = a.enum.filter((v: unknown) => !b.enum.includes(v));
      const added = b.enum.filter((v: unknown) => !a.enum.includes(v));
      if (removed.length) (direction === 'request' ? breaking : info).push(`${where}: enum values removed ${removed.join(', ')}`);
      if (added.length) (direction === 'response' ? breaking : info).push(`${where}: enum values added ${added.join(', ')}`);
    }
    if (a.items || b.items) compare(`${where}[]`, a.items, b.items, direction, seen);
    const aProps = a.properties ?? {};
    const bProps = b.properties ?? {};
    for (const name of Object.keys(aProps)) {
      if (!(name in bProps)) {
        (direction === 'response' ? breaking : info).push(`${where}.${name}: ${direction} field removed`);
      } else {
        compare(`${where}.${name}`, aProps[name], bProps[name], direction, seen);
      }
    }
    for (const name of Object.keys(bProps)) {
      if (name in aProps) continue;
      const required = (b.required ?? []).includes(name);
      (direction === 'request' && required ? breaking : info).push(`${where}.${name}: ${direction} field added${required ? ' (required)' : ''}`);
    }
    if (direction === 'request') {
      for (const name of b.required ?? []) {
        if (name in aProps && !(a.required ?? []).includes(name)) breaking.push(`${where}.${name}: became required`);
      }
    }
  }

  for (const [path, item] of Object.entries(before.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const id = `${method.toUpperCase()} ${path}`;
      const next = after.paths[path]?.[method];
      if (!next) { breaking.push(`${id}: operation removed`); continue; }
      const params = (p: any[] = []) => new Map(p.map((x) => [`${x.in}:${x.name}`, x]));
      const oldParams = params(op.parameters);
      for (const [name, p] of params(next.parameters)) {
        const was = oldParams.get(name);
        if (!was && p.required) breaking.push(`${id}: new required parameter ${name}`);
        else if (!was) info.push(`${id}: new optional parameter ${name}`);
        else compare(`${id} param ${name}`, was.schema, p.schema, 'request', new Set());
      }
      compare(`${id} request`, bodySchema(op.requestBody?.content), bodySchema(next.requestBody?.content), 'request', new Set());
      for (const [status, response] of Object.entries<any>(op.responses ?? {})) {
        const now = next.responses?.[status];
        if (!now) { breaking.push(`${id}: response ${status} removed`); continue; }
        compare(`${id} ${status}`, bodySchema(response.content), bodySchema(now.content), 'response', new Set());
      }
    }
  }
  for (const [path, item] of Object.entries(after.paths)) {
    for (const method of METHODS) {
      if (item[method] && !before.paths[path]?.[method]) info.push(`${method.toUpperCase()} ${path}: operation added`);
    }
  }
  return { breaking, info };
}
