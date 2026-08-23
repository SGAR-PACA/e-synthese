// Routes d'évaluation :
//   GET  /admin/scores  → moyennes (SQL) + logs filtrables + détail avec justification (admin)
//   POST /admin/scores/:runId/judge → note manuellement un log sans scores (admin)
//   POST /v1/score      → note une réponse à la demande (clé proxy) — mode C

import { registerApiRoute } from '@mastra/core/server';
import { requireAdmin, requireApiKey, verifyCsrf, getClientIp } from '../lib/middleware.js';
import { getRagRunById, getScoreAverages, getScores, hasRagScores, logAudit, type ScoreFilters, type RagChunk } from '../lib/db.js';
import { scoreRun } from '../mastra/scorers/run.js';

function parseFilters(q: Record<string, string>): ScoreFilters {
  const num = (v?: string) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const scored = q.scored === 'true' || q.scored === '1' ? true : q.scored === 'false' || q.scored === '0' ? false : undefined;
  return {
    metric: q.metric || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    minScore: num(q.minScore),
    maxScore: num(q.maxScore),
    source: q.source || undefined,
    scored,
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

  registerApiRoute('/admin/scores/:runId/judge', {
    method: 'POST',
    handler: async (c) => {
      const auth = await requireAdmin(c);
      if (auth instanceof Response) return auth;
      const csrfError = verifyCsrf(c, auth);
      if (csrfError) return csrfError;

      const runId = Number(c.req.param('runId'));
      if (!Number.isInteger(runId) || runId <= 0) {
        return c.json({ error: 'runId invalide' }, 400);
      }

      const run = await getRagRunById(runId);
      if (!run) return c.json({ error: 'Run introuvable' }, 404);
      if (await hasRagScores(runId)) {
        return c.json({ error: 'Ce run possède déjà une notation' }, 409);
      }

      try {
        // L'action est réservée à l'admin. Le judge utilise les passages
        // réellement journalisés ; la recherche élargie reste gouvernée par
        // la configuration (désactivée par défaut pour ne pas ajouter d'appel).
        const result = await scoreRun({
          runId,
          question: run.question,
          answer: run.answer,
          usedChunks: run.used_chunks,
          source: run.source,
          genModel: run.gen_model,
          allowedCollections: null,
        });
        if (!result.scores.length) {
          return c.json({ error: 'Ce run ne contient aucun passage évaluable' }, 422);
        }
        await logAudit(getClientIp(c), 'MANUAL_JUDGE', auth.user.id, `run_id=${runId}`);
        return c.json({ runId, scores: result.scores, wideK: result.wide.length });
      } catch (err: any) {
        return c.json({ error: `Notation manuelle échouée : ${err?.message || err}` }, 500);
      }
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
