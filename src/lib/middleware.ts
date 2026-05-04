import { parseSessionCookie, validateSession } from './auth.js';
import { getUserCollections, type DbUser } from './db.js';
import { verifyApiKey } from './api-key.js';

export interface AuthContext {
  user: DbUser;
  csrfToken: string;
  collections: number[];
}

export function getAuth(c: any): AuthContext | null {
  const token = parseSessionCookie(c.req.header('cookie'));
  if (!token) return null;
  const session = validateSession(token);
  if (!session) return null;
  const collections = session.user.role === 'admin' ? [] : getUserCollections(session.user.id);
  return { user: session.user, csrfToken: session.csrfToken, collections };
}

export function requireAuth(c: any): AuthContext | Response {
  const auth = getAuth(c);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);
  return auth;
}

export function requireAdmin(c: any): AuthContext | Response {
  const auth = getAuth(c);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);
  if (auth.user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
  return auth;
}

export function verifyCsrf(c: any, auth: AuthContext): Response | null {
  const csrfHeader = c.req.header('x-csrf-token');
  if (!csrfHeader || csrfHeader !== auth.csrfToken) {
    return c.json({ error: 'Invalid CSRF token' }, 403);
  }
  return null;
}

export function getClientIp(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export function canAccessCollection(auth: AuthContext, collectionId: number): boolean {
  if (auth.user.role === 'admin') return true;
  return auth.collections.includes(collectionId);
}

export function requireApiKey(c: any): Response | null {
  const header = c.req.header('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return c.json({ error: 'Missing Authorization Bearer token' }, 401);
  if (!verifyApiKey(match[1].trim())) return c.json({ error: 'Invalid API key' }, 401);
  return null;
}
