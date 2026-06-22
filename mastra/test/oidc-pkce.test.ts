import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pkceChallenge, buildAuthUrl } from '../src/lib/oidc-pkce.js';

test('pkceChallenge : vecteur de test RFC 7636', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(pkceChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('buildAuthUrl : contient les paramètres OIDC', () => {
  const url = buildAuthUrl('https://kc/auth', {
    clientId: 'mastra-sources', redirectUri: 'https://app/v1/source/callback',
    state: 'ST', nonce: 'NO', challenge: 'CH',
  });
  const u = new URL(url);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'mastra-sources');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://app/v1/source/callback');
  assert.equal(u.searchParams.get('scope'), 'openid');
  assert.equal(u.searchParams.get('state'), 'ST');
  assert.equal(u.searchParams.get('nonce'), 'NO');
  assert.equal(u.searchParams.get('code_challenge'), 'CH');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
});
