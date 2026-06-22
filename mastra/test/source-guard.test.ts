// mastra/test/source-guard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { txCookie, readTxCookie, constantTimeEqual } from '../src/routes/sources-auth.js';

const KEY = 'rp-cookie-key-32-octets-aaaaaaaaaa';
const TX = { state: 'ST', nonce: 'NO', verifier: 'VE', returnUrl: '/v1/source/doc-7?used=c1' };

test('constantTimeEqual : égalité et inégalité', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
});

test('txCookie/readTxCookie : round-trip', () => {
  const setCookie = txCookie(TX, KEY);
  const value = setCookie.split(';')[0].replace('src_oidc_tx=', '');
  assert.deepEqual(readTxCookie(`src_oidc_tx=${value}`, KEY), TX);
});

test('readTxCookie : falsifié -> null', () => {
  const setCookie = txCookie(TX, KEY);
  const value = setCookie.split(';')[0].replace('src_oidc_tx=', '');
  assert.equal(readTxCookie(`src_oidc_tx=${value}xx`, KEY), null);
});

test('txCookie : attributs de sécurité', () => {
  const c = txCookie(TX, KEY);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\/v1\/source/);
});
