// mastra/test/oidc-merge-groups.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTokenGroups } from '../src/lib/oidc.ts';

// Le cas réel : l'id_token du client `mastra-sources` n'a PAS les rôles realm,
// mais l'access_token porte `realm_access.roles: ["Sgar"]`. La visionneuse doit
// quand même voir « Sgar » → sinon 403 sur une collection pourtant autorisée.
test('récupère le rôle depuis l\'access_token quand l\'id_token ne l\'a pas', () => {
  const idPayload = { sub: 'u1' } as any; // aucun groupe/rôle
  const accessPayload = { realm_access: { roles: ['Sgar', 'offline_access'] } } as any;
  const groups = mergeTokenGroups(idPayload, accessPayload);
  assert.ok(groups.includes('Sgar'), 'le rôle Sgar de l\'access_token est repris');
});

test('sans access_token : garde les groupes de l\'id_token', () => {
  const idPayload = { sub: 'u1', groups: ['/sgar'] } as any;
  assert.deepEqual(mergeTokenGroups(idPayload, null), ['sgar']);
  assert.deepEqual(mergeTokenGroups(idPayload), ['sgar']);
});

test('fusionne et déduplique id_token + access_token', () => {
  const idPayload = { groups: ['/sgar'] } as any;
  const accessPayload = { realm_access: { roles: ['Sgar', 'sgar'] }, groups: ['/pref13'] } as any;
  const groups = mergeTokenGroups(idPayload, accessPayload);
  assert.deepEqual([...groups].sort(), ['Sgar', 'pref13', 'sgar']);
});
