import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignedQuery, verifySourceToken } from '../src/lib/source-token.js';

const KEY = 'cle-test-32-octets-aaaaaaaaaaaaaaaa';
const FUTURE = 9_000_000_000_000;

function parse(q: string) {
  const p = new URLSearchParams(q);
  return { used: p.get('used') ?? '', exp: p.get('exp') ?? '', sig: p.get('sig') ?? '' };
}

test('round-trip : jeton valide accepté', () => {
  const q = buildSignedQuery('doc-1', ['c1', 'c2'], FUTURE, KEY);
  const { used, exp, sig } = parse(q);
  assert.equal(verifySourceToken('doc-1', used, exp, sig, KEY, Date.now()), true);
});

test('signature falsifiée -> rejet', () => {
  const q = buildSignedQuery('doc-1', ['c1'], FUTURE, KEY);
  const { used, exp } = parse(q);
  assert.equal(verifySourceToken('doc-1', used, exp, 'AAAA', KEY, Date.now()), false);
});

test('documentId modifié -> rejet (anti-énumération)', () => {
  const q = buildSignedQuery('doc-1', ['c1'], FUTURE, KEY);
  const { used, exp, sig } = parse(q);
  assert.equal(verifySourceToken('doc-99', used, exp, sig, KEY, Date.now()), false);
});

test('jeton expiré -> rejet', () => {
  const q = buildSignedQuery('doc-1', ['c1'], 1000, KEY);
  const { used, exp, sig } = parse(q);
  assert.equal(verifySourceToken('doc-1', used, exp, sig, KEY, Date.now()), false);
});

test('rejet si documentId contient le délimiteur | (anti-ambiguïté)', () => {
  const q = buildSignedQuery('doc-1', ['c1'], FUTURE, KEY);
  const { used, exp, sig } = parse(q);
  assert.equal(verifySourceToken('doc|1', used, exp, sig, KEY, Date.now()), false);
});

test('sans chunkIds : used vide mais jeton valide', () => {
  const q = buildSignedQuery('doc-1', [], FUTURE, KEY);
  const { used, exp, sig } = parse(q);
  assert.equal(used, '');
  assert.equal(verifySourceToken('doc-1', '', exp, sig, KEY, Date.now()), true);
});
