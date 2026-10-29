// A stand-in for the identity provider: issues RS256 JWTs and serves the JWKS the services verify them with.
// No dependencies. Local only: every password and secret it accepts is a fixed dummy.
//
//   POST /oauth/token  grant_type=password            username=<name> password=local-only-password  -> sub auth0|<name>, scope user
//                      grant_type=client_credentials  client_id=pw-backoffice client_secret=local-only-secret -> scope backoffice
//                      ttl=<seconds> (optional, negative gives an expired token)
//   GET  /.well-known/jwks.json

import { createServer } from 'node:http';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8090);
const ISSUER = process.env.ISSUER ?? 'http://mock-idp.local/';
const PASSWORD = 'local-only-password';
const CLIENTS = { 'pw-backoffice': { secret: 'local-only-secret', scope: 'backoffice' } };

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = randomUUID();
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function sign(claims, ttl) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64url({ alg: 'RS256', typ: 'JWT', kid })}.${b64url({ iss: ISSUER, iat: now, exp: now + ttl, jti: randomUUID(), ...claims })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url')}`;
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function token(form) {
  const ttl = Number(form.get('ttl') ?? 3600);
  if (form.get('grant_type') === 'password') {
    const username = form.get('username') ?? '';
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username) || form.get('password') !== PASSWORD) return [401, { error: 'invalid_grant' }];
    return [200, { access_token: sign({ sub: `auth0|${username}`, scope: 'user', aud: 'sim-api' }, ttl), token_type: 'Bearer', expires_in: ttl }];
  }
  if (form.get('grant_type') === 'client_credentials') {
    const client = CLIENTS[form.get('client_id')];
    if (!client || client.secret !== form.get('client_secret')) return [401, { error: 'invalid_client' }];
    return [200, { access_token: sign({ sub: `${form.get('client_id')}@clients`, scope: client.scope, aud: 'sim-api' }, ttl), token_type: 'Bearer', expires_in: ttl }];
  }
  return [400, { error: 'unsupported_grant_type' }];
}

createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && pathname === '/.well-known/jwks.json') return send(res, 200, { keys: [jwk] });
  if (req.method === 'GET' && pathname === '/health') return send(res, 200, { status: 'UP' });
  if (req.method === 'POST' && pathname === '/oauth/token') {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => send(res, ...token(new URLSearchParams(raw))));
    return;
  }
  send(res, 404, { error: 'not_found' });
}).listen(PORT, () => console.log(`mock-idp listening on ${PORT}`));
