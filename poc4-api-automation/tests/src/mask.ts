// Masks credentials and personal data before anything is attached to a report or printed.

const SECRET_HEADERS = /^(authorization|x-api-key|x-partner-key|cookie|set-cookie)$/i;
const SECRET_FIELDS = /(pin|password|secret|token|signature)$/i;

export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, SECRET_HEADERS.test(k) ? (/^bearer /i.test(v) ? 'Bearer <redacted>' : '<redacted>') : v]),
  );
}

export function maskEmail(value: string): string {
  return value.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+)/g, '$1***@$2');
}

export function maskBody(value: unknown): unknown {
  if (typeof value === 'string') return maskEmail(value.replace(/signature=[0-9a-f]+/g, 'signature=<redacted>'));
  if (Array.isArray(value)) return value.map(maskBody);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_FIELDS.test(k) && v != null ? '<redacted>' : maskBody(v)]),
    );
  }
  return value;
}
