// Cloisonnement du RAG par groupe Keycloak (Chantier 2).
// Briques PURES (extraction/union) testables + orchestrateur DB-backed.
import type { JWTPayload } from 'jose';
import { getCollectionsForGroups } from './db.js';

// Groupe Keycloak conférant l'accès à TOUT le corpus (bypass). Configurable.
const ADMIN_GROUP = process.env.MASTRA_ADMIN_GROUP || 'admin';

// Extrait les groupes d'un JWT Keycloak validé.
// Sources : claim `groups` (chemins Keycloak type "/sgar" → "sgar") ET
// `realm_access.roles`. On tolère les deux car selon les mappers, l'un ou
// l'autre porte l'appartenance. Dédupliqué.
export function extractGroups(payload: JWTPayload): string[] {
  const out = new Set<string>();
  const groups = (payload as Record<string, unknown>).groups;
  if (Array.isArray(groups)) {
    for (const g of groups) if (typeof g === 'string') out.add(g.replace(/^\/+/, ''));
  }
  const realmAccess = (payload as Record<string, unknown>).realm_access as { roles?: unknown } | undefined;
  if (realmAccess && Array.isArray(realmAccess.roles)) {
    for (const r of realmAccess.roles) if (typeof r === 'string') out.add(r);
  }
  return [...out];
}

export function isAdminGroup(groups: string[]): boolean {
  return groups.includes(ADMIN_GROUP);
}

// Union dédupliquée de deux listes d'ids de collection. PURE.
export function unionCollections(a: number[], b: number[]): number[] {
  return [...new Set([...a, ...b])];
}

// Collections autorisées pour l'utilisateur, ou `null` si accès NON restreint
// (groupe admin). Un tableau VIDE = aucune collection autorisée (l'utilisateur
// ne verra rien : défaut sûr). L'accès = union des collections de ses groupes
// (un user peut appartenir à plusieurs groupes).
export async function resolveAllowedCollections(groups: string[]): Promise<number[] | null> {
  if (isAdminGroup(groups)) return null;
  return getCollectionsForGroups(groups);
}
