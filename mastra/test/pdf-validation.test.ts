import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPdfBytes } from '../src/lib/pdf-validation.js';

const bytesOf = (s: string) => new TextEncoder().encode(s);

test('isPdfBytes : accepte un en-tête %PDF-', () => {
  assert.equal(isPdfBytes(bytesOf('%PDF-1.7\n...')), true);
});

test('isPdfBytes : refuse un contenu non-PDF', () => {
  assert.equal(isPdfBytes(bytesOf('PK zip...')), false);
});

test('isPdfBytes : refuse un buffer trop court', () => {
  assert.equal(isPdfBytes(bytesOf('%PD')), false);
});

test('isPdfBytes : refuse un buffer vide', () => {
  assert.equal(isPdfBytes(new Uint8Array(0)), false);
});
