// Détection de refus (module PUR, sans dépendance) — testable unitairement.
//
// Une réponse de refus (« je ne dispose pas d'information… ») ne doit pas être notée sur
// fidélité/complétude/qualité-retrieval, qui la pénaliseraient injustement (elles reprochent
// l'absence de source, alors que c'est précisément le comportement voulu quand le corpus ne
// couvre pas la question). Seule la conformité au prompt système s'applique alors.

// Les sorties françaises d'Albert/Mistral utilisent souvent l'apostrophe typographique (') ;
// on la normalise en apostrophe droite avant de tester, pour ne pas manquer un vrai refus.
const REFUSAL_PATTERN =
  /je ne (dispose|trouve) pas|aucun document|aucune information|pas d'information|n'?ai pas trouv|information n'est pas (dans|disponible)|ne permet pas de répondre|hors de ma base|pas dans le contexte/i;

export function isRefusal(answer: string): boolean {
  const normalized = (answer || '').replace(/['’ʼ]/g, "'");
  return REFUSAL_PATTERN.test(normalized);
}
