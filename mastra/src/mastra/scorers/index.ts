// Scorers Mastra (« notation » du RAG) — API native @mastra/core/evals (createScorer).
// 4 LLM-juges adaptés au contrat E-Synthèse :
//   • system_prompt      : la réponse respecte-t-elle le prompt système de l'agent ?
//   • faithfulness       : chaque affirmation est-elle étayée par les chunks utilisés ?
//   • completeness       : la réponse omet-elle de l'info présente dans les chunks utilisés ?
//   • retrieval_quality  : le vivier élargi contient-il de l'info importante absente (chunking/rerank) ?
//
// Chaque scorer : analyze (juge → {score, reason} validé par Zod) → generateScore → generateReason.

import { createScorer } from '@mastra/core/evals';
import { z } from 'zod';
import { judge } from './judge.js';

export const scorerInputSchema = z.object({
  question: z.string(),
  contexts: z.array(z.string()),      // chunks utilisés par l'agent
  wideContexts: z.array(z.string()),  // vivier élargi (#4)
  instructions: z.string(),           // prompt système (#1)
});
export const scorerOutputSchema = z.object({ answer: z.string() });

const analyzeSchema = z.object({
  score: z.number().min(0).max(1).describe('Note entre 0 et 1.'),
  reason: z.string().describe('Courte justification en français.'),
});

type ScorerInput = z.infer<typeof scorerInputSchema>;
type ScorerOutput = z.infer<typeof scorerOutputSchema>;
type Run = { input?: ScorerInput; output: ScorerOutput };

// La chaîne fluide de Mastra accumule des types non « portables » ; on caste en `any`.
// La logique runtime est exacte et l'outputSchema garantit la forme {score, reason}.
function makeJudgeScorer(id: string, description: string, buildPrompt: (run: Run) => string) {
  const scorer = createScorer({
    id,
    description,
    judge,
    type: { input: scorerInputSchema, output: scorerOutputSchema },
  } as any) as any;

  return scorer
    .analyze({
      description,
      outputSchema: analyzeSchema,
      createPrompt: ({ run }: { run: Run }) =>
        `${buildPrompt(run)}\n\nRéponds par {"score": <0..1>, "reason": "<justification courte en français>"}.`,
    })
    .generateScore(({ results }: any) => results.analyzeStepResult.score)
    .generateReason(({ results }: any) => results.analyzeStepResult.reason);
}

const joinCtx = (arr?: string[]) => (arr && arr.length ? arr.join('\n---\n') : '(aucun)');

export const systemPromptScorer = makeJudgeScorer(
  'system_prompt',
  "Conformité : la réponse respecte-t-elle les règles du prompt système de l’agent ?",
  (run) =>
    `RÈGLES IMPOSÉES À L'ASSISTANT (prompt système) :\n${run.input?.instructions ?? ''}\n\n` +
    `RÉPONSE À ÉVALUER :\n${run.output.answer}\n\n` +
    `Note 1 si TOUTES les règles sont respectées (format Markdown, bloc « Sources : » bien ` +
    `formé en fin de réponse, AUCUN marqueur inline interdit type 【Source X】 ou [1], langue ` +
    `française, refus propre si l'information manque). Baisse la note pour chaque règle violée.`,
);

export const faithfulnessScorer = makeJudgeScorer(
  'faithfulness',
  'Fidélité : la réponse est-elle entièrement étayée par les chunks utilisés (anti-hallucination) ?',
  (run) =>
    `CHUNKS UTILISÉS :\n${joinCtx(run.input?.contexts)}\n\nQUESTION : ${run.input?.question ?? ''}\n\n` +
    `RÉPONSE À ÉVALUER :\n${run.output.answer}\n\n` +
    `Note 1 si chaque affirmation est vérifiable dans les chunks, baisse si la réponse invente ` +
    `ou affirme des choses absentes des chunks.`,
);

export const completenessScorer = makeJudgeScorer(
  'completeness',
  "Complétude : la réponse exploite-t-elle toute l'info utile présente dans les chunks utilisés ?",
  (run) =>
    `CHUNKS UTILISÉS :\n${joinCtx(run.input?.contexts)}\n\nQUESTION : ${run.input?.question ?? ''}\n\n` +
    `RÉPONSE À ÉVALUER :\n${run.output.answer}\n\n` +
    `Note 1 si la réponse exploite toute l'information utile PRÉSENTE DANS LES CHUNKS, baisse si ` +
    `elle omet des éléments importants qui y figuraient. N'évalue pas ce qui n'est pas dans les chunks.`,
);

export const retrievalQualityScorer = makeJudgeScorer(
  'retrieval_quality',
  'Qualité du retrieval : un chunk important du vivier élargi a-t-il été manqué (chunking/rerank) ?',
  (run) =>
    `VIVIER ÉLARGI (recherche large, chunks candidats) :\n${joinCtx(run.input?.wideContexts)}\n\n` +
    `QUESTION : ${run.input?.question ?? ''}\n\nRÉPONSE À ÉVALUER :\n${run.output.answer}\n\n` +
    `Note 1 si le vivier élargi ne contient PAS d'information importante absente de la réponse. ` +
    `Baisse si des chunks clés du vivier (non exploités) auraient dû enrichir la réponse — signe ` +
    `d'un mauvais découpage (chunking) ou d'un rerank ayant écarté un chunk pertinent.`,
);

export const ragScorers = {
  systemPrompt: systemPromptScorer,
  faithfulness: faithfulnessScorer,
  completeness: completenessScorer,
  retrievalQuality: retrievalQualityScorer,
};

// Correspondance clé interne → nom de métrique persisté (colonne rag_scores.metric).
export const METRIC_NAMES: Record<keyof typeof ragScorers, string> = {
  systemPrompt: 'system_prompt',
  faithfulness: 'faithfulness',
  completeness: 'completeness',
  retrievalQuality: 'retrieval_quality',
};
