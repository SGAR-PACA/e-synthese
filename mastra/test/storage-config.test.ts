// mastra/test/storage-config.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchableKey, originalKey } from '../src/lib/storage.js';

test('searchableKey : préfixe par fileId', () => {
  assert.equal(searchableKey('abc-123'), 'abc-123/searchable.pdf');
});

test('originalKey : préfixe par fileId', () => {
  assert.equal(originalKey('abc-123'), 'abc-123/original.pdf');
});
