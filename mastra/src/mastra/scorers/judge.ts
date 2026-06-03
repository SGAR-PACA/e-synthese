// Modèle JUGE (LLM-as-judge) = un modèle Albert, distinct du modèle de génération pour
// limiter le biais d'auto-préférence. Défaut : gpt-oss-120b (alias `openweight-large`), 120B,
// gratuit, 131k de contexte.
//
// Lu depuis l'ENV (et non la config DB) car `createScorer` se construit au chargement du
// module, de façon SYNCHRONE — or getConfig() est async. Modifiable via env.d + docker compose.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const RAW_BASE = (process.env.ALBERT_API_BASE_URL || 'https://albert.api.etalab.gouv.fr').replace(/\/$/, '');
const BASE_URL = RAW_BASE.endsWith('/v1') ? RAW_BASE : `${RAW_BASE}/v1`;

export const JUDGE_MODEL_ID = process.env.ALBERT_JUDGE_MODEL || 'openweight-large';

const provider = createOpenAICompatible({
  name: 'albert-judge',
  baseURL: BASE_URL,
  apiKey: process.env.ALBERT_API_KEY || '',
});

// Objet `judge` consommé par createScorer ({ model, instructions }).
// jsonPromptInjection: true → le schéma JSON est injecté dans le prompt plutôt que via le
// response_format natif (sûr pour les modèles open-weight qui ne le supportent pas tous).
export const judge = {
  model: provider.chatModel(JUDGE_MODEL_ID),
  instructions:
    "Tu es un évaluateur rigoureux et impartial de réponses d'un assistant IA de " +
    "l'administration française (projet E-Synthèse, SGAR PACA). Tu notes la qualité de 0 " +
    "(très mauvais) à 1 (parfait), avec une courte justification en français.",
  jsonPromptInjection: true,
};
