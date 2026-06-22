// mastra/src/routes/sources-auth.ts
import { registerApiRoute } from '@mastra/core/server';
import { timingSafeEqual } from 'node:crypto';
import {
  readSourceSession,
  makeSourceSessionCookie,
  signCookieValue,
  verifyCookieValue,
  safeReturnUrl,
} from '../lib/source-session.js';
import { beginLogin, completeLogin, type OidcTx } from '../lib/oidc.js';
import { checkRateLimit, recordFailedAttempt, resetRateLimit } from '../lib/auth.js';
import { getClientIp } from '../lib/middleware.js';

function rpKey(): string {
  const k = process.env.MASTRA_RP_COOKIE_KEY;
  if (!k) throw new Error('MASTRA_RP_COOKIE_KEY manquant');
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
  return 'src_oidc_tx=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/v1/source';
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

// Garde : session RP valide -> { sub }. Sinon -> 302 vers Keycloak (login silencieux).
export async function requireSourceSession(c: any): Promise<{ sub: string } | Response> {
  const key = rpKey();
  const session = readSourceSession(c.req.header('cookie'), key, Date.now());
  if (session) return session;

  const url = new URL(c.req.url);
  const returnUrl = url.pathname + (url.search || '');
  const { redirectUrl, tx } = beginLogin(returnUrl);
  return new Response(null, {
    status: 302,
    headers: { Location: redirectUrl, 'Set-Cookie': txCookie(tx, key) },
  });
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
      const tx = readTxCookie(c.req.header('cookie'), key);

      // state CSRF : doit correspondre exactement à la transaction (temps constant).
      if (!code || !state || !tx || !constantTimeEqual(state, tx.state)) {
        recordFailedAttempt(`oidc:${ip}`);
        return c.text('Échec de l\'authentification.', 401, { 'Set-Cookie': clearTxCookie() });
      }

      try {
        const { sub } = await completeLogin(code, tx);
        resetRateLimit(`oidc:${ip}`);
        // deux Set-Cookie : pose la session RP ET efface le cookie de transaction.
        const headers = new Headers();
        headers.append('Location', safeReturnUrl(tx.returnUrl));
        headers.append('Set-Cookie', makeSourceSessionCookie(sub, key));
        headers.append('Set-Cookie', clearTxCookie());
        return new Response(null, { status: 302, headers });
      } catch (err) {
        console.error('[oidc] callback échec:', (err as Error).message);
        recordFailedAttempt(`oidc:${ip}`);
        return c.text('Échec de l\'authentification.', 401, { 'Set-Cookie': clearTxCookie() });
      }
    },
  }),
];
