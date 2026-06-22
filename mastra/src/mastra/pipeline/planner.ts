import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { getConfig } from '../../lib/config.js';
import { renderGlossaire } from './glossary.js';

export const planSchema = z.object({
  type: z.enum(['direct', 'recherche']),
  reponse_directe: z.string().optional(),
  requetes: z.array(z.string()).optional(),
});

export type Plan =
  | { type: 'direct'; reponseDirecte: string }
  | { type: 'recherche'; requetes: string[] };

const MAX_REQUETES = 4;

// Validation déterministe + repli. Brique PURE (testée). `raw` = sortie brute du LLM.
export function coercePlan(raw: any, questionBrute: string): Plan {
  const repli: Plan = { type: 'recherche', requetes: [questionBrute] };
  if (!raw || typeof raw !== 'object') return repli;
  if (raw.type === 'direct' && typeof raw.reponse_directe === 'string' && raw.reponse_directe.trim()) {
    return { type: 'direct', reponseDirecte: raw.reponse_directe.trim() };
  }
  if (raw.type === 'recherche' && Array.isArray(raw.requetes)) {
    const requetes = raw.requetes.filter((q: any) => typeof q === 'string' && q.trim()).slice(0, MAX_REQUETES);
    return requetes.length ? { type: 'recherche', requetes } : repli;
  }
  return repli;
}

const INSTRUCTIONS = `Tu es le planificateur d'un assistant documentaire de l'administration française (E-Synthèse, SGAR PACA).
Ton rôle : transformer la question de l'utilisateur en plan de recherche. Tu NE rédiges PAS la réponse.

# DÉCISION
- Salutation / remerciement / question purement conversationnelle → type "direct" + "reponse_directe" courte.
- Sinon → type "recherche" + "requetes" : 1 à ${MAX_REQUETES} requêtes de recherche reformulées.

# RÈGLES POUR LES REQUÊTES
- Découpe les questions complexes (comparaisons, multi-parties) en UNE requête par sous-sujet.
- Développe TOUJOURS les acronymes (ajoute le libellé complet à côté du sigle).
- Reformule en termes clairs et complets pour une recherche sémantique.

# GLOSSAIRE OFFICIEL (à utiliser en priorité ; développe aussi les autres acronymes que tu connais)
${renderGlossaire()}`;

export const plannerAgent = new Agent({
  id: 'rag-planner',
  name: 'E-Synthèse Planner',
  instructions: INSTRUCTIONS,
  model: async () => {
    const model = (await getConfig()).llmModel || 'albert-large';
    return `albert/albert/${model}` as any;
  },
});

// Appelle le LLM en sortie structurée, valide, et applique le repli en cas d'erreur.
export async function planifier(question: string, agent: Agent = plannerAgent): Promise<Plan> {
  try {
    const res: any = await agent.generate(question, { structuredOutput: { schema: planSchema } });
    const raw = res?.object ?? res;
    return coercePlan(raw, question);
  } catch (err) {
    console.error('[planner] échec planification, repli question brute', err);
    return { type: 'recherche', requetes: [question] };
  }
}
