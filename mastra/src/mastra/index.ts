import { Mastra } from '@mastra/core';
import { startDocumentWorker } from '../lib/document-worker.js';
import { PostgresStore } from '@mastra/pg';
import { collectionsRoute, groupCollectionsRoute, documentsRoute, searchRoute, chatCompletionsRoute, modelsRoute, adminApiRoute, adminUiRoute, scoresRoute, sourcesAuthRoute, sourcesRoute, sourcesAssetsRoute, ratingsRoute } from '../routes';
import { ragScorers } from './scorers/index.js';
import { AlbertGateway } from './gateways/albert';
import { ragAgent } from './agents/rag-agent';
import { plannerAgent } from './pipeline/planner.js';
import { writerAgent } from './pipeline/writer.js';

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
  agents: { ragAgent, plannerAgent, writerAgent },
  scorers: ragScorers,
  server: {
    port: Number(process.env.PORT) || 4111,
    // Autoriser l'origine du front à appeler Mastra (requêtes cross-origin avec Authorization).
    cors: {
      origin: process.env.MASTRA_RATING_CORS_ORIGIN
        ? process.env.MASTRA_RATING_CORS_ORIGIN.split(',').map((o) => o.trim())
        : [],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      credentials: false,
    },
    apiRoutes: [
      ...chatCompletionsRoute,
      ...modelsRoute,
      ...collectionsRoute,
      ...groupCollectionsRoute,
      ...documentsRoute,
      ...searchRoute,
      ...adminApiRoute,
      ...adminUiRoute,
      ...scoresRoute,
      ...sourcesAuthRoute,
      ...sourcesRoute,
      ...sourcesAssetsRoute,
      ...ratingsRoute,
    ],
  },
});

// Démarre le worker d'ingestion (OCR + stockage + Albert) si la config S3/OCR est présente.
if (process.env.S3_DOCS_BUCKET && process.env.OCR_SERVICE_URL) {
  startDocumentWorker();
}
