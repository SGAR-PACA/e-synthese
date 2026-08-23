// mastra/test/source-resolve.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDocumentFile, type FileCandidate } from '../src/lib/source-resolve.js';

const f = (id: string, cid: number | null, created: string): FileCandidate => ({
  albert_document_id: id,
  collection_id: cid,
  created_at: created,
});

// Reproduit le bug observé en prod : un CV existe dans la collection autorisée
// (270076) ET dans des collections non vues (2280). Le pont-par-nom choisissait
// l'homonyme le plus récent toutes collections confondues → 2280 → refus 403.
test('ignore les homonymes hors des collections autorisées', () => {
  const cands = [
    f('4647453', 2280, '2026-06-29T11:59:51Z'), // plus récent MAIS non autorisé
    f('4800846', 270076, '2026-08-23T14:00:53Z'), // le bon (autorisé)
  ];
  const picked = pickDocumentFile(cands, [270076]);
  assert.equal(picked?.albert_document_id, '4800846');
});

test("préfère la collection réelle du chunk quand plusieurs copies sont autorisées", () => {
  const cands = [
    f('B', 200, '2026-08-01T00:00:00Z'), // plus récent
    f('A', 100, '2026-01-01T00:00:00Z'), // la collection réelle du chunk
  ];
  const picked = pickDocumentFile(cands, [100, 200], 100);
  assert.equal(picked?.albert_document_id, 'A');
});

test('à défaut de collection réelle connue, prend la copie autorisée la plus récente', () => {
  const cands = [
    f('old', 100, '2026-01-01T00:00:00Z'),
    f('new', 200, '2026-08-01T00:00:00Z'),
  ];
  const picked = pickDocumentFile(cands, [100, 200]);
  assert.equal(picked?.albert_document_id, 'new');
});

test('admin (allowedCollections null) : aucune restriction, plus récent', () => {
  const cands = [
    f('x', 2280, '2026-06-29T00:00:00Z'),
    f('y', 270076, '2026-08-23T00:00:00Z'),
  ];
  const picked = pickDocumentFile(cands, null);
  assert.equal(picked?.albert_document_id, 'y');
});

test('aucune copie autorisée -> undefined (pas de lien plutôt qu\'un 403)', () => {
  const cands = [f('z', 2280, '2026-06-29T00:00:00Z')];
  assert.equal(pickDocumentFile(cands, [270076]), undefined);
});

test('collection_id null jamais autorisable hors admin', () => {
  const cands = [f('n', null, '2026-06-29T00:00:00Z')];
  assert.equal(pickDocumentFile(cands, [270076]), undefined);
  assert.equal(pickDocumentFile(cands, null)?.albert_document_id, 'n'); // admin : ok
});
