// Orchestrateur de notation. Extrait les chunks utilisés (depuis le run de l'agent, repli :
// re-recherche), relance une recherche élargie pour le scorer #4, lance les juges (séquentiel +
// retry/backoff), puis persiste rag_runs + rag_scores. JAMAIS bloquant pour la réponse servie.

import { ragScorers, METRIC_NAMES } from './index.js';
import { JUDGE_MODEL_ID } from './judge.js';
import { isRefusal } from './refusal.js';
import { resolveInstructions } from '../agents/rag-agent.js';
import * as albert from '../../lib/albert-client.js';
import { getConfig } from '../../lib/config.js';
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

// scorer.run() de Mastra a besoin de l'instance Mastra (résolution du juge). On l'enregistre
// une fois, paresseusement (import dynamique pour éviter le cycle route → run → mastra/index).
let registered = false;
async function ensureRegistered(): Promise<void> {
  if (registered) return;
  const { mastra } = await import('../index.js');
  for (const s of Object.values(ragScorers)) (s as any).__registerMastra?.(mastra);
  registered = true;
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
// Mastra v1 imbrique les tool results sous `.payload` ({ payload: { toolName, result } }) ;
// d'anciennes formes les exposaient au niveau racine. On gère les deux pour être robuste.
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

// Vivier élargi pour le scorer #4 : recherche large, SANS filtre min_score, SANS rerank.
async function wideSearch(question: string): Promise<RagChunk[]> {
  const config = await getConfig();
  if (!config.defaultCollections.length) return [];
  const res = await albert.search({ query: question, collections: config.defaultCollections, k: config.evalWideK });
  return (res.data || []).map(normalizeHit);
}

export interface ScoreResult { metric: string; score: number; reason: string }

export interface ScoreRunArgs {
  question: string;
  answer: string;
  usedChunks?: RagChunk[];   // mode C : fourni par l'appelant
  agentResult?: any;         // mode A : run de l'agent (pour extraire les chunks)
  source: 'live' | 'on-demand' | 'test';
  genModel: string | null;
}

export async function scoreRun(args: ScoreRunArgs): Promise<{ runId: number | null; scores: ScoreResult[]; isRefusal: boolean }> {
  // 1. Chunks utilisés
  let used: RagChunk[] = args.usedChunks ?? [];
  if (!used.length && args.agentResult) used = await extractUsedChunks(args.agentResult);
  if (!used.length) used = await fallbackSearch(args.question);

  const refusal = isRefusal(args.answer);

  // 2. Court-circuit : conversationnel pur (0 chunk et pas un refus explicite) → rien à évaluer.
  if (!used.length && !refusal) return { runId: null, scores: [], isRefusal: false };

  // 3. Vivier élargi (#4) — inutile si refus.
  const wide = refusal ? [] : await wideSearch(args.question);

  // 4. Input des scorers.
  await ensureRegistered();
  const instructions = await resolveInstructions();
  const input = {
    question: args.question,
    contexts: used.map((c) => c.content),
    wideContexts: wide.map((c) => c.content),
    instructions,
  };
  const output = { answer: args.answer };

  // 5. Sélection des scorers : sur un refus, seule la conformité au prompt système compte.
  const selected: Array<[keyof typeof ragScorers]> = refusal
    ? [['systemPrompt']]
    : [['systemPrompt'], ['faithfulness'], ['completeness'], ['retrievalQuality']];

  const scores: ScoreResult[] = [];
  for (const [key] of selected) {
    const metric = METRIC_NAMES[key];
    try {
      const r: any = await withRetry(() => (ragScorers[key] as any).run({ input, output }), `scorer ${metric}`);
      scores.push({ metric, score: Number(r?.score ?? 0), reason: String(r?.reason ?? '') });
    } catch (err: any) {
      scores.push({ metric, score: 0, reason: `erreur scorer : ${err?.message || err}` });
    }
    await sleep(RATE_DELAY_MS);
  }

  // 6. Persistance.
  const runId = await insertRagRun({
    source: args.source,
    question: args.question,
    answer: args.answer,
    usedChunks: used,
    wideK: wide.length,
    genModel: args.genModel,
    isRefusal: refusal,
  });
  await insertRagScores(runId, scores.map((s) => ({ ...s, judgeModel: JUDGE_MODEL_ID })));

  return { runId, scores, isRefusal: refusal };
}
