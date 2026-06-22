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

const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000;

export function signSourceToken(documentId: string, chunkIds: string[]): string {
  return buildSignedQuery(documentId, chunkIds, Date.now() + TEN_YEARS_MS, getKey());
}
