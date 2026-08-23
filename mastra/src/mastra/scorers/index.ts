// Notation RAG « LLM-as-judge » — version FUSIONNÉE (un seul appel juge par réponse).
//
// Avant : 4 appels LLM séparés (system_prompt, faithfulness, completeness, retrieval_quality).
// Maintenant : UN prompt demande les 4 notes d'un coup en un JSON unique → 1 requête Albert
// (−75 %). Sur un refus, seule la conformité au prompt système est demandée (les autres
// dimensions pénaliseraient injustement l'absence de source voulue). Voir scorers/refusal.ts.
//
// Ce module ne contient QUE des fonctions PURES (construction du prompt + parsing/validation),
// testables sans réseau. L'orchestration (recherche, appel Albert, persistance) est dans run.ts.

import { z } from 'zod';
import { JUDGE_INSTRUCTIONS } from './judge.js';

export const scorerInputSchema = z.object({
  question: z.string(),
  answer: z.string(),                 // réponse de l'assistant à évaluer
  contexts: z.array(z.string()),      // chunks utilisés par l'agent
  wideContexts: z.array(z.string()),  // vivier élargi (retrieval_quality)
  instructions: z.string(),           // prompt système de l'agent
});
export type ScorerInput = z.infer<typeof scorerInputSchema>;

// Clés internes → nom de métrique persisté (colonne rag_scores.metric). Ordre = ordre d'affichage.
export const METRIC_NAMES = {
  systemPrompt: 'system_prompt',
  faithfulness: 'faithfulness',
  completeness: 'completeness',
  retrievalQuality: 'retrieval_quality',
} as const;

export type MetricKey = keyof typeof METRIC_NAMES;

// Une note par métrique dans la réponse du juge.
const metricScoreSchema = z.object({
  score: z.coerce.number().min(0).max(1),
  reason: z.string().default(''),
});

// Schéma de la réponse fusionnée : chaque métrique est optionnelle au parsing (le juge peut
// en omettre), on comble ensuite les manquantes par une note d'erreur explicite.
const mergedResponseSchema = z.object({
  system_prompt: metricScoreSchema.optional(),
  faithfulness: metricScoreSchema.optional(),
  completeness: metricScoreSchema.optional(),
  retrieval_quality: metricScoreSchema.optional(),
});

const joinCtx = (arr?: string[]) => (arr && arr.length ? arr.join('\n---\n') : '(aucun)');

// Métriques attendues selon le cas (refus = system_prompt seul).
export function expectedMetrics(refusal: boolean): MetricKey[] {
  return refusal ? ['systemPrompt'] : ['systemPrompt', 'faithfulness', 'completeness', 'retrievalQuality'];
}

// Construit le prompt UTILISATEUR unique demandant toutes les notes en un JSON.
export function buildMergedJudgePrompt(input: ScorerInput, refusal: boolean): string {
  const blocks: string[] = [];

  blocks.push(
    `QUESTION DE L'UTILISATEUR :\n${input.question}\n`,
    `RÉPONSE DE L'ASSISTANT À ÉVALUER :\n${input.answer ?? ''}\n`,
  );

  // Critère 1 — conformité au prompt système (toujours évalué).
  blocks.push(
    `RÈGLES IMPOSÉES À L'ASSISTANT (prompt système) :\n${input.instructions}\n`,
    'CRITÈRE "system_prompt" — Note 1 si TOUTES les règles sont respectées (format Markdown, ' +
      'bloc « Sources : » bien formé en fin de réponse, AUCUN marqueur inline interdit type ' +
      '【Source X】 ou [1], langue française, refus propre si l\'information manque). Baisse la ' +
      'note pour chaque règle violée.',
  );

  if (!refusal) {
    blocks.push(
      `\nCHUNKS UTILISÉS PAR L'ASSISTANT :\n${joinCtx(input.contexts)}\n`,
      'CRITÈRE "faithfulness" — Note 1 si chaque affirmation de la réponse est vérifiable dans ' +
        'les chunks utilisés ; baisse si la réponse invente ou affirme des choses absentes des chunks.',
      'CRITÈRE "completeness" — Note 1 si la réponse exploite TOUTE l\'information utile PRÉSENTE ' +
        'DANS LES CHUNKS utilisés ; baisse si elle omet des éléments importants qui y figuraient. ' +
        "N'évalue pas ce qui n'est pas dans les chunks.",
      input.wideContexts.length
        ? `\nVIVIER ÉLARGI (recherche large, chunks candidats non forcément utilisés) :\n${joinCtx(input.wideContexts)}\n`
        : '\nVIVIER ÉLARGI : non chargé pour économiser un appel Albert ; seuls les chunks utilisés sont disponibles.\n',
      input.wideContexts.length
        ? 'CRITÈRE "retrieval_quality" — Note 1 si le vivier élargi ne contient PAS d\'information ' +
          'importante absente de la réponse ; baisse si des chunks clés du vivier (non exploités) ' +
          "auraient dû enrichir la réponse (mauvais chunking ou rerank ayant écarté un chunk pertinent)."
        : 'CRITÈRE "retrieval_quality" — La recherche élargie n\'ayant pas été exécutée, évalue uniquement ' +
          'si les chunks utilisés semblent pertinents et suffisants pour répondre ; indique brièvement que ' +
          'la note ne mesure pas les chunks non récupérés.',
    );
  }

  const keys = expectedMetrics(refusal).map((k) => METRIC_NAMES[k]);
  const shape = keys.map((k) => `"${k}": {"score": <0..1>, "reason": "<justification courte en français>"}`).join(', ');
  blocks.push(
    `\nRéponds UNIQUEMENT par un objet JSON valide, sans texte autour, de la forme :\n{${shape}}`,
  );

  return blocks.join('\n');
}

// Concatène instructions système + prompt utilisateur (les modèles open-weight d'Albert
// n'exposent pas tous un rôle système fiable ; on injecte tout dans un message user).
export function buildJudgeMessages(input: ScorerInput, refusal: boolean): Array<{ role: string; content: string }> {
  return [{ role: 'user', content: `${JUDGE_INSTRUCTIONS}\n\n${buildMergedJudgePrompt(input, refusal)}` }];
}

export interface ScoreResult {
  metric: string;
  score: number;
  reason: string;
}

// Extrait le premier objet JSON d'un texte (le juge peut l'entourer de prose ou de ```json).
function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  // Recherche de l'accolade fermante correspondante (équilibrage simple).
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === '{') depth++;
    else if (candidate[i] === '}') {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

// Parse la réponse fusionnée du juge → une ScoreResult par métrique attendue.
// Toute métrique manquante ou illisible reçoit score 0 + raison d'erreur (jamais de crash).
export function parseMergedJudgeResponse(text: string, refusal: boolean): ScoreResult[] {
  const keys = expectedMetrics(refusal);
  let parsed: z.infer<typeof mergedResponseSchema> = {};
  const raw = extractJsonObject(text || '');
  if (raw) {
    try {
      parsed = mergedResponseSchema.parse(JSON.parse(raw));
    } catch {
      parsed = {};
    }
  }
  return keys.map((k) => {
    const metric = METRIC_NAMES[k];
    const entry = (parsed as Record<string, { score: number; reason: string } | undefined>)[metric];
    if (!entry) return { metric, score: 0, reason: 'métrique absente de la réponse du juge' };
    return { metric, score: entry.score, reason: entry.reason };
  });
}
