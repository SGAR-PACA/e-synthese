// Cœur du pipeline RAG non-stream, PARTAGÉ entre le chat (prod) et le banc de test admin.
// Objectif : garantir que les deux exécutent EXACTEMENT la même chaîne — planification →
// pêche large → rerank → seuil → rédaction — pour que tout réglage de paramètre (température,
// searchWideK, finalK, rerankMinScore, modèle) ait le MÊME effet dans le test et en production.
// (Le mode streaming reste dans chat-completions ; seul le non-stream est mutualisé ici.)

import type { Agent } from '@mastra/core/agent';
import { planifier, type Plan } from './planner.js';
import { rechercherMultiple } from './retrieval.js';
import { construirePromptRedaction } from './writer.js';
import type { RagChunk } from '../../lib/db.js';

// Filet de sécurité : retire les marqueurs de citation 【...】 que certains modèles émettent
// malgré l'interdiction dans le prompt système (le format « Source N » est imposé en bloc final).
export function stripCitationBrackets(text: string): string {
  return text.replace(/【[^】]*】/g, '');
}

export interface RagCoreResult {
  plan: Plan;               // plan du planificateur (direct vs recherche + sous-requêtes)
  chunks: RagChunk[];       // passages retenus (vide si plan direct)
  answer: string;           // réponse nettoyée (citations 【】 retirées, bloc Sources conservé)
  finishReason: string;
  usage: any;
}

export async function runRagCore(args: {
  question: string;
  planner: Agent;
  writer: Agent;
  writerSettings: { temperature: number; maxOutputTokens?: number };
  allowedCollections?: number[] | null;
}): Promise<RagCoreResult> {
  const plan = await planifier(args.question, args.planner);

  // Cas direct (salutation / conversationnel) : pas de recherche, pas de notation.
  if (plan.type === 'direct') {
    return { plan, chunks: [], answer: plan.reponseDirecte, finishReason: 'stop', usage: undefined };
  }

  const { chunks } = await rechercherMultiple(plan.requetes, args.question, args.allowedCollections);
  const result: any = await args.writer.generate(
    [{ role: 'user', content: construirePromptRedaction(args.question, chunks) }],
    { modelSettings: args.writerSettings },
  );
  const answer = stripCitationBrackets(result.text ?? '');
  return { plan, chunks, answer, finishReason: result.finishReason || 'stop', usage: result.usage };
}
