// API admin — mapping « groupe Keycloak → collections » (Chantier 2).
// Piloté depuis l'écran admin ; réservé aux admins (session cookie + CSRF).
import { registerApiRoute } from '@mastra/core/server';
import { requireAdmin, verifyCsrf } from '../lib/middleware.js';
import { listGroupCollections, setGroupCollections, deleteGroupMapping } from '../lib/db.js';

// Nom de groupe : mêmes valeurs que dans Keycloak (après normalisation du token,
// sans slash de tête). On borne et on refuse les caractères de contrôle.
const GROUP_RE = /^[A-Za-z0-9 _.\-\/]{1,128}$/;

function parseCollectionIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > 1000) return null;
  const out: number[] = [];
  for (const v of value) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n <= 0) return null;
    out.push(n);
  }
  return [...new Set(out)];
}

export const groupCollectionsRoute = [
  // Liste tous les mappings, regroupés par nom de groupe.
  registerApiRoute('/v1/group-collections', {
    method: 'GET',
    handler: async (c) => {
      const auth = await requireAdmin(c);
      if (auth instanceof Response) return auth;
      const rows = await listGroupCollections();
      const groups: Record<string, number[]> = {};
      for (const r of rows) {
        (groups[r.group_name] ||= []).push(r.collection_id);
      }
      return c.json({ groups });
    },
  }),

  // Remplace le jeu de collections d'un groupe. Body : { collectionIds: number[] }.
  registerApiRoute('/v1/group-collections/:group', {
    method: 'PUT',
    handler: async (c) => {
      const auth = await requireAdmin(c);
      if (auth instanceof Response) return auth;
      const csrfError = verifyCsrf(c, auth);
      if (csrfError) return csrfError;

      const group = c.req.param('group');
      if (!GROUP_RE.test(group)) return c.json({ error: 'Invalid group name' }, 400);

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
      const collectionIds = parseCollectionIds((body as { collectionIds?: unknown })?.collectionIds);
      if (collectionIds === null) return c.json({ error: 'collectionIds must be an array of positive integers' }, 400);

      await setGroupCollections(group, collectionIds);
      return c.json({ ok: true, group, collectionIds });
    },
  }),

  // Supprime entièrement le mapping d'un groupe.
  registerApiRoute('/v1/group-collections/:group', {
    method: 'DELETE',
    handler: async (c) => {
      const auth = await requireAdmin(c);
      if (auth instanceof Response) return auth;
      const csrfError = verifyCsrf(c, auth);
      if (csrfError) return csrfError;

      const group = c.req.param('group');
      if (!GROUP_RE.test(group)) return c.json({ error: 'Invalid group name' }, 400);

      await deleteGroupMapping(group);
      return c.json({ ok: true });
    },
  }),
];
