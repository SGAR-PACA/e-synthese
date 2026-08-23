import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signCookieValue,
  verifyCookieValue,
  clearSourceSessionCookie,
  hashSourceSessionToken,
  makeSourceSessionCookie,
  newSourceSessionToken,
  readSourceSessionToken,
} from '../src/lib/source-session.js';

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

test('session visionneuse : le cookie ne contient qu’un token opaque', () => {
  const token = newSourceSessionToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(readSourceSessionToken(`a=b; src_session=${token}; c=d`), token);
  assert.equal(hashSourceSessionToken(token).length, 64);
});

test('session visionneuse : un ancien cookie signé n’est plus accepté', () => {
  const oldCookie = signCookieValue({ sub: 'u', groups: ['sgar'], exp: 9_000_000_000_000 }, KEY, 'session');
  assert.equal(readSourceSessionToken(`src_session=${oldCookie}`), null);
});

test('session visionneuse : token malformé -> null', () => {
  assert.equal(readSourceSessionToken('src_session=not-a-token'), null);
  assert.equal(readSourceSessionToken('other=1;src_session=x'), null);
});

test('makeSourceSessionCookie : attributs de sécurité', () => {
  const c = makeSourceSessionCookie(newSourceSessionToken());
  assert.match(c, /^src_session=/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\/v1\/source/);
});

test('clearSourceSessionCookie : même chemin de cookie', () => {
  const c = clearSourceSessionCookie();
  assert.match(c, /^src_session=/);
  assert.match(c, /Max-Age=0/);
  assert.match(c, /Path=\/v1\/source/);
});

test('domain separation : un cookie session est rejeté en contexte tx', () => {
  const v = signCookieValue({ sub: 'u' }, KEY, 'session');
  assert.equal(verifyCookieValue(v, KEY, 'tx'), null);
  assert.deepEqual(verifyCookieValue(v, KEY, 'session'), { sub: 'u' });
});
