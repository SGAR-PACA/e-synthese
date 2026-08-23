import { createHash, randomBytes } from 'node:crypto';

export function randomUrlToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function buildAuthUrl(
  authEndpoint: string,
  p: {
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    challenge: string;
    prompt?: 'none' | 'login';
  },
): string {
  const u = new URL(authEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', 'openid');
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (p.prompt) u.searchParams.set('prompt', p.prompt);
  return u.toString();
}
