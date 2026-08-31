import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function signCookieValue(payload: object, key: string, context = 'v1'): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', key).update(`${context}.${body}`).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyCookieValue<T = any>(value: string, key: string, context = 'v1'): T | null {
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = createHmac('sha256', key).update(`${context}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

// La session de la visionneuse n'est plus un JWT/cookie auto-validant : elle est
// opaque et doit exister dans `source_sessions` côté serveur. Elle suit la durée
// d'une journée de travail afin que la consultation d'une source ne coupe pas
// l'utilisateur en cours de session. Les logouts front/back-channel continuent
// de la révoquer immédiatement.
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 60 * 1000;
// Le minimum corrige aussi les déploiements existants qui ont conservé
// l'ancienne durée de 15 minutes depuis le précédent .env d'exemple.
const MIN_SESSION_TTL_MS = 10 * 60 * 60 * 1000;
const MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function sourceSessionTtlMs(): number {
  const raw = Number(process.env.MASTRA_SOURCE_SESSION_TTL_SECONDS ?? '36000');
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SESSION_TTL_MS;
  return Math.max(MIN_SESSION_TTL_MS, Math.min(Math.floor(raw * 1000), MAX_SESSION_TTL_MS));
}

export function newSourceSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSourceSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function readSourceSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)src_session=([^;]+)/);
  const token = m?.[1];
  // 32 random bytes encoded base64url. Reject malformed/oversized values before
  // hashing or querying the database.
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function makeSourceSessionCookie(
  token: string,
  ttlMs: number = sourceSessionTtlMs(),
): string {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  return `src_session=${token}; HttpOnly; SameSite=Lax;${secure} Max-Age=${Math.floor(ttlMs / 1000)}; Path=/v1/source`;
}

export function clearSourceSessionCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  return `src_session=; HttpOnly; SameSite=Lax;${secure} Max-Age=0; Path=/v1/source`;
}

// Anti open-redirect : seul un chemin interne /v1/source/... est accepté.
const RETURN_URL_RE = /^\/v1\/source\/[A-Za-z0-9._~%\-\/?=&,]*$/;

export function safeReturnUrl(raw: string | null | undefined): string {
  const fallback = '/v1/source';
  if (!raw) return fallback;
  if (raw.includes('//') || raw.includes('..') || raw.includes('\\')) return fallback;
  if (!RETURN_URL_RE.test(raw)) return fallback;
  return raw;
}
