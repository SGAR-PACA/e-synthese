import * as albert from '../../lib/albert-client.js';
import { getConfig } from '../../lib/config.js';
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
function normalizeHit(r: any): RagChunk {
  const md = r.chunk?.metadata || {};
  return {
    score: r.score ?? 0,
    content: r.chunk?.content || r.content || '',
    name: md.document_name || md.name || md.title || md.filename || `Document ${r.chunk?.document_id ?? ''}`.trim(),
    url: md.directory_url || md.url || md.source_url || '',
  };
}

export interface ResultatRecherche {
  chunks: RagChunk[]; // 0..finalK passages retenus
  vide: boolean; // true si rien au-dessus du seuil → consigne "rien trouvé"
}

// Lance N recherches en parallèle, fusionne, déduplique, rerank contre la
// question d'origine, applique le seuil, garde les finalK meilleurs.
// Choix A (validé) : AUCUN filtre minScore au search — le k borne déjà à
// searchWideK résultats par requête ; le rerank est le seul filtre de qualité.
export async function rechercherMultiple(requetes: string[], questionOrigine: string): Promise<ResultatRecherche> {
  const config = await getConfig();
  if (!config.defaultCollections.length || requetes.length === 0) return { chunks: [], vide: true };

  // A. Recherches parallèles (large). Une recherche qui échoue → paquet vide (dégradation douce).
  const paquets = await Promise.all(
    requetes.map(async (q) => {
      try {
        const res = await albert.search({ query: q, collections: config.defaultCollections, k: config.searchWideK });
        return (res.data || []).map(normalizeHit);
      } catch (err) {
        console.error('[retrieval] recherche échouée pour', q, err);
        return [] as RagChunk[];
      }
    }),
  );

  // B. Fusion + dédup.
  const fusionnes = fusionnerEtDedupliquer(paquets);
  if (fusionnes.length === 0) return { chunks: [], vide: true };

  // C. Rerank contre la question d'origine (repli : tri par score de recherche).
  let classes = fusionnes;
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

  // D. Seuil + resserrage.
  const meilleur = classes[0]?.score ?? 0;
  if (meilleur < config.rerankMinScore) return { chunks: [], vide: true };
  return { chunks: classes.slice(0, config.finalK), vide: false };
}
