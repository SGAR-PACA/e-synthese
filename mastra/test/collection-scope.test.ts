import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractGroups, isAdminGroup, unionCollections } from '../src/lib/collection-scope.ts';

test('extractGroups lit le claim `groups` et retire le slash de tête', () => {
  const g = extractGroups({ groups: ['/sgar', '/pref13'] } as any);
  assert.deepEqual(g.sort(), ['pref13', 'sgar']);
});

test('extractGroups lit aussi realm_access.roles et déduplique', () => {
  const g = extractGroups({ groups: ['/sgar'], realm_access: { roles: ['sgar', 'commun'] } } as any);
  assert.deepEqual(g.sort(), ['commun', 'sgar']);
});

test('extractGroups tolère l\'absence de claims (payload vide)', () => {
  assert.deepEqual(extractGroups({} as any), []);
  assert.deepEqual(extractGroups({ groups: 'pasuntableau', realm_access: {} } as any), []);
});

test('isAdminGroup détecte le groupe admin (insensible à la casse)', () => {
  assert.equal(isAdminGroup(['admin', 'sgar']), true);
  assert.equal(isAdminGroup(['Admin']), true);
  assert.equal(isAdminGroup(['ADMIN']), true);
  assert.equal(isAdminGroup(['sgar', 'pref13']), false);
});

test('unionCollections déduplique', () => {
  assert.deepEqual(unionCollections([1, 2, 3], [2, 3, 4]).sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.deepEqual(unionCollections([], []), []);
});
