import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturnUrl } from '../src/lib/source-session.js';

test('accepte un chemin interne /v1/source/...', () => {
  assert.equal(safeReturnUrl('/v1/source/doc-7?used=c1&exp=9&sig=AB-_'), '/v1/source/doc-7?used=c1&exp=9&sig=AB-_');
});

test('rejette une URL absolue externe', () => {
  assert.equal(safeReturnUrl('https://evil.example/x'), '/v1/source');
});

test('rejette un chemin relatif au protocole //', () => {
  assert.equal(safeReturnUrl('//evil.example'), '/v1/source');
});

test('rejette un chemin hors /v1/source', () => {
  assert.equal(safeReturnUrl('/admin/users'), '/v1/source');
});

test('rejette le path traversal', () => {
  assert.equal(safeReturnUrl('/v1/source/../../admin'), '/v1/source');
});

test('valeur absente -> défaut', () => {
  assert.equal(safeReturnUrl(undefined), '/v1/source');
});
