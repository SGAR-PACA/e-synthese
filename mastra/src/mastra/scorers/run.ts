// Orchestrateur de notation. Extrait les chunks utilisés (depuis le run de l'agent, repli :
// re-recherche), relance une recherche élargie pour retrieval_quality, lance le juge en UN
// SEUL appel (les 4 métriques d'un coup), puis persiste rag_runs + rag_scores.
// JAMAIS bloquant pour la réponse servie. Tout le trafic Albert y passe en priorité `low`
// (via le limiteur global) : l'éval cède toujours le passage au chat interactif.

import {
  buildJudgeMessages,
  parseMergedJudgeResponse,
  expectedMetrics,
  METRIC_NAMES,
  type ScoreResult,
} from './index.js';
import { isRefusal } from './refusal.js';
import { resolveInstructions } from '../agents/rag-agent.js';
import * as albert from '../../lib/albert-client.js';
import { getConfig } from '../../lib/config.js';
import { withPriority } from '../../lib/albert-limiter.js';
import { insertRagRun, insertRagScores, type RagChunk } from '../../lib/db.js';

const RATE_DELAY_MS = Number(process.env.EVAL_RATE_DELAY_MS || 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (err: any) => /rate.?limit|429|capacity exceeded/i.test(String(err?.message || err));

async function withRetry<T>(fn: () => Promise<T>, label: string, max = 4): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimit(err) || attempt === max) throw err;
      const wait = RATE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[eval] rate limit sur ${label}, retry ${attempt + 1}/${max} dans ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

const maybe = async (v: any) => (v && typeof v.then === 'function' ? await v : v);

// Albert renvoie des hits { score, chunk:{content, metadata} } ; on les normalise comme search.ts.
function normalizeHit(r: any): RagChunk {
  const md = r.chunk?.metadata || {};
  return {
    score: r.score ?? 0,
    content: r.chunk?.content || r.content || '',
    name: md.document_name || md.name || md.title || md.filename || `Document ${r.chunk?.document_id ?? ''}`.trim(),
    url: md.directory_url || md.url || md.source_url || '',
  };
}

// Rassemble les tool results d'un run d'agent (tolérant aux formes v4/v5 et aux promesses).
async function collectToolResults(result: any): Promise<any[]> {
  const out: any[] = [];
  const top = await maybe(result?.toolResults);
  if (Array.isArray(top)) out.push(...top);
  const steps = await maybe(result?.steps);
  if (Array.isArray(steps)) {
    for (const s of steps) {
      const tr = await maybe(s?.toolResults);
      if (Array.isArray(tr)) out.push(...tr);
    }
  }
  return out;
}

// Chunks réellement vus par l'agent : on privilégie la sortie de rerank-chunks, repli search-rag.
function toolNameOf(t: any): string | undefined {
  return t?.payload?.toolName ?? t?.toolName;
}
function chunksOf(t: any): any {
  return (
    t?.payload?.result?.chunks ??
    t?.payload?.output?.chunks ??
    t?.result?.chunks ??
    t?.output?.chunks
  );
}
async function extractUsedChunks(result: any): Promise<RagChunk[]> {
  const trs = await collectToolResults(result);
  const byTool = (name: string) => trs.filter((t) => toolNameOf(t) === name);
  const pick = byTool('rerank-chunks').pop() || byTool('search-rag').pop();
  const chunks = pick ? chunksOf(pick) : [];
  return Array.isArray(chunks) ? chunks : [];
}

// Repli si l'extraction ne donne rien : on relit la recherche standard (mêmes k/min_score).
async function fallbackSearch(question: string): Promise<RagChunk[]> {
  const config = await getConfig();
  if (!config.defaultCollections.length) return [];
  const res = await albert.search({ query: question, collections: config.defaultCollections, k: config.searchK });
  return (res.data || []).filter((r: any) => r.score >= config.minScore).map(normalizeHit);
}

