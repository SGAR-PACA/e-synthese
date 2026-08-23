import { LOGIN_URL, LOGOUT_URL, PATH_AUTH_LOCAL_STORAGE } from './conf';

export const getAuthUrl = () => {
  const path_auth = localStorage.getItem(PATH_AUTH_LOCAL_STORAGE);
  if (path_auth) {
    localStorage.removeItem(PATH_AUTH_LOCAL_STORAGE);
    return path_auth;
  }
};

export const setAuthUrl = () => {
  if (window.location.pathname !== '/') {
    localStorage.setItem(PATH_AUTH_LOCAL_STORAGE, window.location.pathname);
  }
};

export const gotoLogin = (withRedirect = true) => {
  if (withRedirect) {
    setAuthUrl();
  }

  window.location.replace(LOGIN_URL);
};

export const gotoLogout = () => {
  // Révoque d'abord la session opaque de la visionneuse sur le même domaine.
  // Le logout Conversations ci-dessous termine ensuite la session Django et
  // la session SSO Keycloak (OIDC_OP_LOGOUT_ENDPOINT). Si Mastra est momentanément
  // indisponible, on poursuit quand même le logout principal.
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2000);
  void fetch('/v1/source/logout', {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    signal: controller.signal,
  })
    .catch(() => undefined)
    .finally(() => {
      window.clearTimeout(timeout);
      window.location.replace(LOGOUT_URL);
    });
};
