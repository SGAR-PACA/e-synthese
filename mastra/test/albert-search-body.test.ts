// mastra/test/albert-search-body.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchBody } from '../src/lib/albert-client.js';

// Régression sécurité : le filtre DOIT partir sous le nom `collection_ids`.
// Avec `collections` (l'ancien nom), Albert ignore le filtre et cherche dans
// tout le corpus → fuite de cloisonnement.
test('buildSearchBody : envoie collection_ids (pas collections)', () => {
  const body = buildSearchBody({ query: 'q', collections: [270076], k: 20 });
  assert.deepEqual(body.collection_ids, [270076]);
  assert.equal((body as any).collections, undefined, 'le champ `collections` ne doit PAS être envoyé');
});

test('buildSearchBody : mappe k → limit', () => {
  const body = buildSearchBody({ query: 'q', collections: [1], k: 20 });
  assert.equal(body.limit, 20);
  assert.equal((body as any).k, undefined, 'le champ `k` ne doit PAS être envoyé');
});

test('buildSearchBody : plafonne limit à 100 (max API)', () => {
  const body = buildSearchBody({ query: 'q', collections: [1], k: 500 });
  assert.equal(body.limit, 100);
});

test('buildSearchBody : pas de limit si k absent', () => {
  const body = buildSearchBody({ query: 'q', collections: [1] });
  assert.equal('limit' in body, false);
});

test('buildSearchBody : conserve la query', () => {
  const body = buildSearchBody({ query: 'qui est tom', collections: [1] });
  assert.equal(body.query, 'qui est tom');
});
