// Prompt système du LLM-as-judge (notation RAG).
//
// Le modèle juge n'est plus lié au chargement du module : il est résolu au moment de noter
// depuis la config (DB `judgeModel` → env `ALBERT_JUDGE_MODEL` → défaut `openweight-medium`),
// donc pilotable depuis l'admin sans redéploiement. Voir lib/config.ts et scorers/run.ts.
//
// Choix du modèle : un modèle Albert DISTINCT du modèle de génération, pour limiter le biais
// d'auto-préférence (un modèle note plus favorablement ses propres sorties). Défaut :
// Mistral Small 3.2 24B (`openweight-medium`), plus léger/rapide que gpt-oss-120b tout en
// restant fiable pour une notation en JSON structuré — un atout sous quota Albert serré.

export const JUDGE_INSTRUCTIONS =
  "Tu es un évaluateur rigoureux et impartial de réponses d'un assistant IA de " +
  "l'administration française (projet E-Synthèse, SGAR PACA). Tu notes la qualité de 0 " +
  '(très mauvais) à 1 (parfait), avec une courte justification en français.';
