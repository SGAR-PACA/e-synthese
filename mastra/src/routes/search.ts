import { registerApiRoute } from '@mastra/core/server';
import * as albert from '../lib/albert-client';
import { requireApiKey } from '../lib/middleware.js';

export const searchRoute = [
  registerApiRoute('/v1/search', {
    method: 'POST',
    handler: async (c) => {
      const unauthorized = requireApiKey(c);
      if (unauthorized) return unauthorized;
      const body = await c.req.json();
      const data = await albert.search(body);
      return c.json(data);
    },
  }),
  registerApiRoute('/v1/rerank', {
    method: 'POST',
    handler: async (c) => {
      const unauthorized = requireApiKey(c);
      if (unauthorized) return unauthorized;
      const body = await c.req.json();
      const data = await albert.rerank(body);
      return c.json(data);
    },
  }),
  registerApiRoute('/v1/embeddings', {
    method: 'POST',
    handler: async (c) => {
      const unauthorized = requireApiKey(c);
      if (unauthorized) return unauthorized;
      const body = await c.req.json();
      const data = await albert.createEmbeddings(body);
      return c.json(data);
    },
  }),
];
