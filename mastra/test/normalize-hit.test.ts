// mastra/test/normalize-hit.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHit } from '../src/mastra/pipeline/retrieval.js';

test('normalizeHit : capture document_id et chunk id', () => {
  const out = normalizeHit({
    score: 0.8,
    chunk: { content: 'texte', document_id: 'doc-7', id: 'chunk-3', metadata: { document_name: 'A.pdf' } },
  });
  assert.equal(out.documentId, 'doc-7');
  assert.equal(out.chunkId, 'chunk-3');
  assert.equal(out.name, 'A.pdf');
  assert.equal(out.content, 'texte');
});

test('normalizeHit : ids absents -> undefined', () => {
  const out = normalizeHit({ score: 0.5, chunk: { content: 'x', metadata: {} } });
  assert.equal(out.documentId, undefined);
  assert.equal(out.chunkId, undefined);
  assert.equal(out.collectionId, undefined);
});

test('normalizeHit : capture collection_id (cloisonnement) et le typpe en nombre', () => {
  const out = normalizeHit({
    score: 0.9,
    chunk: { content: 't', document_id: 'd', metadata: { document_name: 'A.pdf', collection_id: '270076' } },
  });
  assert.equal(out.collectionId, 270076);
});
