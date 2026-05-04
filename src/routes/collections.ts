import { registerApiRoute } from '@mastra/core/server';
import * as albert from '../lib/albert-client';
import { requireAuth, requireAdmin, verifyCsrf } from '../lib/middleware.js';

export const collectionsRoute = [
  registerApiRoute('/v1/collections', {
    method: 'GET',
    handler: async (c) => {
      const authCtx = requireAuth(c);
      if (authCtx instanceof Response) return authCtx;
      const data = await albert.listCollections();
      if (authCtx.user.role === 'editor' && data.data) {
        data.data = data.data.filter((col: any) => authCtx.collections.includes(col.id));
      }
      return c.json(data);
    },
  }),
  registerApiRoute('/v1/collections', {
    method: 'POST',
    handler: async (c) => {
      const authCtx = requireAdmin(c);
      if (authCtx instanceof Response) return authCtx;
      const csrfError = verifyCsrf(c, authCtx);
      if (csrfError) return csrfError;
      const body = await c.req.json();
      const data = await albert.createCollection(body);
      return c.json(data);
    },
  }),
  registerApiRoute('/v1/collections/:collectionId', {
    method: 'GET',
    handler: async (c) => {
      const authCtx = requireAuth(c);
      if (authCtx instanceof Response) return authCtx;
      const collectionId = c.req.param('collectionId');
      if (authCtx.user.role === 'editor' && !authCtx.collections.includes(parseInt(collectionId, 10))) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const data = await albert.getCollection(collectionId);
      return c.json(data);
    },
  }),
  registerApiRoute('/v1/collections/:collectionId', {
    method: 'DELETE',
    handler: async (c) => {
      const authCtx = requireAdmin(c);
      if (authCtx instanceof Response) return authCtx;
      const csrfError = verifyCsrf(c, authCtx);
      if (csrfError) return csrfError;
      const collectionId = c.req.param('collectionId');
      const data = await albert.deleteCollection(collectionId);
      return c.json(data);
    },
  }),
];
