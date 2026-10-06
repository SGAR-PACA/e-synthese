# Architecture

## Services

Toute la pile est décrite dans `compose.yml` (projet Docker Compose
`e-synthese-prod`).

| Service | Image / construction | Rôle | Port interne |
|---|---|---|---|
| `frontend-development` | construit depuis `conversations-frontend/` | Interface de chat (export statique servi par nginx) ; relaie `/api/` vers le backend | 3000 |
| `app-dev` | construit depuis `front-back/docker/backend/` (image Conversations + correctifs) | Backend Django : conversations, utilisateurs, appels au modèle | 8000 |
| `mastra` | construit depuis `mastra/` | Pipeline RAG, administration, notation, visionneuse de sources | 4111 |
| `ocr` | construit depuis `ocr-service/` | OCR des PDF (OCRmyPDF + Tesseract français) | 8080 |
| `keycloak` | `quay.io/keycloak/keycloak:26.3` | Authentification (realm `conversations`), servi sous `/auth` | 8080 |
| `keycloak-provision-mastra-sources` | idem | Tâche ponctuelle : crée ou met à jour le client `mastra-sources` | – |
| `keycloak-provision-rating` | idem | Tâche ponctuelle : réglages du realm, client `mastra-rating-spa` | – |
| `postgresql` | `postgres:16` | Base de Conversations | 5432 |
| `mastra_postgresql` | `postgres:17.5` | Base de Mastra | 5432 |
| `kc_postgresql` | `postgres:17.5` | Base de Keycloak | 5432 |
| `redis` | `redis:5` | Cache et file de tâches de Conversations | 6379 |
| `minio` / `createbuckets` | `minio/minio`, `minio/mc` | Stockage des pièces jointes du chat (bucket `conversations-media-storage`) | 9000 |
| `mastra_backup` | construit depuis `front-back/docker/backup/` | Sauvegarde quotidienne des trois bases vers Scaleway | – |

Aucun port n'est publié sur l'hôte : seul le Traefik de Dokploy (80 et 443)
reçoit du trafic.

## Routage

Un seul domaine, `DOMAIN_FRONT`. Les règles sont portées par les labels Traefik
de `compose.yml` (certificat Let's Encrypt, point d'entrée `websecure`) :

| Chemin | Service | Remarque |
|---|---|---|
| `/auth/...` | `keycloak` | Console d'administration : `/auth/admin` |
| `/admin/...` et `/v1/...` | `mastra` | Priorité 100 : passe avant la règle générale |
| tout le reste | `frontend-development` | nginx sert l'interface et relaie `/api/` vers `app-dev:8000` |

Le relais nginx est configuré dans `front-back/docker/files/etc/nginx/conf.d/frontend.conf`
(tampons désactivés et délai de 300 s pour que les réponses arrivent en continu).

## Réseaux

| Réseau | Membres | Rôle |
|---|---|---|
| `dokploy-network` (externe) | frontend, keycloak, mastra | Atteignables par Traefik |
| `lasuite` | frontend, app-dev, keycloak, mastra | Échanges entre l'interface, le backend et l'authentification |
| `internal` (sans accès sortant) | mastra, ocr | Le service OCR n'a aucun accès à Internet |
| `default` | tous | Accès aux bases de données |

## Données persistantes

| Volume | Contenu | Sauvegardé |
|---|---|---|
| `postgres_data` | Conversations : utilisateurs, conversations, messages | oui (quotidien, S3) |
| `mastra_postgres_data` | Mastra : configuration, comptes admin, documents, journaux, évaluations, notes | oui (quotidien, S3) |
| `kc_postgres_data` | Keycloak : comptes, rôles, sessions | oui (quotidien, S3) |
| `minio_data` | Pièces jointes déposées dans le chat | non |
| `redis_data` | Cache | inutile |
| `keycloak_data` | Fichier du realm généré au démarrage | inutile |

Les **PDF du corpus** ne sont pas dans un volume : ils sont stockés dans le
bucket Scaleway désigné par `S3_DOCS_BUCKET`, et leur texte est indexé dans les
collections d'Albert API.

## Ordre de démarrage

1. Les trois bases PostgreSQL et Redis.
2. Keycloak (contrôle de santé), puis les deux tâches de provisionnement.
3. Mastra, une fois `keycloak-provision-mastra-sources` terminé avec succès.
4. Le backend `app-dev`, une fois Mastra en bonne santé : il applique les
   migrations Django puis démarre.
5. Le frontend.

Si le provisionnement Keycloak échoue, Mastra ne démarre pas, et le backend non
plus.

## Authentification

Trois mécanismes coexistent.

| Qui | Où | Mécanisme |
|---|---|---|
| Agents (utilisateurs du chat) | interface `/` | Keycloak, client confidentiel `conversations`, géré par le backend Django |
| Agents ouvrant une source | `/v1/source/...` | Keycloak, client confidentiel `mastra-sources` (connexion silencieuse grâce au SSO) |
| Agents notant une réponse | widget du chat → `/v1/ratings` | Keycloak, client public `mastra-rating-spa` (PKCE) |
| Administrateurs Mastra | `/admin` | **Comptes locaux à Mastra**, indépendants de Keycloak |

Les sessions durent 10 heures partout (SSO Keycloak, session Django, session de
la visionneuse) et la déconnexion est propagée : se déconnecter du chat ferme
aussi la session de la visionneuse.

### Droits d'accès aux documents

Les documents sont rangés dans des **collections** Albert. L'accès est accordé
par rôle Keycloak :

1. Dans Keycloak, chaque utilisateur reçoit un ou plusieurs **rôles de realm**
   (par exemple un rôle par service).
2. Dans l'admin Mastra, page **Groupes**, chaque rôle est associé à une ou
   plusieurs collections.
3. À chaque question, Mastra lit les rôles du jeton de l'utilisateur et ne
   cherche que dans les collections autorisées. La visionneuse applique la même
   règle avant d'afficher un PDF.

Le rôle `admin` (nom réglable par `MASTRA_ADMIN_GROUP`, casse indifférente)
donne accès à toutes les collections. Un utilisateur sans rôle associé ne trouve
aucun document.

Mastra lit aussi la revendication `groups` du jeton si un mapper de groupes est
ajouté dans Keycloak ; la configuration actuelle utilise les rôles de realm.

## Parcours d'une question

1. L'utilisateur écrit dans l'interface. Le frontend appelle `/api/v1.0/...` ;
   nginx relaie vers le backend Django.
2. Le backend appelle Mastra comme un fournisseur compatible OpenAI
   (`http://mastra:4111/v1/chat/completions`, modèle `e-synthese-rag`), avec la
   clé `PROXY_API_KEY` et le jeton Keycloak de l'utilisateur dans l'en-tête
   `X-User-Token`.
3. Mastra vérifie le jeton, détermine les collections autorisées, puis exécute
   le pipeline : planification, recherche dans Albert, rerank, rédaction (voir
   [Pipeline RAG](pipeline-rag.md)).
4. La réponse est renvoyée en flux continu. Le bloc « Sources » final contient
   des liens signés vers la visionneuse.
5. Le backend enregistre le message ; l'utilisateur peut le noter (widget à
   cinq étoiles), la note étant envoyée directement à Mastra.

## Appels à Albert API

Mastra est le seul composant qui appelle Albert. Tous les appels passent par un
limiteur global (`ALBERT_MAX_RPM`, 8 requêtes par minute par défaut) avec deux
files : les réponses au chat sont prioritaires sur l'ingestion et l'évaluation.
Ce compteur étant en mémoire, il ne faut faire tourner **qu'une seule instance**
de Mastra.
