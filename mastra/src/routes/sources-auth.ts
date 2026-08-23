// mastra/src/routes/sources-auth.ts
import { registerApiRoute } from '@mastra/core/server';
import { timingSafeEqual } from 'node:crypto';
import {
  clearSourceSessionCookie,
  hashSourceSessionToken,
  newSourceSessionToken,
  readSourceSessionToken,
  sourceSessionTtlMs,
  makeSourceSessionCookie,
  signCookieValue,
  verifyCookieValue,
  safeReturnUrl,
} from '../lib/source-session.js';
import {
  beginLogin,
  completeLogin,
  oidcIssuer,
  verifyOidcLogoutToken,
  type OidcTx,
} from '../lib/oidc.js';
import { checkRateLimit, recordFailedAttempt, resetRateLimit } from '../lib/auth.js';
import { getClientIp } from '../lib/middleware.js';
import {
  createSourceSession,
  deleteSourceSession,
  deleteSourceSessionsByOidcSid,
  findSourceSession,
  logAudit,
  revokeSourceSessionsForLogout,
} from '../lib/db.js';

function rpKey(): string {
  const k = process.env.MASTRA_RP_COOKIE_KEY;
  if (!k || k.length < 32) throw new Error('MASTRA_RP_COOKIE_KEY manquant ou trop court (>= 32 caractères)');
  return k;
}

// --- Cookie de transaction OIDC (state/nonce/verifier/returnUrl) ---
export function txCookie(tx: OidcTx, key: string): string {
  const value = signCookieValue(tx, key, 'tx');
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  return `src_oidc_tx=${value}; HttpOnly; SameSite=Lax;${secure} Max-Age=600; Path=/v1/source`;
}

export function readTxCookie(cookieHeader: string | undefined, key: string): OidcTx | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/src_oidc_tx=([^;]+)/);
  if (!m) return null;
  return verifyCookieValue<OidcTx>(m[1], key, 'tx');
}

function clearTxCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  return `src_oidc_tx=; HttpOnly; SameSite=Lax;${secure} Max-Age=0; Path=/v1/source`;
}

// Comparaison de chaînes en temps constant (state anti-CSRF). Le state est un token
// base64url (ASCII, via randomUrlToken) → Buffer.from(...) en UTF-8 reflète exactement
// ses octets. Longueurs inégales -> false avant timingSafeEqual.
export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface SourceAuthSession {
  sub: string;
  groups: string[];
  tokenHash: string;
  oidcSid?: string;
}

async function readDbSourceSession(cookieHeader: string | undefined): Promise<SourceAuthSession | null> {
  const token = readSourceSessionToken(cookieHeader);
  if (!token) return null;
  const tokenHash = hashSourceSessionToken(token);
  const row = await findSourceSession(tokenHash);
  if (!row || typeof row.sub !== 'string') return null;
  const groups = Array.isArray(row.groups)
    ? row.groups.filter((g): g is string => typeof g === 'string')
    : [];
  return {
    sub: row.sub,
    groups,
    tokenHash,
    oidcSid: typeof row.oidc_sid === 'string' ? row.oidc_sid : undefined,
  };
}

