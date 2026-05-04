import { Mastra } from '@mastra/core';
import { collectionsRoute, documentsRoute, searchRoute, chatCompletionsRoute, modelsRoute, adminApiRoute, adminUiRoute } from '../routes';
import { AlbertGateway } from './gateways/albert';
import { ragAgent } from './agents/rag-agent';

export const mastra = new Mastra({
  gateways: { albert: new AlbertGateway() },
  agents: { ragAgent },
  server: {
    port: Number(process.env.PORT) || 4111,
    apiRoutes: [
      ...chatCompletionsRoute,
      ...modelsRoute,
      ...collectionsRoute,
      ...documentsRoute,
      ...searchRoute,
      ...adminApiRoute,
      ...adminUiRoute,
    ],
  },
});
