import * as albert from '../../lib/albert-client.js';
import { getConfig } from '../../lib/config.js';
import type { AppConfig } from '../../lib/config.js';
import { getAllCollectionIds } from '../../lib/collections-cache.js';
import type { RagChunk } from '../../lib/db.js';

// Fusionne plusieurs paquets de chunks et déduplique par contenu.
// En cas de doublon, on conserve la meilleure note. Brique PURE (testée).
export function fusionnerEtDedupliquer(paquets: RagChunk[][]): RagChunk[] {
  const parContenu = new Map<string, RagChunk>();
  for (const paquet of paquets) {
    for (const chunk of paquet) {
      const cle = chunk.content.trim();
      if (!cle) continue;
      const existant = parContenu.get(cle);
      if (!existant || chunk.score > existant.score) parContenu.set(cle, chunk);
    }
  }
  return [...parContenu.values()];
}

// Normalise un hit Albert en RagChunk (même logique que search.ts / run.ts).
export function normalizeHit(r: any): RagChunk {
  const md = r.chunk?.metadata || {};
  const documentId = r.chunk?.document_id != null ? String(r.chunk.document_id) : undefined;
  const chunkId = r.chunk?.id != null ? String(r.chunk.id) : undefined;
  // Collection réelle d'où vient le hit (si Albert la renvoie) : sert à résoudre
  // le lien vers le BON exemplaire quand un même nom existe dans plusieurs
  // collections. Best-effort : absente → repli sur la copie autorisée la plus récente.
  const rawCid = md.collection_id ?? r.chunk?.collection_id;
  const collectionId = rawCid != null && Number.isFinite(Number(rawCid)) ? Number(rawCid) : undefined;
  return {
    score: r.score ?? 0,
    content: r.chunk?.content || r.content || '',
    name: md.document_name || md.name || md.title || md.filename || `Document ${documentId ?? ''}`.trim(),
    url: md.directory_url || md.url || md.source_url || '',
    documentId,
    chunkId,
    collectionId,
  };
}

// Défense en profondeur (Chantier 2) : on ne garde QUE les passages dont la
// collection est autorisée. Même si le filtre `collection_ids` d'Albert marche,
// cette barrière côté app garantit qu'un passage hors périmètre (Albert qui
// déborde, régression de paramètre, dédoublonnage cross-collection…) n'atteint
// jamais la réponse. `allowedCollections` null = admin/non restreint → tout.
// Un passage sans `collectionId` connu n'est jamais autorisable hors admin.
export function filterByAllowedCollections(
  chunks: RagChunk[],
  allowedCollections: number[] | null | undefined,
): RagChunk[] {
  if (allowedCollections == null) return chunks;
  const allow = new Set(allowedCollections);
  return chunks.filter((c) => c.collectionId != null && allow.has(c.collectionId));
}

export interface ResultatRecherche {
  chunks: RagChunk[]; // 0..finalK passages retenus
  vide: boolean; // true si rien au-dessus du seuil → consigne "rien trouvé"
}

// Lance N recherches en parallèle, fusionne, déduplique, rerank contre la
// question d'origine si activé, applique le seuil, garde les finalK meilleurs.
// Choix A (validé) : AUCUN filtre minScore au search — le k borne déjà à
// searchWideK résultats par requête ; le rerank est le filtre de qualité quand
// il est activé, sinon le score de recherche et minScore prennent le relais.
// Périmètre de recherche (Chantier 2) :
//  - `allowedCollections` = tableau → collections EXPLICITEMENT autorisées pour
//    l'utilisateur (autorité ; tableau vide → aucun résultat, défaut sûr).
//  - `null`/`undefined` = accès NON restreint (repli : mode transition explicite
//    ou groupe admin) → TOUTES les collections. Plus de « collections par défaut »
//    cochées en admin : l'accès est piloté par les groupes.
export async function rechercherMultiple(
  requetes: string[],
  questionOrigine: string,
  allowedCollections?: number[] | null,
  configOverride?: AppConfig,
): Promise<ResultatRecherche> {
  // Le banc de test fournit un snapshot pour que tous les appels d'une exécution
  // utilisent exactement les paramètres affichés dans l'admin.
  const config = configOverride ?? await getConfig();
  const collections = allowedCollections == null ? await getAllCollectionIds() : allowedCollections;
  if (!collections.length || requetes.length === 0) return { chunks: [], vide: true };

  // A. Recherches parallèles (large). Une recherche qui échoue → paquet vide (dégradation douce).
  const paquets = await Promise.all(
    requetes.map(async (q) => {
      try {
        const res = await albert.search({ query: q, collections, k: config.searchWideK });
        // Défense en profondeur : refiltrage par collection autorisée (cf. supra).
        return filterByAllowedCollections((res.data || []).map(normalizeHit), allowedCollections);
      } catch (err) {
        console.error('[retrieval] recherche échouée pour', q, err);
        return [] as RagChunk[];
      }
    }),
  );

  // B. Fusion + dédup.
  const fusionnes = fusionnerEtDedupliquer(paquets);
  if (fusionnes.length === 0) return { chunks: [], vide: true };

  // C. Rerank contre la question d'origine (optionnel : le désactiver économise
  // un appel Albert par réponse et replie sur le score de recherche).
  let classes = fusionnes;
  if (config.useRerank) {
    try {
      const rr = await albert.rerank({ query: questionOrigine, documents: fusionnes.map((c) => c.content) });
      if (rr.results) {
        classes = rr.results
          .sort((a: any, b: any) => b.relevance_score - a.relevance_score)
          .map((r: any) => ({ ...fusionnes[r.index], score: r.relevance_score }));
      }
    } catch (err) {
      console.error('[retrieval] rerank indisponible, repli tri par score', err);
      classes = [...fusionnes].sort((a, b) => b.score - a.score);
    }
  } else {
    classes = [...fusionnes].sort((a, b) => b.score - a.score);
  }

  // D. Seuil + resserrage.
  const meilleur = classes[0]?.score ?? 0;
  const minScore = config.useRerank ? config.rerankMinScore : config.minScore;
  if (meilleur < minScore) return { chunks: [], vide: true };
  return { chunks: classes.slice(0, config.finalK), vide: false };
}
