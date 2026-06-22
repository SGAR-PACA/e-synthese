// mastra/test/document-worker.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processJob, type JobDeps } from '../src/lib/document-worker.js';
import type { DocumentFile } from '../src/lib/db.js';

const baseJob: DocumentFile = {
  id: 'f1', albert_document_id: null, collection_id: 7, filename: 'a.pdf',
  s3_key_searchable: null, status: 'processing', error: null, ocr_applied: false,
  uploaded_by: 1, created_at: 'x', updated_at: 'x',
};

function makeDeps(over: Partial<JobDeps> = {}): { deps: JobDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: JobDeps = {
    loadOriginal: async () => { calls.push('load'); return new Uint8Array([1]); },
    ocr: async () => { calls.push('ocr'); return { pdf: new Uint8Array([2]), ocrApplied: true }; },
    storeSearchable: async () => { calls.push('store'); },
    deleteOriginal: async () => { calls.push('delete'); },
    uploadToAlbert: async () => { calls.push('albert'); return 'albert-doc-9'; },
    markReady: async () => { calls.push('ready'); },
    markFailed: async () => { calls.push('failed'); },
    ...over,
  };
  return { deps, calls };
}

test('chemin nominal : load -> ocr -> store -> delete -> albert -> ready', async () => {
  const { deps, calls } = makeDeps();
  await processJob(baseJob, deps);
  assert.deepEqual(calls, ['load', 'ocr', 'store', 'delete', 'albert', 'ready']);
});

test('idempotence : si albert_document_id + clé déjà set, ne refait ni load ni albert', async () => {
  const { deps, calls } = makeDeps();
  await processJob({ ...baseJob, albert_document_id: 'albert-doc-9', s3_key_searchable: 'f1/searchable.pdf' }, deps);
  assert.equal(calls.includes('load'), false);
  assert.equal(calls.includes('albert'), false);
  assert.equal(calls.includes('ready'), true);
});

test('repli OCR : OCR échoue -> indexe l_original chez Albert, ready, pas de failed', async () => {
  const { deps, calls } = makeDeps({ ocr: async () => { throw new Error('boom ocr'); } });
  await processJob(baseJob, deps);
  assert.deepEqual(calls, ['load', 'albert', 'ready']);
  assert.equal(calls.includes('store'), false);
  assert.equal(calls.includes('failed'), false);
});

test('échec Albert (IO non-OCR) -> markFailed', async () => {
  const { deps, calls } = makeDeps({ uploadToAlbert: async () => { throw new Error('albert down'); } });
  await processJob(baseJob, deps);
  assert.equal(calls.includes('failed'), true);
  assert.equal(calls.includes('ready'), false);
});
