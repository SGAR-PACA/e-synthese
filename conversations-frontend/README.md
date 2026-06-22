# conversations-frontend — fork vendoré

Front open source **suitenumerique/conversations** vendoré (copié) dans ce repo
pour y ajouter un widget de notation (5 étoiles + commentaire) sous les réponses
de l'IA. Le reste de la stack Conversations (backend Django, Keycloak) reste
consommé tel quel via images Docker.

- **Origine :** https://github.com/suitenumerique/conversations
- **Commit vendoré :** `2ffffae4f0e35e2eac461c67034326a8292d7ca2`
- **Contexte de build Docker :** ce dossier (`conversations-frontend/`).
  Dockerfile : `src/frontend/Dockerfile`, cible `frontend-production`.

## Modifications par rapport à l'upstream

Tout le code de notation est isolé dans
`src/frontend/apps/conversations/src/features/rating/`. Seules modifications de
fichiers upstream existants :

- `src/frontend/apps/conversations/src/features/chat/components/MessageItem.tsx`
  — rendu du `<RatingWidget>` sous chaque réponse de l'IA + prop `question`.
- `src/frontend/apps/conversations/src/features/chat/components/Chat.tsx`
  — calcule la question utilisateur précédant chaque réponse et la transmet à
  `MessageItem` (prop `question`, pour stocker le couple question/réponse).
- `src/frontend/Dockerfile` — 4 `ARG`/`ENV` `NEXT_PUBLIC_*` (config Keycloak +
  URL API notation) dans l'étape `conversations-builder`.
- `src/frontend/apps/conversations/public/silent-check-sso.html` — ajout (page
  du check-sso silencieux keycloak-js).
- `src/frontend/apps/conversations/package.json` — ajout de la dépendance
  `keycloak-js`.

## Configuration au build (variables `NEXT_PUBLIC_*`)

Le front est un export statique : la config publique est injectée au build via
des `ARG` Docker (voir `src/frontend/Dockerfile` et `compose.yml`).

- `KEYCLOAK_URL` → `NEXT_PUBLIC_KEYCLOAK_URL` = `https://<DOMAIN_FRONT>/auth`
- `KEYCLOAK_REALM` → `NEXT_PUBLIC_KEYCLOAK_REALM` = `conversations`
- `RATING_CLIENT_ID` → `NEXT_PUBLIC_RATING_CLIENT_ID` = `mastra-rating-spa`
- `RATING_API_URL` → `NEXT_PUBLIC_RATING_API_URL` = base Mastra (sans slash final)

## Client Keycloak requis

Un client SSO **public** `mastra-rating-spa` (PKCE S256) doit exister dans le
realm `conversations`. Il est déclaré dans
`front-back/docker/auth/realm.prod.json.tpl` (importé au premier boot Keycloak).
Pour un déploiement existant, le créer à la main dans l'admin Keycloak :
Standard flow ON, PKCE S256, Valid redirect URIs `https://<DOMAIN_FRONT>/*`,
Web origins `https://<DOMAIN_FRONT>`, + un mapper « Audience » ajoutant
`mastra-rating-spa` à l'access token.

## Mettre à jour depuis l'upstream

1. `git clone --depth 1 https://github.com/suitenumerique/conversations /tmp/conv-new`
2. Comparer `src/frontend` et reporter les modifications listées ci-dessus.
3. Mettre à jour le SHA ci-dessus.