function redirectToLogin(returnUrl: string, key: string, silent: boolean, clearSession: boolean): Response {
  const { redirectUrl, tx } = beginLogin(safeReturnUrl(returnUrl), silent);
  const headers = new Headers({ Location: redirectUrl, 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', txCookie(tx, key));
  if (clearSession) headers.append('Set-Cookie', clearSourceSessionCookie());
  return new Response(null, { status: 302, headers });
}

// Garde : session opaque active côté serveur -> { sub, groups }. Sinon, on tente
// d'abord le SSO silencieux Keycloak (aucune saisie si la session Conversations
// repose encore sur le même SSO), puis le callback bascule vers le login normal.
export async function requireSourceSession(c: any): Promise<SourceAuthSession | Response> {
  const key = rpKey();
  const session = await readDbSourceSession(c.req.header('cookie'));
  if (session) return session;

  const url = new URL(c.req.url);
  return redirectToLogin(url.pathname + (url.search || ''), key, true, true);
}

export const sourcesAuthRoute = [
  registerApiRoute('/v1/source/callback', {
    method: 'GET',
    handler: async (c) => {
      const key = rpKey();
      const ip = getClientIp(c);
      const rl = checkRateLimit(`oidc:${ip}`);
      if (!rl.allowed) return c.text('Trop de tentatives, réessayez plus tard.', 429);

      const code = c.req.query('code');
      const state = c.req.query('state');
      const oidcError = c.req.query('error');
      const tx = readTxCookie(c.req.header('cookie'), key);

      // state CSRF : doit correspondre exactement à la transaction (temps constant).
      if (!state || !tx || !constantTimeEqual(state, tx.state)) {
        recordFailedAttempt(`oidc:${ip}`);
        return c.text('Échec de l\'authentification.', 401, { 'Set-Cookie': clearTxCookie() });
      }

      // `prompt=none` échoue normalement avec login_required lorsque le cookie
      // SSO Keycloak n'existe plus. Ce n'est pas une attaque ni une tentative
      // ratée : on remplace la transaction par une authentification interactive.
      if (oidcError) {
        if (
          tx.silent &&
          (oidcError === 'login_required' ||
            oidcError === 'interaction_required' ||
            oidcError === 'consent_required' ||
            oidcError === 'account_selection_required')
        ) {
          return redirectToLogin(tx.returnUrl, key, false, false);
        }
        recordFailedAttempt(`oidc:${ip}`);
        return c.text('Échec de l\'authentification.', 401, { 'Set-Cookie': clearTxCookie() });
      }

      if (!code) {
        recordFailedAttempt(`oidc:${ip}`);
        return c.text('Échec de l\'authentification.', 401, { 'Set-Cookie': clearTxCookie() });
      }

      try {
        const { sub, groups, oidcSid } = await completeLogin(code, tx);
        const sessionToken = newSourceSessionToken();
        const ttlMs = sourceSessionTtlMs();
        await createSourceSession(
          hashSourceSessionToken(sessionToken),
          sub,
          oidcSid,
          groups,
          new Date(Date.now() + ttlMs).toISOString(),
        );
        resetRateLimit(`oidc:${ip}`);
        void logAudit(ip, 'SOURCE_LOGIN', undefined, `sub=${sub}`)
          .catch((err) => console.error('[sources-auth] audit login échec:', (err as Error).message));
        // Deux Set-Cookie : pose la session opaque et efface le cookie de transaction.
        const headers = new Headers();
        headers.append('Location', safeReturnUrl(tx.returnUrl));
        headers.append('Set-Cookie', makeSourceSessionCookie(sessionToken, ttlMs));
        headers.append('Set-Cookie', clearTxCookie());
        headers.set('Cache-Control', 'no-store');
        return new Response(null, { status: 302, headers });
      } catch (err) {
        console.error('[oidc] callback échec:', (err as Error).message);
        recordFailedAttempt(`oidc:${ip}`);
        return c.text('Échec de l\'authentification.', 401, { 'Set-Cookie': clearTxCookie() });
      }
    },
  }),

  // Logout local appelé par Conversations avant son propre logout OIDC. Il ne
  // reçoit ni sub ni sid du navigateur : seul le hash du cookie courant est
  // supprimé côté serveur.
  registerApiRoute('/v1/source/logout', {
    method: 'POST',
    handler: async (c) => {
      const token = readSourceSessionToken(c.req.header('cookie'));
      const tokenHash = token ? hashSourceSessionToken(token) : null;
      const session = tokenHash ? await findSourceSession(tokenHash) : undefined;
      if (tokenHash) await deleteSourceSession(tokenHash);
      if (session?.sub) {
        void logAudit(getClientIp(c), 'SOURCE_LOGOUT', undefined, `sub=${session.sub}`)
          .catch((err) => console.error('[sources-auth] audit logout échec:', (err as Error).message));
      }
      const headers = new Headers({ 'Cache-Control': 'no-store' });
      headers.append('Set-Cookie', clearSourceSessionCookie());
      headers.append('Set-Cookie', clearTxCookie());
      return new Response(null, { status: 204, headers });
    },
  }),

  // Repli front-channel : il ne remplace pas le back-channel, mais permet à
  // Keycloak de révoquer immédiatement une session si ce mode est activé dans
  // une instance déjà provisionnée. L'issuer est vérifié avant d'accepter le sid.
  registerApiRoute('/v1/source/frontchannel-logout', {
    method: 'GET',
    handler: async (c) => {
      const issuer = c.req.query('iss');
      const sid = c.req.query('sid');
      if (issuer === oidcIssuer() && sid) await deleteSourceSessionsByOidcSid(sid);
      const headers = new Headers({ 'Cache-Control': 'no-store' });
      headers.append('Set-Cookie', clearSourceSessionCookie());
      headers.append('Set-Cookie', clearTxCookie());
      return new Response(null, { status: 200, headers });
    },
  }),

  // Notification Keycloak serveur-à-serveur. Le sid/sub n'est jamais pris
  // directement dans le body : il doit être porté par un logout_token signé,
  // avec issuer, audience et événement backchannel vérifiés par jose.
  registerApiRoute('/v1/source/backchannel-logout', {
    method: 'POST',
    handler: async (c) => {
      const contentLength = Number(c.req.header('content-length') ?? '0');
      if (Number.isFinite(contentLength) && contentLength > 16_384) {
        return c.text('logout_token trop volumineux.', 413);
      }
      const body = await c.req.text();
      if (body.length > 16_384) return c.text('logout_token trop volumineux.', 413);
      const logoutToken = new URLSearchParams(body).get('logout_token');
      if (!logoutToken) return c.text('logout_token manquant.', 400);
      try {
        const { sid, sub, jti, iat } = await verifyOidcLogoutToken(logoutToken);
        await revokeSourceSessionsForLogout(
          jti,
          new Date(Math.max(Date.now(), (iat + 60 * 60) * 1000)).toISOString(),
          sid,
          sub,
        );
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
      } catch (err) {
        console.error('[oidc] backchannel logout refusé:', (err as Error).message);
        return c.text('logout_token invalide.', 400);
      }
    },
  }),
];
