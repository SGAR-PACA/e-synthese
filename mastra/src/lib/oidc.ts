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
}

export function beginLogin(returnUrl: string): { redirectUrl: string; tx: OidcTx } {
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
  });
  return { redirectUrl, tx: { state, nonce, verifier, returnUrl } };
}

export async function completeLogin(code: string, tx: OidcTx): Promise<{ sub: string; groups: string[] }> {
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
  return { sub: payload.sub, groups: mergeTokenGroups(payload, accessPayload) };
}
