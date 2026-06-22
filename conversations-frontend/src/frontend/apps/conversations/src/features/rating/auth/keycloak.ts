import Keycloak from 'keycloak-js';

// Configuration injectée au build (export statique Next.js).
const KEYCLOAK_URL = process.env.NEXT_PUBLIC_KEYCLOAK_URL;
const KEYCLOAK_REALM = process.env.NEXT_PUBLIC_KEYCLOAK_REALM;
const CLIENT_ID = process.env.NEXT_PUBLIC_RATING_CLIENT_ID;

let keycloak: Keycloak | null = null;
let initPromise: Promise<boolean> | null = null;

// Initialise keycloak-js une seule fois, en check-sso silencieux (aucune
// redirection de la page principale). Renvoie true si une session SSO existe.
function ensureInit(): Promise<boolean> {
  if (typeof window === 'undefined') {
    return Promise.resolve(false);
  }
  if (!KEYCLOAK_URL || !KEYCLOAK_REALM || !CLIENT_ID) {
    console.warn('[notation] Keycloak non configuré (NEXT_PUBLIC_KEYCLOAK_*).');
    return Promise.resolve(false);
  }
  if (initPromise) {
    return initPromise;
  }
  // Pas de retry : si l'init échoue, le widget reste en lecture seule pour toute la session.
  keycloak = new Keycloak({
    url: KEYCLOAK_URL,
    realm: KEYCLOAK_REALM,
    clientId: CLIENT_ID,
  });
  initPromise = keycloak
    .init({
      onLoad: 'check-sso',
      silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
      pkceMethod: 'S256',
      checkLoginIframe: false,
    })
    .catch((err) => {
      console.error('[notation] échec init Keycloak :', err);
      return false;
    });
  return initPromise;
}

// Renvoie un jeton d'accès frais, ou null si pas de session SSO.
export async function getRatingToken(): Promise<string | null> {
  const authenticated = await ensureInit();
  if (!authenticated || !keycloak) {
    return null;
  }
  try {
    await keycloak.updateToken(30); // rafraîchit si <30 s de validité
  } catch (err) {
    console.error('[notation] échec rafraîchissement jeton :', err);
    return null;
  }
  return keycloak.token ?? null;
}
