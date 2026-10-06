# Frontend et backend Conversations

L'interface de chat et son backend proviennent de
[Conversations](https://github.com/suitenumerique/conversations), l'assistant
conversationnel de La Suite numérique (DINUM). E-Synthèse en modifie le moins
possible et remplace le modèle de langue par Mastra.

## Frontend : `conversations-frontend/`

### Origine

Copie du dossier `src/frontend` de Conversations au commit
`2ffffae4f0e35e2eac461c67034326a8292d7ca2` (version 0.0.18) : Next.js 16,
React 19, kit graphique de La Suite. L'application est exportée en fichiers
statiques et servie par nginx.

### Modifications

Chemins relatifs à `src/frontend/apps/conversations/`.

| Fichier | Modification |
|---|---|
| `src/features/rating/` (nouveau) | Widget de notation à cinq étoiles : connexion Keycloak silencieuse (client public `mastra-rating-spa`, PKCE), appels `POST/GET /v1/ratings` vers Mastra |
| `public/silent-check-sso.html` (nouveau) | Page utilisée par la connexion silencieuse |
| `src/features/chat/components/MessageItem.tsx` | Affiche le widget sous chaque réponse terminée |
| `src/features/chat/components/Chat.tsx` | Transmet la question au widget ; garde l'indicateur « réflexion » jusqu'au premier mot reçu |
| `src/features/chat/utils/chatLoading.ts` (nouveau, avec test) | Logique de cet indicateur |
| `src/features/auth/utils.ts` | À la déconnexion, ferme d'abord la session de la visionneuse (`POST /v1/source/logout`) |
| `src/features/auth/api/useAuthQuery.tsx` | Informations de session conservées 10 h au lieu de 15 min |
| `src/features/auth/components/UserInfo.tsx` | Lien vers les conditions d'utilisation |
| `src/i18n/initI18n.ts` | Français par défaut, langue du navigateur ignorée |
| `package.json` | Dépendance `keycloak-js` |
| `../../Dockerfile` | Paramètres de build Keycloak et notation |

Les logos restent ceux de Conversations ; seul le nom du produit
(`PRODUCT_NAME`) est personnalisé. Les libellés du widget de notation sont
écrits en français et ne sont pas traduits.

### Construction

Le service `frontend-development` de `compose.yml` construit l'image à partir de
`src/frontend/Dockerfile` (cible `frontend-production`) avec ces paramètres :

| Paramètre | Valeur |
|---|---|
| `API_ORIGIN` | `https://${DOMAIN_FRONT}` |
| `PRODUCT_NAME` | `${PRODUCT_NAME}` |
| `KEYCLOAK_URL` | `https://${DOMAIN_FRONT}/auth` |
| `KEYCLOAK_REALM` | `conversations` |
| `RATING_CLIENT_ID` | `mastra-rating-spa` |
| `RATING_API_URL` | `https://${DOMAIN_FRONT}` |

Ces valeurs sont figées dans les fichiers produits : changer de domaine impose
de reconstruire l'image.

Au démarrage, la configuration nginx de l'image est remplacée par
`front-back/docker/files/etc/nginx/conf.d/frontend.conf`, qui relaie `/api/`
vers le backend.

## Backend : `front-back/`

### Image

`front-back/docker/backend/Dockerfile` part de l'image officielle
`lasuite/conversations-backend`, figée par son empreinte (`sha256:337516…`,
commit `b8b5630`), et applique trois correctifs :

| Correctif | Effet |
|---|---|
| `patches/base.py.patch` | Ajoute l'en-tête `X-User-Token` (jeton Keycloak de l'utilisateur) aux appels vers le modèle |
| `patches/pydantic_ai.py.patch` | Récupère ce jeton dans la session de l'utilisateur |
| `patches/settings.py.patch` | Active le renouvellement automatique du jeton d'accès |

Sans ces correctifs, Mastra ne connaîtrait pas l'utilisateur et refuserait de
répondre. La construction échoue volontairement si un correctif ne s'applique
plus.

### Modèles proposés

`front-back/docker/patches/llm.json.tpl` déclare le fournisseur `mastra`
(`http://mastra:4111/v1`) et les modèles de l'interface :

| Modèle | Rôle |
|---|---|
| `default-model` → `e-synthese-rag` | « E-Synthèse RAG (Mastra) », modèle de chat |
| `default-summarization-model` → `e-synthese-rag` | Titres et résumés de conversation |
| `demo-model` → `demo` | Modèle factice, actif : à désactiver (`is_active: false`) pour le masquer |

Au démarrage, le conteneur `app-dev` remplace `__PROXY_API_KEY__` par la clé
réelle et écrit le résultat dans `/tmp/llm-custom.json`.

### Démarrage du conteneur

L'entrée du service `app-dev` (dans `compose.yml`) :

1. impose une session de 10 h au minimum ;
2. dérive de `DJANGO_SECRET_KEY` la clé de chiffrement des jetons stockés en
   session ;
3. génère `llm-custom.json` ;
4. applique les migrations ;
5. lance le serveur (uvicorn, port 8000).

Les réglages fixes sont dans `front-back/env.d/production/` (`common` pour
Django et l'OIDC, `postgresql` pour la base).

## Suivre les mises à jour de Conversations

Le frontend et le backend sont figés sur deux versions de Conversations
différentes, choisies ensemble au moment du fork. Les faire évoluer ensemble :

1. Choisir une version de Conversations et noter son commit.
2. **Backend** : remplacer l'empreinte de l'image dans
   `front-back/docker/backend/Dockerfile` et reconstruire. Si un correctif
   échoue, le refaire sur le nouveau code et régénérer le fichier `.patch`.
3. **Frontend** : récupérer le `src/frontend` de la même version dans un dossier
   à part, y reporter les modifications listées plus haut (l'historique Git de
   `conversations-frontend/` les isole), puis remplacer le dossier.
4. Tester en préproduction : connexion, question avec sources, notation,
   déconnexion.
