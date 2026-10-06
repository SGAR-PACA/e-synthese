# Variables d'environnement

Les variables sont saisies dans Dokploy (onglet **Environment**) ; le modèle est
`.env.example.prod`. Celles marquées **requise** bloquent le démarrage si elles
sont vides.

Pour les réglages du pipeline, la valeur enregistrée dans l'admin Mastra
(page **Configuration**) est prioritaire sur la variable, qui ne sert alors que
de valeur initiale.

## Domaine et interface

| Variable | Défaut | Rôle |
|---|---|---|
| `DOMAIN_FRONT` | – | **Requise.** Domaine unique de l'application |
| `PRODUCT_NAME` | `Assistant` | Nom affiché dans l'interface ; intégré au build du frontend |

## Mastra

| Variable | Défaut | Rôle |
|---|---|---|
| `PROXY_API_KEY` | – | **Requise.** Clé partagée avec le backend Conversations, 16 caractères au moins (préfixe `sk-proxy-` par convention) |
| `ENCRYPTION_KEY` | – | **Requise.** 64 caractères hexadécimaux ; chiffre la clé Albert en base |
| `MASTRA_DB_PASSWORD` | – | **Requise.** Base PostgreSQL de Mastra |
| `ALBERT_API_KEY` | – | **Requise.** Recopiée chiffrée en base au premier démarrage |
| `ALBERT_API_BASE_URL` | `https://albert.api.etalab.gouv.fr` | Adresse d'Albert |
| `ALBERT_MAX_RPM` | `8` | Requêtes par minute vers Albert (1 à 100) |

### Génération

| Variable | Défaut | Rôle |
|---|---|---|
| `LLM_MODEL` | `openweight-large` | Modèle de rédaction |
| `LLM_TEMPERATURE` | `0.2` | Température |
| `LLM_TOP_P` | `1` | Top P (1 = désactivé) |
| `LLM_MAX_OUTPUT_TOKENS` | `2048` | Longueur maximale de réponse (256 à 4 096) |

### Recherche

| Variable | Défaut | Rôle |
|---|---|---|
| `MAX_SEARCH_QUERIES` | `2` | Reformulations de la question (1 à 4) |
| `SEARCH_WIDE_K` | `20` | Résultats par recherche |
| `FINAL_K` | `8` | Passages transmis au rédacteur |
| `USE_RERANK` | `true` | Reclassement des passages par Albert |
| `RERANK_MIN_SCORE` | `0.2` | Seuil minimal après rerank |
| `MIN_SCORE` | `0.5` | Seuil minimal sans rerank |
| `SEARCH_K` | `5` | Hérité, sans effet sur le chat |
| `DEFAULT_COLLECTIONS` | – | Hérité : collections utilisées par le juge appelé sans contexte d'utilisateur |

### Évaluation automatique

| Variable | Défaut | Rôle |
|---|---|---|
| `ALBERT_JUDGE_MODEL` | `deepseek-v4-flash` | Modèle juge, différent du modèle de rédaction |
| `JUDGE_TEMPERATURE` | `0` | Température du juge |
| `JUDGE_MAX_COMPLETION_TOKENS` | `512` | Longueur maximale de la réponse du juge |
| `EVAL_SAMPLING_RATE` | `0.1` | Part des réponses évaluées (0 à 1) |
| `EVAL_WIDE_SEARCH` | `false` | Recherche supplémentaire pour le juge |
| `EVAL_WIDE_K` | `20` | Taille de cette recherche |

### Documents et OCR

| Variable | Défaut | Rôle |
|---|---|---|
| `S3_DOCS_BUCKET` | – | Bucket des PDF. **Vide : ingestion et visionneuse désactivées** |
| `S3_DOCS_ENDPOINT` | `https://s3.fr-par.scw.cloud` | Point d'accès S3 |
| `S3_DOCS_REGION` | `fr-par` | Région |
| `S3_DOCS_ACCESS_KEY`, `S3_DOCS_SECRET_KEY` | – | Clé IAM du bucket |
| `OCR_SERVICE_URL` | `http://ocr:8080` | Fixé dans `compose.yml` |
| `ALBERT_LOCAL_PDF_CHUNK_SIZE` | `1900` | Taille des passages en caractères (256 à 6 000), non transmise par `compose.yml` |

