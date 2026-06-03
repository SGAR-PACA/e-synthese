import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as albert from '../../lib/albert-client.js';
import { getConfig } from '../../lib/config.js';

export const searchTool = createTool({
  id: 'search-rag',
  description:
    "Recherche sémantique dans la base de connaissances RAG (Albert). Retourne les chunks les plus proches de la query, avec leur nom et URL d'origine pour les citer. À utiliser systématiquement dès que la question utilisateur porte sur un sujet métier précis (ex: texte réglementaire, procédure, guide).",
  inputSchema: z.object({
    query: z.string().describe("La question ou le sujet à rechercher."),
  }),
  outputSchema: z.object({
    chunks: z.array(
      z.object({
        score: z.number(),
        content: z.string(),
        name: z.string().describe("Nom lisible du document source (à utiliser pour citer)."),
        url: z.string().describe("URL du document source si disponible, sinon chaîne vide."),
      }),
    ),
  }),
  execute: async ({ query }) => {
    const config = await getConfig();
    if (config.defaultCollections.length === 0) {
      return { chunks: [] };
    }
    const results = await albert.search({
      query,
      collections: config.defaultCollections,
      k: config.searchK,
    });
    const chunks = (results.data || [])
      .filter((r: any) => r.score >= config.minScore)
      .map((r: any) => {
        const md = r.chunk?.metadata || {};
        return {
          score: r.score,
          content: r.chunk?.content || r.content || '',
          name:
            md.document_name ||
            md.name ||
            md.title ||
            md.filename ||
            `Document ${r.chunk?.document_id ?? ''}`.trim(),
          url: md.directory_url || md.url || md.source_url || '',
        };
      });
    return { chunks };
  },
});
