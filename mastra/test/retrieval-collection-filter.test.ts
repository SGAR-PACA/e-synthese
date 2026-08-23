// mastra/test/retrieval-collection-filter.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterByAllowedCollections } from '../src/mastra/pipeline/retrieval.js';
import type { RagChunk } from '../src/lib/db.js';

const ch = (collectionId: number | undefined): RagChunk => ({
  name: 'x',
  content: 'c',
  score: 1,
  url: '',
  collectionId,
});

test('restreint : ne garde que les passages des collections autorisées', () => {
  const chunks = [ch(270076), ch(2280), ch(5963), ch(270076)];
  const out = filterByAllowedCollections(chunks, [270076]);
  assert.equal(out.length, 2);
  assert.ok(out.every((c) => c.collectionId === 270076));
});

test('restreint : un passage sans collectionId est rejeté (défaut sûr)', () => {
  const out = filterByAllowedCollections([ch(undefined), ch(270076)], [270076]);
  assert.deepEqual(out.map((c) => c.collectionId), [270076]);
});

test('admin (null) : aucun filtre, tout passe', () => {
  const chunks = [ch(270076), ch(2280), ch(undefined)];
  assert.equal(filterByAllowedCollections(chunks, null).length, 3);
});

test('reproduit le débordement Albert : CV renvoyé depuis 2280/5963 → jeté hors 270076', () => {
  // Ce qu'Albert renvoyait réellement quand le filtre était ignoré.
  const chunks = [ch(270076), ch(2280), ch(2280), ch(5963), ch(2280)];
  const out = filterByAllowedCollections(chunks, [270076]);
  assert.equal(out.length, 1, 'seul le passage 270076 survit');
});