### Authentification et visionneuse

| Variable | Défaut | Rôle |
|---|---|---|
| `MASTRA_OIDC_CLIENT_SECRET` | – | **Requise.** Secret du client `mastra-sources`, appliqué dans Keycloak à chaque déploiement |
| `MASTRA_RP_COOKIE_KEY` | – | **Requise.** Signe le cookie de connexion (32 caractères au moins) |
| `MASTRA_SOURCE_LINK_KEY` | – | Signe les liens de sources (32 caractères au moins). Vide : sources non cliquables |
| `MASTRA_SOURCE_SESSION_TTL_SECONDS` | `36000` | Session de la visionneuse, bornée entre 10 h et 24 h |
| `MASTRA_SOURCE_LINK_TTL_SECONDS` | 30 jours | Validité d'un lien de source (non transmise par `compose.yml`) |
| `MASTRA_OIDC_ISSUER` | `https://${DOMAIN_FRONT}/auth/realms/conversations` | Émetteur public des jetons |
| `MASTRA_OIDC_INTERNAL_URL` | `http://keycloak:8080/auth/realms/conversations` | Adresse interne de Keycloak |
| `MASTRA_OIDC_CLIENT_ID` | `mastra-sources` | Client de la visionneuse |
| `MASTRA_OIDC_REDIRECT_URI` | `https://${DOMAIN_FRONT}/v1/source/callback` | Retour après connexion |
| `MASTRA_OIDC_BACKCHANNEL_LOGOUT_URL` | `http://mastra:4111/v1/source/backchannel-logout` | Déconnexion propagée par Keycloak |
| `MASTRA_RATING_AUDIENCE` | `mastra-rating-spa` | Client attendu dans les jetons de notation |
| `MASTRA_RATING_CORS_ORIGIN` | vide | Origines autorisées ; inutile tant que tout est sur le même domaine |
| `MASTRA_ADMIN_GROUP` | `admin` | Rôle donnant accès à toutes les collections (non transmise par `compose.yml`) |
| `MASTRA_REQUIRE_USER_TOKEN` | exigé | `false` autorise le chat sans jeton utilisateur, donc sans filtrage : réservé aux tests |
| `MASTRA_CHAT_AUDIENCE` | – | Audience exigée pour `X-User-Token` (facultatif) |

Les variables notées « non transmises par `compose.yml` » ne sont lues que si on
les ajoute à la section `environment` du service `mastra`.

## Conversations (backend Django)

| Variable | Défaut | Rôle |
|---|---|---|
| `DJANGO_SECRET_KEY` | – | **Requise.** Clé Django ; sert aussi à chiffrer les jetons OIDC stockés en session |
| `DJANGO_EMAIL_BRAND_NAME` | – | Nom dans les e-mails |
| `POSTGRES_PASSWORD` | – | **Requise.** Base de Conversations |
| `OIDC_RP_CLIENT_SECRET` | – | **Requise.** Secret du client `conversations` (à régénérer dans Keycloak) |
| `CONVERSATIONS_SESSION_COOKIE_AGE` | `36000` | Durée de session (10 h au minimum) |
| `AWS_S3_SECRET_ACCESS_KEY` | – | **Requise.** Mot de passe MinIO (pièces jointes) |
| `EMAIL_HOST` | – | **Requise.** Serveur SMTP |
| `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASSWORD` | port `587` | Port et identifiants SMTP (TLS) |

Les réglages fixes du backend (adresses internes de Keycloak, MinIO, journaux)
sont dans `front-back/env.d/production/common`.

## Keycloak

| Variable | Rôle |
|---|---|
| `KC_DB_PASSWORD` | **Requise.** Base de Keycloak |
| `KEYCLOAK_ADMIN_PASSWORD` | **Requise.** Compte `admin` de la console |

## Sauvegardes

| Variable | Rôle |
|---|---|
| `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` | **Requises.** Clé IAM du bucket de sauvegarde |

Le reste (nom du bucket, point d'accès, rétention de 30 jours,
bases à sauvegarder) est dans `front-back/env.d/production/backup`. L'intervalle
entre deux sauvegardes (`BACKUP_INTERVAL_SECONDS`, 86 400 s) peut y être ajouté.
