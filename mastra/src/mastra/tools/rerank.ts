import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as albert from '../../lib/albert-client.js';
import { getConfig } from '../../lib/config.js';

const chunkSchema = z.object({
  score: z.number(),
  content: z.string(),
  name: z.string(),
  url: z.string(),
});

export const rerankTool = createTool({
  id: 'rerank-chunks',
  description:
    "Reclasse une liste de chunks par pertinence vraie vis-à-vis d'une query (via Albert reranker BAAI/bge-reranker-v2-m3). À utiliser après search-rag pour obtenir les meilleurs extraits en premier. Préserve le nom et l'URL d'origine de chaque chunk.",
  inputSchema: z.object({
    query: z.string().describe("La question d'origine utilisée pour le classement."),
    chunks: z.array(chunkSchema).describe('Les chunks à reclasser, issus de search-rag.'),
  }),
  outputSchema: z.object({
    chunks: z.array(chunkSchema),
  }),
  execute: async ({ query, chunks }) => {
    if (!chunks.length) return { chunks: [] };
    const config = getConfig();
    const rerankResults = await albert.rerank({
      query,
      documents: chunks.map((c: { content: string }) => c.content),
    });
    if (!rerankResults.results) return { chunks };
    const reranked = rerankResults.results
      .sort((a: any, b: any) => b.relevance_score - a.relevance_score)
      .slice(0, config.searchK)
      .map((r: any) => {
        const original = chunks[r.index];
        return {
          score: r.relevance_score,
          content: original?.content || '',
          name: original?.name || '',
          url: original?.url || '',
        };
      });
    return { chunks: reranked };
  },
});
