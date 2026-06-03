import { Mastra } from '@mastra/core';
import { PostgresStore } from '@mastra/pg';
import { collectionsRoute, documentsRoute, searchRoute, chatCompletionsRoute, modelsRoute, adminApiRoute, adminUiRoute, scoresRoute } from '../routes';
import { ragScorers } from './scorers/index.js';
import { AlbertGateway } from './gateways/albert';
import { ragAgent } from './agents/rag-agent';

// Storage Mastra (traces, mémoire, evals) branché sur PostgreSQL.
// DATABASE_URL est REQUIS : la base admin Postgres est désormais obligatoire (cf. db.ts,
// qui lève « DATABASE_URL is required » dès le premier accès). Sans elle, l'app s'arrête
// au démarrage avec ce message explicite. En production, compose.yml l'impose (`:?`).
const storage = process.env.DATABASE_URL
  ? new PostgresStore({ id: 'mastra-storage', connectionString: process.env.DATABASE_URL })
  : undefined;

export const mastra = new Mastra({
  ...(storage ? { storage } : {}),
  gateways: { albert: new AlbertGateway() },
  agents: { ragAgent },
  scorers: ragScorers,
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
      ...scoresRoute,
    ],
  },
});
