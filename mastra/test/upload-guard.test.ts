import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPdfBlob } from '../src/routes/documents.js';

test('pickPdfBlob : retourne le blob fichier', () => {
  const fd = new FormData();
  fd.append('collection_id', '7');
  fd.append('file', new Blob([new Uint8Array([1, 2])], { type: 'application/pdf' }), 'a.pdf');
  const blob = pickPdfBlob(fd);
  assert.ok(blob instanceof Blob);
  assert.equal(blob!.size, 2);
});

test('pickPdfBlob : undefined si pas de fichier', () => {
  const fd = new FormData();
  fd.append('collection_id', '7');
  assert.equal(pickPdfBlob(fd), undefined);
});
