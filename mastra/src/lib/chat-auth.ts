// Validation du token Keycloak de l'utilisateur final, transmis par le backend
// Django via l'en-tête `X-User-Token` (le chat passe par Django, pas en direct ;
// Django ajoute ce header — cf. patch image dérivée). Identité issue du token
// validé, jamais du body. Réutilise le JWKS/issuer du realm `conversations`.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
function getJwks(internalUrl: string) {
  if (!jwks) jwks = createRemoteJWKSet(new URL(`${internalUrl}/protocol/openid-connect/certs`));
  return jwks;
}

// Résultats possibles :
//  - Response  : token ABSENT (fail-closed par défaut → 401) ou INVALIDE (401).
//  - null      : token absent MAIS mode transition EXPLICITEMENT activé
//                (`MASTRA_REQUIRE_USER_TOKEN=false`) → l'appelant garde le
//                comportement non restreint. Opt-in conscient uniquement.
//  - JWTPayload: token validé (signature + issuer, audience optionnelle).
export async function verifyForwardedUserToken(c: any): Promise<JWTPayload | null | Response> {
  const raw = c.req.header('x-user-token');
  if (!raw) {
    // Fail-closed : sans token utilisateur, on REFUSE par défaut. La tolérance
    // (avant que Django ne forwarde le token) est un opt-in explicite.
    if (process.env.MASTRA_REQUIRE_USER_TOKEN === 'false') return null;
    return c.json({ error: 'Missing user token' }, 401);
  }

  const token = raw.replace(/^Bearer\s+/i, '').trim();
  const issuer = process.env.MASTRA_OIDC_ISSUER;
  const internalUrl = process.env.MASTRA_OIDC_INTERNAL_URL;
  if (!issuer || !internalUrl) {
    // Mal configuré : on ne peut pas valider → on refuse plutôt que d'ouvrir.
    console.error('[chat-auth] OIDC non configuré (MASTRA_OIDC_ISSUER/INTERNAL_URL)');
    return c.json({ error: 'User token verification unavailable' }, 503);
  }

  try {
    const audience = process.env.MASTRA_CHAT_AUDIENCE; // optionnelle (access token conversations)
    const opts: Parameters<typeof jwtVerify>[2] = audience ? { issuer, audience } : { issuer };
    const { payload } = await jwtVerify(token, getJwks(internalUrl), opts);
    return payload;
  } catch (err) {
    console.error('[chat-auth] token utilisateur invalide:', (err as Error).message);
    return c.json({ error: 'Invalid user token' }, 401);
  }
}