// Vivier élargi pour retrieval_quality : recherche large, SANS filtre min_score, SANS rerank.
async function wideSearch(question: string): Promise<RagChunk[]> {
  const config = await getConfig();
  if (!config.defaultCollections.length) return [];
  const res = await albert.search({ query: question, collections: config.defaultCollections, k: config.evalWideK });
  return (res.data || []).map(normalizeHit);
}

// UN SEUL appel au modèle juge : renvoie le texte brut de la complétion (JSON attendu).
async function callJudge(messages: Array<{ role: string; content: string }>, model: string): Promise<string> {
  const res = await albert.chatCompletions({ model, messages, temperature: 0 });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err: any = new Error(`Albert juge ${res.status}: ${body.slice(0, 200)}`);
    if (res.status === 429 || res.status === 503) err.message = `rate limit 429 juge: ${err.message}`;
    throw err;
  }
  const json: any = await res.json();
  return json?.choices?.[0]?.message?.content ?? '';
}

export interface ScoreRunArgs {
  question: string;
  answer: string;
  usedChunks?: RagChunk[];   // mode C : fourni par l'appelant
  agentResult?: any;         // mode A : run de l'agent (pour extraire les chunks)
  source: 'live' | 'on-demand' | 'test';
  genModel: string | null;
}

export interface ScoreRunResult {
  runId: number | null;
  scores: ScoreResult[];
  isRefusal: boolean;
  used: RagChunk[];   // chunks utilisés (pour le banc de test / debug)
  wide: RagChunk[];   // vivier élargi (retrieval_quality)
}

export async function scoreRun(args: ScoreRunArgs): Promise<ScoreRunResult> {
  // Toute la notation s'exécute en priorité BASSE : elle cède le pas au chat interactif
  // sur la clé Albert partagée (limiteur global).
  return withPriority('low', () => scoreRunInner(args));
}

async function scoreRunInner(args: ScoreRunArgs): Promise<ScoreRunResult> {
  const config = await getConfig();

  // 1. Chunks utilisés
  let used: RagChunk[] = args.usedChunks ?? [];
  if (!used.length && args.agentResult) used = await extractUsedChunks(args.agentResult);
  if (!used.length) used = await fallbackSearch(args.question);

  const refusal = isRefusal(args.answer);

  // 2. Court-circuit : conversationnel pur (0 chunk et pas un refus explicite) → rien à évaluer.
  if (!used.length && !refusal) return { runId: null, scores: [], isRefusal: false, used, wide: [] };

  // 3. Vivier élargi (retrieval_quality) — inutile si refus.
  const wide = refusal ? [] : await wideSearch(args.question);

  // 4. Un SEUL appel juge pour toutes les métriques attendues.
  const instructions = await resolveInstructions();
  const input = {
    question: args.question,
    answer: args.answer,
    contexts: used.map((c) => c.content),
    wideContexts: wide.map((c) => c.content),
    instructions,
  };

  let scores: ScoreResult[];
  try {
    const text = await withRetry(() => callJudge(buildJudgeMessages(input, refusal), config.judgeModel), 'juge fusionné');
    scores = parseMergedJudgeResponse(text, refusal);
  } catch (err: any) {
    // Échec dur du juge : on persiste des notes 0 explicites plutôt que de perdre le run.
    scores = expectedMetrics(refusal).map((k) => ({
      metric: METRIC_NAMES[k],
      score: 0,
      reason: `erreur juge : ${err?.message || err}`,
    }));
  }

  // 5. Persistance.
  const runId = await insertRagRun({
    source: args.source,
    question: args.question,
    answer: args.answer,
    usedChunks: used,
    wideK: wide.length,
    genModel: args.genModel,
    isRefusal: refusal,
  });
  await insertRagScores(runId, scores.map((s) => ({ ...s, judgeModel: config.judgeModel })));

  return { runId, scores, isRefusal: refusal, used, wide };
}
