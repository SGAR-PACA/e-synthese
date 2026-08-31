// Orchestrateur de notation. Extrait les chunks utilisés (depuis le run de l'agent, repli :
// re-recherche), peut lancer une recherche élargie pour retrieval_quality, lance le juge en
// UN SEUL appel (les 4 métriques d'un coup), puis persiste rag_runs + rag_scores.
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
import { resolveRagSystemPrompt } from '../pipeline/system-prompt.js';
import * as albert from '../../lib/albert-client.js';
import { getConfig } from '../../lib/config.js';
import { withPriority } from '../../lib/albert-limiter.js';
import { insertRagRun, insertRagScores, updateRagRunWideK, type RagChunk } from '../../lib/db.js';
import { getAllCollectionIds } from '../../lib/collections-cache.js';

const RATE_DELAY_MS = Number(process.env.EVAL_RATE_DELAY_MS || 2000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isJudgeTransient = (err: any) => err?.status === 503 || /503|temporarily unavailable|model is too busy/i.test(String(err?.message || err));

async function withRetry<T>(fn: () => Promise<T>, label: string, max = 4): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // La notation est non bloquante : on ne réessaie jamais un 429, car cela
      // consommerait encore des créneaux déjà rares. Un seul retry est réservé
      // à un 503 transitoire du modèle.
      if (!isJudgeTransient(err) || attempt === max) throw err;
      const wait = RATE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[eval] erreur transitoire sur ${label}, retry ${attempt + 1}/${max} dans ${wait}ms`);
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
async function resolveScoreCollections(allowedCollections?: number[] | null): Promise<number[]> {
  const config = await getConfig();
  if (allowedCollections === null) return getAllCollectionIds();
  if (Array.isArray(allowedCollections)) return allowedCollections;
  return config.defaultCollections;
}

async function fallbackSearch(question: string, allowedCollections?: number[] | null): Promise<RagChunk[]> {
  const config = await getConfig();
  const collections = await resolveScoreCollections(allowedCollections);
  if (!collections.length) return [];
  const res = await albert.search({ query: question, collections, k: config.searchK });
  return (res.data || []).filter((r: any) => r.score >= config.minScore).map(normalizeHit);
}

// Vivier élargi pour retrieval_quality : recherche large, SANS filtre min_score, SANS rerank.
async function wideSearch(question: string, allowedCollections?: number[] | null): Promise<RagChunk[]> {
  const config = await getConfig();
  const collections = await resolveScoreCollections(allowedCollections);
  if (!collections.length) return [];
  const res = await albert.search({ query: question, collections, k: config.evalWideK });
  return (res.data || []).map(normalizeHit);
}

// UN SEUL appel au modèle juge : renvoie le texte brut de la complétion (JSON attendu).
async function callJudge(
  messages: Array<{ role: string; content: string }>,
  model: string,
  config: Awaited<ReturnType<typeof getConfig>>,
): Promise<string> {
  const res = await albert.chatCompletions({
    model,
    messages,
    temperature: config.judgeTemperature,
    max_completion_tokens: config.judgeMaxCompletionTokens,
    n: 1,
    response_format: { type: 'json_object' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err: any = new Error(`Albert juge ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    if (res.status === 429) err.message = `rate limit 429 juge: ${err.message}`;
    throw err;
  }
  const json: any = await res.json();
  return json?.choices?.[0]?.message?.content ?? '';
}

export interface ScoreRunArgs {
  // Fourni pour noter un run déjà journalisé (mode admin manuel). Sans lui,
  // scoreRun crée un nouveau run comme auparavant (/v1/score et banc avec judge).
  runId?: number;
  question: string;
  answer: string;
  usedChunks?: RagChunk[];   // mode C : fourni par l'appelant
  agentResult?: any;         // mode A : run de l'agent (pour extraire les chunks)
  source: 'live' | 'on-demand' | 'test';
  genModel: string | null;
  // Même périmètre que la réponse évaluée : null = admin/non restreint,
  // tableau = collections autorisées, undefined = ancien mode / défaut configuré.
  allowedCollections?: number[] | null;
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
  let runId = args.runId ?? null;

  // 1. Chunks utilisés
  let used: RagChunk[] = args.usedChunks ?? [];
  if (!used.length && args.agentResult) used = await extractUsedChunks(args.agentResult);
  if (!used.length) used = await fallbackSearch(args.question, args.allowedCollections);

  const refusal = isRefusal(args.answer);

  // 2. Court-circuit : conversationnel pur (0 chunk et pas un refus explicite) → rien à évaluer.
  if (!used.length && !refusal) return { runId, scores: [], isRefusal: false, used, wide: [] };

  // 3. Vivier élargi (retrieval_quality) — inutile si refus.
  // Le mode live évite par défaut une seconde recherche Albert. Le vivier élargi
  // reste activable dans l'admin pour les audits complets du retrieval.
  const wide = refusal || !config.evalWideSearch ? [] : await wideSearch(args.question, args.allowedCollections);

  // 4. Un SEUL appel juge pour toutes les métriques attendues.
  const instructions = await resolveRagSystemPrompt();
  const input = {
    question: args.question,
    answer: args.answer,
    contexts: used.map((c) => c.content),
    wideContexts: wide.map((c) => c.content),
    instructions,
  };

  let scores: ScoreResult[];
  try {
    const text = await withRetry(
      () => callJudge(buildJudgeMessages(input, refusal), config.judgeModel, config),
      'juge fusionné',
      1,
    );
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
  if (runId == null) {
    runId = await insertRagRun({
      source: args.source,
      question: args.question,
      answer: args.answer,
      usedChunks: used,
      wideK: wide.length,
      genModel: args.genModel,
      isRefusal: refusal,
    });
  } else {
    // Une notation manuelle peut avoir activé la recherche élargie après la
    // création du log : conserver cette information sur le run historique.
    await updateRagRunWideK(runId, wide.length);
  }
  await insertRagScores(runId, scores.map((s) => ({ ...s, judgeModel: config.judgeModel })));

  return { runId, scores, isRefusal: refusal, used, wide };
}
