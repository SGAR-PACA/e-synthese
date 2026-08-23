// mastra/src/lib/oidc.ts
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { buildAuthUrl, pkceChallenge, randomUrlToken } from './oidc-pkce.js';
import { extractGroups } from './collection-scope.js';

// Fusionne les groupes/rôles de l'id_token ET (si présent) de l'access_token. PURE.
// Pourquoi : Keycloak ne met pas forcément `realm_access.roles` dans l'id_token
// (mapper « Add to ID token » absent sur le client), MAIS l'access_token les porte
// par défaut. La visionneuse lisait le seul id_token → groupes vides → 403 même sur
// une collection autorisée. L'union garantit qu'elle voit les mêmes rôles que le chat
// (qui, lui, s'appuie sur l'access_token).
export function mergeTokenGroups(idPayload: JWTPayload, accessPayload?: JWTPayload | null): string[] {
  const fromId = extractGroups(idPayload);
  if (!accessPayload) return fromId;
  return [...new Set([...fromId, ...extractGroups(accessPayload)])];
}

interface OidcConfig {
  issuerPublic: string;   // iss attendu (URL publique Keycloak)
  internalUrl: string;    // back-channel (token + certs)
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function cfg(): OidcConfig {
  const issuerPublic = process.env.MASTRA_OIDC_ISSUER;
  const internalUrl = process.env.MASTRA_OIDC_INTERNAL_URL;
  const clientId = process.env.MASTRA_OIDC_CLIENT_ID;
  const clientSecret = process.env.MASTRA_OIDC_CLIENT_SECRET;
  const redirectUri = process.env.MASTRA_OIDC_REDIRECT_URI;
  if (!issuerPublic || !internalUrl || !clientId || !clientSecret || !redirectUri) {
    throw new Error('Configuration OIDC incomplète (MASTRA_OIDC_*)');
  }
  return { issuerPublic, internalUrl, clientId, clientSecret, redirectUri };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
function getJwks(internalUrl: string) {
  if (!jwks) jwks = createRemoteJWKSet(new URL(`${internalUrl}/protocol/openid-connect/certs`));
  return jwks;
}

export interface OidcTx {
  state: string;
  nonce: string;
  verifier: string;
  returnUrl: string;
  // true for the first attempt from the viewer. If Keycloak has no active
  // SSO session, the callback transparently restarts the flow interactively.
  silent?: boolean;
}

export function beginLogin(returnUrl: string, silent = false): { redirectUrl: string; tx: OidcTx } {
  const c = cfg();
  const state = randomUrlToken();
  const nonce = randomUrlToken();
  const verifier = randomUrlToken();
  const redirectUrl = buildAuthUrl(`${c.issuerPublic}/protocol/openid-connect/auth`, {
    clientId: c.clientId,
    redirectUri: c.redirectUri,
    state,
    nonce,
    challenge: pkceChallenge(verifier),
    prompt: silent ? 'none' : undefined,
  });
  return { redirectUrl, tx: { state, nonce, verifier, returnUrl, silent } };
}

export async function completeLogin(
  code: string,
  tx: OidcTx,
): Promise<{ sub: string; groups: string[]; oidcSid?: string }> {
  const c = cfg();
  const res = await fetch(`${c.internalUrl}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: c.redirectUri,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code_verifier: tx.verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`token endpoint status ${res.status}`);
  const tokens = (await res.json()) as { id_token?: string; access_token?: string };
  if (!tokens.id_token) throw new Error('id_token manquant');

  // jwtVerify : refuse alg:none, vérifie signature/exp/iss/aud.
  const { payload } = await jwtVerify(tokens.id_token, getJwks(c.internalUrl), {
    issuer: c.issuerPublic,
    audience: c.clientId,
  });
  if (payload.nonce !== tx.nonce) throw new Error('nonce invalide');
  if (typeof payload.sub !== 'string') throw new Error('sub invalide');

  // Groupes Keycloak (2b) : contrôle d'appartenance à la collection dans la visionneuse.
  // On les lit dans l'id_token ET dans l'access_token : Keycloak ne met pas forcément
  // `realm_access.roles` dans l'id_token, mais l'access_token les porte par défaut.
  // L'access_token est vérifié en signature+issuer (son `aud` diffère du client, donc
  // PAS de contrôle d'audience) ; best-effort : s'il est opaque/non vérifiable, on
  // garde les seuls groupes de l'id_token sans casser le login.
  let accessPayload: JWTPayload | null = null;
  if (tokens.access_token) {
    try {
      accessPayload = (
        await jwtVerify(tokens.access_token, getJwks(c.internalUrl), { issuer: c.issuerPublic })
      ).payload;
    } catch (err) {
      console.error('[oidc] access_token inexploitable pour les rôles:', (err as Error).message);
    }
  }
  const oidcSid =
    typeof (payload as Record<string, unknown>).sid === 'string'
      ? ((payload as Record<string, unknown>).sid as string)
      : typeof (payload as Record<string, unknown>).session_state === 'string'
        ? ((payload as Record<string, unknown>).session_state as string)
        : undefined;
  return { sub: payload.sub, groups: mergeTokenGroups(payload, accessPayload), oidcSid };
}

/** Issuer public attendu par les notifications de logout Keycloak. */
export function oidcIssuer(): string {
  return cfg().issuerPublic;
}

/**
 * Valide un logout_token OIDC Back-Channel Logout 1.0.
 * Aucun sid/sub fourni par le client HTTP n'est accepté sans signature IdP.
 */
export async function verifyOidcLogoutToken(
  logoutToken: string,
): Promise<{ sid?: string; sub?: string; jti: string; iat: number }> {
  const c = cfg();
  const { payload } = await jwtVerify(logoutToken, getJwks(c.internalUrl), {
    issuer: c.issuerPublic,
    audience: c.clientId,
  });
  if (payload.nonce !== undefined) throw new Error('logout_token ne doit pas contenir nonce');
  if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
    throw new Error('jti manquant dans logout_token');
  }
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    throw new Error('iat manquant dans logout_token');
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.iat > now + 60 || payload.iat < now - 60 * 60) {
    throw new Error('iat hors fenêtre dans logout_token');
  }

  const events = (payload as Record<string, unknown>).events;
  const backchannelEvent = 'http://schemas.openid.net/event/backchannel-logout';
  if (!events || typeof events !== 'object' || Array.isArray(events) || !(backchannelEvent in events)) {
    throw new Error('événement backchannel-logout manquant');
  }

  const sid = typeof (payload as Record<string, unknown>).sid === 'string'
    ? ((payload as Record<string, unknown>).sid as string)
    : undefined;
  const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
  if (!sid && !sub) throw new Error('sid/sub manquant dans logout_token');
  return { sid, sub, jti: payload.jti, iat: payload.iat };
}
