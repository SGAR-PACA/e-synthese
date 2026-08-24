import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { getConfig } from '../../lib/config.js';
import { renderGlossaire } from './glossary.js';

// Albert peut parfois renvoyer une requête sous forme d'objet malgré la consigne
// (par exemple { description, requete } ou { question }). On accepte ces variantes
// à la frontière Mastra, puis on les normalise immédiatement en chaînes avant de
// lancer une recherche. Cela évite que le planificateur tombe systématiquement sur
// le repli « question brute ».
const plannerQueryObjectSchema = z.object({
  requete: z.string().optional(),
  query: z.string().optional(),
  question: z.string().optional(),
  text: z.string().optional(),
  description: z.string().optional(),
}).passthrough();

const plannerQuerySchema = z.union([z.string(), plannerQueryObjectSchema]);

export const planSchema = z.object({
  type: z.enum(['direct', 'recherche']),
  reponse_directe: z.string().optional(),
  requetes: z.array(plannerQuerySchema).optional(),
});

export type Plan =
  | { type: 'direct'; reponseDirecte: string }
  | { type: 'recherche'; requetes: string[] };

// Le réglage courant est pilotable dans Mastra Admin. Cette borne absolue évite
// qu'une mauvaise configuration puisse multiplier les appels Albert sans contrôle.
export const DEFAULT_MAX_SEARCH_QUERIES = 2;
export const ABSOLUTE_MAX_SEARCH_QUERIES = 4;

function normalizeMaxQueries(value: number): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(ABSOLUTE_MAX_SEARCH_QUERIES, Math.floor(value)))
    : DEFAULT_MAX_SEARCH_QUERIES;
}

function queryText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim();
    return text || undefined;
  }
  if (!value || typeof value !== 'object') return undefined;

  const candidate = value as Record<string, unknown>;
  // `requete` est le nom attendu ; les autres clés couvrent les variantes
  // observées dans les sorties Albert sans jamais les transmettre au moteur RAG.
  for (const key of ['requete', 'query', 'question', 'text', 'description']) {
    const text = queryText(candidate[key]);
    if (text) return text;
  }
  return undefined;
}

// Validation déterministe + repli. Brique PURE (testée). `raw` = sortie brute du LLM.
export function coercePlan(raw: any, questionBrute: string, maxQueries = DEFAULT_MAX_SEARCH_QUERIES): Plan {
  const queryLimit = normalizeMaxQueries(maxQueries);
  const repli: Plan = { type: 'recherche', requetes: [questionBrute] };
  if (!raw || typeof raw !== 'object') return repli;
  if (raw.type === 'direct' && typeof raw.reponse_directe === 'string' && raw.reponse_directe.trim()) {
    return { type: 'direct', reponseDirecte: raw.reponse_directe.trim() };
  }
  if (raw.type === 'recherche' && Array.isArray(raw.requetes)) {
    const seen = new Set<string>();
    const requetes = raw.requetes
      .map(queryText)
      .filter((q: string | undefined): q is string => {
        if (!q) return false;
        const key = q.toLocaleLowerCase('fr-FR');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, queryLimit);
    return requetes.length ? { type: 'recherche', requetes } : repli;
  }
  return repli;
}

const INSTRUCTIONS = `Tu es le planificateur d'un assistant documentaire de l'administration française (E-Synthèse, SGAR PACA).
Ton rôle : transformer la question de l'utilisateur en plan de recherche. Tu NE rédiges PAS la réponse.

# DÉCISION
- Salutation / remerciement / question purement conversationnelle → type "direct" + "reponse_directe" courte.
- Sinon → type "recherche" + "requetes" : 1 à ${ABSOLUTE_MAX_SEARCH_QUERIES} requêtes de recherche reformulées.
- La limite réellement configurée par l'administrateur sera appliquée avant les recherches.

# RÈGLES POUR LES REQUÊTES
- Découpe les questions complexes (comparaisons, multi-parties) en UNE requête par sous-sujet.
- Développe un acronyme UNIQUEMENT s'il figure dans le glossaire officiel ci-dessous ; sinon conserve
  l'acronyme tel quel et n'invente jamais son libellé.
- Reformule en termes clairs et complets pour une recherche sémantique.

# FORMAT DE SORTIE
- \'requetes\' doit être un tableau de chaînes de caractères, jamais un tableau d'objets.
- Exemple : {"type":"recherche","requetes":["ANLCI difficultés graves calcul numératie"]}

# GLOSSAIRE OFFICIEL (seuls ces développements sont autorisés ; pour tout autre acronyme,
# conserve le sigle tel quel et n'en invente pas le libellé)
${renderGlossaire()}`;

export const plannerAgent = new Agent({
  id: 'rag-planner',
  name: 'E-Synthèse Planner',
  instructions: INSTRUCTIONS,
  model: async () => {
    const model = (await getConfig()).llmModel || 'openweight-large';
    return `albert/albert/${model}` as any;
  },
});

// Appelle le LLM en sortie structurée, valide, et applique le repli en cas d'erreur.
export async function planifier(
  question: string,
  agent: Agent = plannerAgent,
  maxQueries = DEFAULT_MAX_SEARCH_QUERIES,
): Promise<Plan> {
  const queryLimit = normalizeMaxQueries(maxQueries);
  try {
    const planningQuestion = queryLimit === DEFAULT_MAX_SEARCH_QUERIES
      ? question
      : `${question}\n\nCONSIGNE DE TEST : ne génère pas plus de ${queryLimit} requête(s) de recherche.`;
    const res: any = await agent.generate(planningQuestion, {
      structuredOutput: { schema: planSchema },
      // Le planificateur doit être stable et concis ; la créativité se règle
      // uniquement sur le rédacteur dans l'admin.
      modelSettings: { temperature: 0 },
    });
    const raw = res?.object ?? res;
    return coercePlan(raw, question, queryLimit);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[planner] échec planification, repli question brute: ${detail.slice(0, 500)}`);
    return { type: 'recherche', requetes: [question] };
  }
}
