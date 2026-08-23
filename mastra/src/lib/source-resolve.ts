// mastra/src/lib/source-resolve.ts
// Résolution de l'exemplaire de document à citer, quand un même NOM de fichier
// existe dans plusieurs collections (doublons inter-groupes / copies legacy).
//
// Contexte : Albert expose deux espaces d'ID (recherche ≠ upload). Le lien de
// source est reconstruit par NOM via document_files. Sans cloisonnement, le pont
// pouvait désigner un homonyme d'une collection NON autorisée → la visionneuse
// refusait ensuite (403) un lien qu'elle venait pourtant de fabriquer.
//
// Cette brique PURE choisit LA bonne ligne : d'abord restreinte aux collections
// autorisées de l'utilisateur, puis, si connue, la collection RÉELLE d'où vient
// le chunk retrouvé ; sinon la plus récente parmi les copies autorisées.
import type { DocumentFile } from './db.js';

// Sous-ensemble suffisant pour la sélection (facilite les tests).
export type FileCandidate = Pick<DocumentFile, 'albert_document_id' | 'collection_id' | 'created_at'>;

// Trie du plus récent au plus ancien (défensif : n'exige pas un input pré-trié).
function byRecent<T extends { created_at: string }>(a: T, b: T): number {
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

/**
 * Choisit l'exemplaire à citer parmi les lignes document_files homonymes.
 *
 * @param candidates       Toutes les lignes `ready` portant ce nom de fichier.
 * @param allowedCollections Collections autorisées ; `null` = admin (aucune restriction).
 * @param preferredCollectionId Collection réelle du chunk retrouvé, si connue.
 * @returns La ligne retenue, ou `undefined` si aucune copie n'est autorisée
 *          (dans ce cas : PAS de lien plutôt qu'un lien qui sera refusé).
 */
export function pickDocumentFile<T extends FileCandidate>(
  candidates: T[],
  allowedCollections: number[] | null,
  preferredCollectionId?: number | null,
): T | undefined {
  // 1. Restreindre aux collections autorisées (admin → tout). Un candidat sans
  //    collection (collection_id null) n'est jamais autorisable hors admin.
  const scoped =
    allowedCollections == null
      ? candidates.slice()
      : candidates.filter((c) => c.collection_id != null && allowedCollections.includes(c.collection_id));
  if (scoped.length === 0) return undefined;

  scoped.sort(byRecent);

  // 2. Préférer la collection RÉELLE du chunk (déterministe quand le même nom
  //    existe dans plusieurs collections autorisées).
  if (preferredCollectionId != null) {
    const exact = scoped.find((c) => c.collection_id === preferredCollectionId);
    if (exact) return exact;
  }

  // 3. Sinon : la copie autorisée la plus récente.
  return scoped[0];
}
