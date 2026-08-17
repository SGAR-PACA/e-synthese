// mastra/src/lib/oidc.ts
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { buildAuthUrl, pkceChallenge, randomUrlToken } from './oidc-pkce.js';
import { extractGroups } from './collection-scope.js';

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
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error('id_token manquant');

  // jwtVerify : refuse alg:none, vérifie signature/exp/iss/aud.
  const { payload } = await jwtVerify(tokens.id_token, getJwks(c.internalUrl), {
    issuer: c.issuerPublic,
    audience: c.clientId,
  });
  if (payload.nonce !== tx.nonce) throw new Error('nonce invalide');
  if (typeof payload.sub !== 'string') throw new Error('sub invalide');
  // Groupes Keycloak (2b) : sert au contrôle d'appartenance à la collection dans
  // le visualiseur de sources. Nécessite les groupes/rôles dans l'id_token.
  return { sub: payload.sub, groups: extractGroups(payload) };
}
