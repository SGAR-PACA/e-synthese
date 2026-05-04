# E-Synthèse — Stack dev complète

Ce dépôt fait tourner toute la stack E-Synthèse en local **dans Docker uniquement** : le proxy RAG **Mastra** branché derrière l'UI **Conversations** (DINUM / La Suite Numérique).

```
Toi ──▶ http://localhost:3000  (UI Conversations)
              │
              ▼
        Backend Conversations ──▶ http://mastra:4111/v1  ──▶ Albert API
                                   (RAG, port exposé 4111)
```

> **Ce README couvre uniquement le test en local.** Pour le déploiement production, voir [DEPLOY.md](DEPLOY.md) (à venir).

---

## Ce que contient ce dépôt

Le projet est un assemblage de deux choses : Mastra et **des images Docker upstream non modifiées** (Conversations + ses dépendances). Le rôle de ce dépôt est de les faire tourner ensemble en local en HTTP simple.

### Mastra

`./mastra/` est un snapshot du proxy RAG Mastra — c'est le **vrai produit E-Synthèse** : pipeline RAG complet (search Albert + rerank + injection de contexte + génération LLM Albert), déguisé en endpoint OpenAI-compatible pour qu'un client comme Conversations puisse l'appeler comme un LLM standard.

### Ce qui vient de la DINUM (non modifié)

| Composant | Image | Rôle |
|---|---|---|
| `frontend-development` | `lasuite/conversations-frontend:main` (image docker) | UI de chat Next.js |
| `app-dev` | `lasuite/conversations-backend:main` (image docker) | API Django |
| `postgresql`, `redis`, `minio`, `keycloak`, `kc_postgresql`, `nginx`, `maildev` | Images officielles | Dépendances standards de Conversations (base, cache, stockage S3, OIDC, mail dev) — requises par les images upstream |

Aucun de ces composants n'est modifié — on les utilise tels quels.

### Ce qui est fait dans ce dépôt

Trois adaptations pour que la stack DINUM, conçue pour la prod (TLS + LLM unique), tourne en HTTP local et parle à Mastra à la place du LLM par défaut :

1. **`front-back/docker/files/etc/nginx/conf.d/frontend.conf`** — ajoute le `proxy_pass /api/ → app-dev:8000` (sans ça, l'UI boucle sur des 404).
2. **`front-back/docker/patches/local_settings.py`** — classe Django `LocalDev` qui hérite de `Production` mais désactive `SECURE_SSL_REDIRECT`, les cookies `Secure` et HSTS (incompatibles avec HTTP).
3. **`front-back/docker/patches/llm.json`** (généré depuis `llm.json.tpl` par `bootstrap.sh`) — remplace le `default.json` upstream par 3 modèles qui pointent tous vers `http://mastra:4111/v1` avec la `PROXY_API_KEY` injectée à la génération.

Plus le glue around : `compose.yml` pour orchestrer les 11 services, `scripts/bootstrap.sh` pour générer/synchroniser les secrets entre Mastra et Conversations, `scripts/rotate-proxy-key.sh` pour la rotation.

---

## Lancer le projet en local — pas à pas

Cette section part du principe que tu n'as **rien** d'installé en dehors de Docker.

### 1. Installer Docker

**macOS / Windows** : [Docker Desktop](https://www.docker.com/products/docker-desktop/).

**Linux (Debian/Ubuntu)** :

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

Vérifier :

```bash
docker info >/dev/null && echo OK
docker compose version    # doit afficher v2.x
```

### 2. Allouer assez de ressources à Docker (important)

La stack lance 11 services. Si Docker manque de ressources, **Postgres ou Mastra crashent silencieusement** au premier checkpoint avec une erreur `No space left on device`.

| Ressource | Minimum | Recommandé |
|---|---|---|
| RAM | 4 GB | **6 GB** |
| Espace disque virtuel | 30 GB libres | **64 GB libres** |
| CPU | 2 cores | 4 cores |

Sur Docker Desktop : **Settings → Resources → Advanced**.

`bootstrap.sh` fait un pré-check et avorte si moins de 10 GB sont libres. Pour libérer si saturé :

```bash
docker system prune -a --volumes -f       # peut récupérer 30-60 GB
```

### 3. Cloner et bootstrapper

```bash
git clone <url-du-depot>
cd E-synthese-final-dev

./scripts/bootstrap.sh
```

Premier démarrage : 5–10 min (téléchargement images + build Mastra). Le script :

1. Crée `.env` avec une `PROXY_API_KEY` aléatoire.
2. Rend `front-back/docker/patches/llm.json` depuis son template avec **la même clé** (Mastra et Conversations doivent partager la clé sinon `401` à chaque message).
3. Lance `docker compose up -d --build`.
4. Lance la migration Django.

Démarrages suivants : `docker compose up -d` suffit. `bootstrap.sh` n'est utile qu'à l'install initiale ou après un `down -v`.

### 4. Renseigner la clé Albert

Sans clé, la stack démarre mais l'assistant ne pourra pas répondre.

Récupère une clé sur https://albert.api.etalab.gouv.fr puis édite `.env` :

```env
ALBERT_API_KEY=ton-token-albert
```

Puis :

```bash
docker compose restart mastra
```

> Alternative : configurer la clé via http://localhost:4111/admin/settings — elle est stockée chiffrée en base SQLite Mastra et survit aux redémarrages.

### 5. URLs et comptes

| Service | URL | Identifiants |
|---|---|---|
| UI chat | http://localhost:3000 | `conversations@conversations.world` / `conversations` |
| Mastra (RAG) | http://localhost:4111/v1/models | Bearer `PROXY_API_KEY` |
| Mastra admin | http://localhost:4111/admin | À créer au 1er accès (setup) |
| Keycloak admin | http://localhost:8083/admin | `admin` / `admin` |
| MinIO console | http://localhost:9001 | `conversations` / `password` |
| Maildev | http://localhost:1081 | — |

---

## Arrêt et reset

```bash
docker compose down                # arrêt (conserve les données)
docker compose down -v             # reset total (vide Postgres, MinIO, SQLite Mastra, Keycloak)
```

Après un `down -v`, relancer `./scripts/bootstrap.sh` (les bases sont vierges, il faut les re-migrer).

---

## Statut du dépôt

| Branche | Usage |
|---|---|
| `mastra` | Proxy Mastra **seul** — code canonique, sans Conversations. Le vrai produit. |
| `dev` (ici) | Intégration complète en HTTP local — ce que tu lances quand tu développes |
| `main` | Intégration complète prête à déployer (Dokploy / Scaleway) |
