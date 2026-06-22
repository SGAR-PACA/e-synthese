// mastra/test/document-status.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextJobStatus } from '../src/lib/db.js';

test('processing + albert_done -> ready', () => {
  assert.equal(nextJobStatus('processing', 'albert_done'), 'ready');
});

test('processing + error -> failed', () => {
  assert.equal(nextJobStatus('processing', 'error'), 'failed');
});

test('ocr_done ne termine pas le job (reste processing)', () => {
  assert.equal(nextJobStatus('processing', 'ocr_done'), 'processing');
});

test('un job ready/failed est terminal', () => {
  assert.equal(nextJobStatus('ready', 'error'), 'ready');
  assert.equal(nextJobStatus('failed', 'albert_done'), 'failed');
});
