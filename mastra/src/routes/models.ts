import { registerApiRoute } from '@mastra/core/server';
import { requireApiKey } from '../lib/middleware.js';

export const modelsRoute = [
  registerApiRoute('/v1/models', {
    method: 'GET',
    handler: async (c) => {
      const unauthorized = requireApiKey(c);
      if (unauthorized) return unauthorized;
      return c.json({
        object: 'list',
        data: [
          {
            id: 'e-synthese-rag',
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'SGAR PACA - E-Synthese',
            max_context_length: 128000,
          },
        ],
      });
    },
  }),
];
