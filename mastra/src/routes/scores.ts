// Routes d'évaluation :
//   GET  /admin/scores  → moyennes (SQL) + liste filtrable + détail avec justification (admin)
//   POST /v1/score      → note une réponse à la demande (clé proxy) — mode C

import { registerApiRoute } from '@mastra/core/server';
import { requireAdmin, requireApiKey } from '../lib/middleware.js';
import { getScoreAverages, getScores, type ScoreFilters, type RagChunk } from '../lib/db.js';
import { scoreRun } from '../mastra/scorers/run.js';

function parseFilters(q: Record<string, string>): ScoreFilters {
  const num = (v?: string) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    metric: q.metric || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    minScore: num(q.minScore),
    maxScore: num(q.maxScore),
    source: q.source || undefined,
    limit: Math.min(num(q.limit) ?? 50, 200),
    offset: num(q.offset) ?? 0,
  };
}

export const scoresRoute = [
  registerApiRoute('/admin/scores', {
    method: 'GET',
    handler: async (c) => {
      const auth = await requireAdmin(c);
      if (auth instanceof Response) return auth;
      const filters = parseFilters(c.req.query());
      const [averages, page] = await Promise.all([getScoreAverages(filters), getScores(filters)]);
      return c.json({ averages, count: page.count, items: page.items });
    },
  }),

  registerApiRoute('/v1/score', {
    method: 'POST',
    handler: async (c) => {
      const unauthorized = requireApiKey(c);
      if (unauthorized) return unauthorized;

      const { question, answer, contexts } = await c.req.json();
      if (!question || !answer) return c.json({ error: 'question et answer requis' }, 400);

      const usedChunks: RagChunk[] = Array.isArray(contexts)
        ? contexts.map((ctx: any) =>
            typeof ctx === 'string'
              ? { name: '', content: ctx, score: 0, url: '' }
              : { name: ctx?.name ?? '', content: ctx?.content ?? '', score: Number(ctx?.score ?? 0), url: ctx?.url ?? '' },
          )
        : [];

      try {
        const res = await scoreRun({
          question: String(question),
          answer: String(answer),
          usedChunks: usedChunks.length ? usedChunks : undefined,
          source: 'on-demand',
          genModel: null,
        });
        return c.json({ scores: res.scores, is_refusal: res.isRefusal });
      } catch (err: any) {
        return c.json({ error: `Notation échouée : ${err?.message || err}` }, 500);
      }
    },
  }),
];
