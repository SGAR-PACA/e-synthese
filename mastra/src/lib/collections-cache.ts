// Liste (mise en cache courte) des ids de TOUTES les collections Albert.
// Utilisée comme périmètre par défaut quand l'accès n'est PAS restreint :
//  - phase de transition (pas encore de token utilisateur), et
//  - groupe admin (voit tout le corpus).
// Le cache borne les appels Albert (quota 10 req/min) sur ce chemin.
import * as albert from './albert-client.js';

let cache: { ids: number[]; at: number } | undefined;
const TTL_MS = 30_000;

export async function getAllCollectionIds(now: number = Date.now()): Promise<number[]> {
  if (cache && now - cache.at < TTL_MS) return cache.ids;
  const res = await albert.listCollections();
  const ids = (res.data || [])
    .map((c: { id?: unknown }) => Number(c.id))
    .filter((n: number) => Number.isInteger(n) && n > 0);
  cache = { ids, at: now };
  return ids;
}

// Réinitialise le cache (utile après création/suppression de collection en admin).
export function invalidateCollectionsCache(): void {
  cache = undefined;
}
