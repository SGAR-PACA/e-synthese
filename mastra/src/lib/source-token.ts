import { createHmac, timingSafeEqual } from 'node:crypto';

// Le payload signé lie documentId + liste de chunkIds + expiration.
// La signature non-forgeable empêche d'ouvrir un documentId arbitraire (anti-énumération, spec §6 S1).
function payload(documentId: string, used: string, exp: string | number): string {
  return `${documentId}|${used}|${exp}`;
}

export function buildSignedQuery(documentId: string, chunkIds: string[], exp: number, key: string): string {
  const used = chunkIds.join(',');
  const sig = createHmac('sha256', key).update(payload(documentId, used, exp)).digest('base64url');
  const parts: string[] = [];
  if (used) parts.push(`used=${encodeURIComponent(used)}`);
  parts.push(`exp=${exp}`);
  parts.push(`sig=${sig}`);
  return parts.join('&');
}

export function verifySourceToken(
  documentId: string,
  used: string,
  exp: string,
  sig: string,
  key: string,
  now: number,
): boolean {
  // Anti-ambiguïté : le délimiteur de payload ne doit jamais apparaître dans les champs.
  // (Les ids Albert sont des UUID/entiers — hypothèse documentée.)
  if (documentId.includes('|') || used.includes('|')) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < now) return false;
  const expected = createHmac('sha256', key).update(payload(documentId, used, exp)).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function getKey(): string {
  const k = process.env.MASTRA_SOURCE_LINK_KEY;
  if (!k || k.length < 32) throw new Error('MASTRA_SOURCE_LINK_KEY manquant ou trop court (>= 32 caractères)');
  return k;
}

// Durée de vie du lien de source signé. Un TTL long facilite la relecture de
// vieilles conversations (les liens sont stockés dans l'historique Django) mais
// allonge la fenêtre de rejeu d'une URL fuitée. Défaut : 30 jours ; ajustable
// via MASTRA_SOURCE_LINK_TTL_SECONDS. Le lien reste une capability partageable
// par conception ; la vraie protection est la session OIDC active + le contrôle
// de collection à chaque requête — cf. 2b.
const DEFAULT_SOURCE_LINK_TTL_SECONDS = 30 * 24 * 3600;

function sourceLinkTtlMs(): number {
  const s = Number(process.env.MASTRA_SOURCE_LINK_TTL_SECONDS);
  return (Number.isFinite(s) && s > 0 ? s : DEFAULT_SOURCE_LINK_TTL_SECONDS) * 1000;
}

export function signSourceToken(documentId: string, chunkIds: string[]): string {
  return buildSignedQuery(documentId, chunkIds, Date.now() + sourceLinkTtlMs(), getKey());
}
