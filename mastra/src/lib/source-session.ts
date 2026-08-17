import { createHmac, timingSafeEqual } from 'node:crypto';

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

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 h

export function makeSourceSessionCookie(
  sub: string,
  groups: string[],
  key: string,
  ttlMs: number = SESSION_TTL_MS,
): string {
  const value = signCookieValue({ sub, groups, exp: Date.now() + ttlMs }, key, 'session');
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  return `src_session=${value}; HttpOnly; SameSite=Lax;${secure} Max-Age=${Math.floor(ttlMs / 1000)}; Path=/v1/source`;
}

export function clearSourceSessionCookie(): string {
  return 'src_session=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/v1/source';
}

export function readSourceSession(
  cookieHeader: string | undefined,
  key: string,
  now: number,
): { sub: string; groups: string[] } | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/src_session=([^;]+)/);
  if (!m) return null;
  const payload = verifyCookieValue<{ sub: string; groups?: unknown; exp: number }>(m[1], key, 'session');
  if (!payload || typeof payload.exp !== 'number' || payload.exp < now) return null;
  const groups = Array.isArray(payload.groups) ? payload.groups.filter((g): g is string => typeof g === 'string') : [];
  return { sub: payload.sub, groups };
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
