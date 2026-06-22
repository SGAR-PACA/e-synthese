// mastra/src/lib/rating-auth.ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
function getJwks(internalUrl: string) {
  if (!jwks) jwks = createRemoteJWKSet(new URL(`${internalUrl}/protocol/openid-connect/certs`));
  return jwks;
}

// Valide le jeton Keycloak du widget de notation (client public mastra-rating-spa).
// Identité issue du jeton validé, jamais du body. Réutilise le JWKS/issuer du Plan 3.
export async function requireRatingUser(c: any): Promise<{ sub: string; email: string | null } | Response> {
  const header = c.req.header('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return c.json({ error: 'Unauthorized' }, 401);

  const issuer = process.env.MASTRA_OIDC_ISSUER;
  const internalUrl = process.env.MASTRA_OIDC_INTERNAL_URL;
  const audience = process.env.MASTRA_RATING_AUDIENCE;
  if (!issuer || !internalUrl || !audience) return c.json({ error: 'Notation non configurée' }, 503);

  try {
    const { payload } = await jwtVerify(m[1].trim(), getJwks(internalUrl), { issuer, audience });
    if (typeof payload.sub !== 'string') return c.json({ error: 'Unauthorized' }, 401);
    const email = typeof payload.email === 'string' ? payload.email : null;
    return { sub: payload.sub, email };
  } catch (err) {
    console.error('[ratings] jeton invalide:', (err as Error).message);
    return c.json({ error: 'Unauthorized' }, 401);
  }
}
