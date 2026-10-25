// Who is calling: a Cognito ID token (the web app) or a personal access token (MCP clients).
// Then what they may read: the data sources granted to them (an admin reads every source).

import { createHash, randomBytes } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { config } from './config.mjs';
import { get, put, query, now } from './store.mjs';
import { claimImported } from './permissions.mjs';

let verifier;
const idTokens = () => (verifier ||= CognitoJwtVerifier.create({ userPoolId: config.userPoolId, tokenUse: 'id', clientId: config.clientId }));

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
export const newToken = () => `poc3_${randomBytes(24).toString('base64url')}`;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function profile(email, name) {
  const existing = await get(`USER#${email}`, 'PROFILE');
  if (existing) return existing;
  // The first sign-in of an address listed in ADMIN_EMAILS makes an active admin; anyone else waits for approval,
  // unless the Confluence or SharePoint permissions already name them.
  const admin = config.adminEmails.includes(email);
  const fresh = { pk: `USER#${email}`, sk: 'PROFILE', email, name: name || email.split('@')[0], role: admin ? 'admin' : 'member',
    status: admin ? 'active' : 'pending', requested: [], createdAt: now(), gsi1pk: 'USERS', gsi1sk: `${admin ? 'active' : 'pending'}#${email}` };
  await put(fresh);
  return claimImported(fresh);
}

// The caller, from an Authorization header. { email, name, role, status, via: 'web' | 'token' }
export async function caller(authorization = '') {
  const bearer = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!bearer) throw new HttpError(401, 'Sign in first');
  if (bearer.startsWith('poc3_')) {
    const record = await get(`PAT#${hashToken(bearer)}`, 'PAT');
    if (!record || (record.expiresAt && record.expiresAt < now())) throw new HttpError(401, 'Unknown or expired access token');
    const user = await get(`USER#${record.email}`, 'PROFILE');
    if (!user || user.status !== 'active') throw new HttpError(403, 'This account is not active');
    put({ ...record, lastUsedAt: now() }).catch(() => {});
    return { ...user, via: 'token' };
  }
  let claims;
  try {
    claims = await idTokens().verify(bearer);
  } catch {
    throw new HttpError(401, 'Sign-in expired, sign in again');
  }
  const email = String(claims.email || '').toLowerCase();
  if (!email || claims.email_verified === false) throw new HttpError(403, 'Verify your email first');
  return { ...(await profile(email, claims.name)), via: 'web' };
}

export const isAdmin = (user) => user.role === 'admin' && user.status === 'active';

// The data source ids this user may search.
export async function grantedSourceIds(user, allSources) {
  if (user.status !== 'active') return [];
  if (isAdmin(user)) return allSources.map((s) => s.id);
  const grants = await query(`USER#${user.email}`, 'GRANT#');
  const known = new Set(allSources.map((s) => s.id));
  return grants.map((g) => g.sk.slice('GRANT#'.length)).filter((id) => known.has(id));
}
