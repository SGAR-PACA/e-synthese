import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signCookieValue, verifyCookieValue, readSourceSession, makeSourceSessionCookie } from '../src/lib/source-session.js';

const KEY = 'rp-cookie-key-32-octets-aaaaaaaaaa';

test('sign/verify : round-trip', () => {
  const v = signCookieValue({ sub: 'user-1', exp: 9_000_000_000_000 }, KEY);
  const out = verifyCookieValue<{ sub: string }>(v, KEY);
  assert.equal(out?.sub, 'user-1');
});

test('verify : signature falsifiée -> null', () => {
  const v = signCookieValue({ sub: 'user-1' }, KEY);
  assert.equal(verifyCookieValue(v.slice(0, -2) + 'zz', KEY), null);
});

test('verify : mauvaise clé -> null', () => {
  const v = signCookieValue({ sub: 'user-1' }, KEY);
  assert.equal(verifyCookieValue(v, 'autre-cle'), null);
});

test('readSourceSession : session valide', () => {
  const v = signCookieValue({ sub: 'u', exp: 9_000_000_000_000 }, KEY, 'session');
  assert.deepEqual(readSourceSession(`a=b; src_session=${v}; c=d`, KEY, Date.now()), { sub: 'u' });
});

test('readSourceSession : session expirée -> null', () => {
  const v = signCookieValue({ sub: 'u', exp: 1000 }, KEY, 'session');
  assert.equal(readSourceSession(`src_session=${v}`, KEY, Date.now()), null);
});

test('makeSourceSessionCookie : attributs de sécurité', () => {
  const c = makeSourceSessionCookie('u', KEY);
  assert.match(c, /^src_session=/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\/v1\/source/);
});

test('domain separation : un cookie session est rejeté en contexte tx', () => {
  const v = signCookieValue({ sub: 'u' }, KEY, 'session');
  assert.equal(verifyCookieValue(v, KEY, 'tx'), null);
  assert.deepEqual(verifyCookieValue(v, KEY, 'session'), { sub: 'u' });
});
