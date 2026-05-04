# E-Synthèse — Proxy RAG Mastra

Ce dépôt est un backend qui se branche entre une UI de chat et un LLM, et qui transforme à la volée chaque question en **recherche documentaire augmentée** (RAG) sans que l'UI ne s'en rende compte.

> **Ce README couvre uniquement le test en local.** Pour le déploiement production, voir [DEPLOY.md](DEPLOY.md).

---

## C'est quoi le projet ?

**E-Synthèse** est un projet de l'administration française, porté par le **SGAR PACA** (Secrétariat Général aux Affaires Régionales de Provence-Alpes-Côte d'Azur). L'objectif : permettre aux agents publics de poser des questions sur leurs documents internes (notes, circulaires, rapports) et d'obtenir des réponses **sourcées**, plutôt que des réponses inventées par un LLM générique.

### Le contexte

- **Albert** est le LLM souverain de l'État français, hébergé par l'incubateur Etalab (https://albert.api.etalab.gouv.fr). Il expose une API OpenAI-compatible **plus** un système de RAG complet (collections de documents, recherche sémantique, reranking, embeddings).
- **Albert Conversation** est l'UI de chat développée par la DINUM / La Suite numérique. Comme tout client OpenAI-compatible, elle peut être configurée pour parler à n'importe quel endpoint qui ressemble à `https://api.openai.com/v1`.

### Le problème

Albert Conversation, par défaut, parle directement au LLM Albert. Le modèle répond avec ses connaissances générales — il ne sait rien des documents internes du SGAR. On veut que les utilisateurs aient des réponses **basées sur leurs documents**, avec citations, sans changer l'UI qu'ils utilisent déjà.

### La solution

On fabrique un **faux endpoint OpenAI** : un serveur qui ressemble en tous points à `api.openai.com/v1`, mais qui, en coulisses, fait un pipeline RAG complet sur l'API Albert avant de renvoyer la réponse. Albert Conversation pense parler à un LLM standard ; en réalité, chaque message déclenche une recherche dans les collections SGAR.

```
Albert Conversation ──▶ E-Synthèse (proxy RAG déguisé) ──▶ Albert API
       (l'UI)             (Mastra + Hono + SQLite)        (etalab.gouv.fr)
```

C'est ce que fait ce dépôt.

---

## Comment ça marche concrètement

À chaque appel `POST /v1/chat/completions`, le serveur exécute en interne :

1. **Recherche sémantique** dans les collections Albert configurées (`/v1/search` côté Albert).
2. **Reranking** des chunks remontés via `BAAI/bge-reranker-v2-m3` pour ne garder que les plus pertinents (`/v1/rerank`).
3. **Injection** des chunks retenus dans le prompt système qui sera envoyé au LLM.
4. **Génération** de la réponse finale par le LLM Albert (`/v1/chat/completions` côté Albert).
5. **Retour** au format OpenAI standard (`choices[0].message.content`), avec un bloc `Sources :` final qui liste les documents cités.

Le streaming SSE (`"stream": true`) est supporté : la réponse arrive token par token comme avec n'importe quel LLM OpenAI.

À côté de l'API publique, le serveur expose une **interface admin** (à `/admin`) où l'on configure la clé Albert, les collections actives, le prompt système, et où l'on gère les utilisateurs (admins / éditeurs avec collections restreintes).

---

## C'est quoi Mastra ?

[Mastra](https://mastra.ai) est un framework TypeScript pour construire des **agents LLM**. Sans framework, il aurait fallu réécrire à la main toute la plomberie pour que :

- un LLM puisse décider d'appeler des **outils** (search, rerank) avant de répondre,
- les appels d'outils soient parsés, exécutés, et leurs résultats réinjectés dans la conversation,
- le tout soit exposé derrière un serveur HTTP avec streaming SSE,
- le format de sortie ressemble exactement à celui d'OpenAI.

Mastra fournit ces briques prêtes à l'emploi. Dans ce projet, on en utilise quatre :

| Brique Mastra | Rôle ici | Fichier |
|---|---|---|
| `Agent` | L'objet central : combine un LLM, des instructions système, et une liste d'outils. C'est lui qui orchestre le pipeline RAG. | `src/mastra/agents/rag-agent.ts` |
| `Tool` | Une fonction que l'agent peut appeler. On en a deux : `search-rag` et `rerank-chunks`. | `src/mastra/tools/` |
| `Gateway` | Couche d'abstraction pour parler à un fournisseur LLM. On a écrit une `AlbertGateway` custom qui pointe vers `albert.api.etalab.gouv.fr`. | `src/mastra/gateways/albert.ts` |
| `registerApiRoute` | Câble une route HTTP (Hono sous le capot) sur le serveur Mastra — c'est par là qu'on expose `/v1/chat/completions`, `/v1/models`, l'admin, etc. | `src/routes/` |

Le **tour de passe-passe** central tient en quelques lignes (`src/routes/chat-completions.ts`) :

1. Une route Mastra écoute sur `/v1/chat/completions`.
2. Elle appelle `ragAgent.generate(messages)` ou `.stream(messages)`.
3. L'agent, suivant ses instructions, appelle `search-rag` puis `rerank-chunks`, puis le LLM Albert.
4. La sortie est reformatée en JSON OpenAI (`chatcmpl-...`, `choices[]`, `usage`, etc.) et renvoyée.

Pour le client, c'est indiscernable d'un appel à OpenAI ou à n'importe quel autre LLM.

---

## Stack

- **Mastra** — agent RAG, tools, gateway Albert, déguisement OpenAI-compatible
- **Hono** — serveur HTTP léger, monté via `@mastra/core/server`
- **better-sqlite3** — base locale (utilisateurs, sessions, invitations, audit, secrets chiffrés en AES-256-GCM)
- **Pico.css + JS vanilla** — admin UI, sans bundler frontend

Aucun service externe à installer (pas de Postgres, pas de Redis).

---

## Lancer le projet en local — pas à pas

Cette section part du principe que tu n'as **rien** d'installé. Suis dans l'ordre.

### 1. Installer Node.js 20+

Vérifie d'abord ce que tu as :

```bash
node --version
```

Si la commande renvoie `v20.x.x` ou plus, passe à l'étape 2. Sinon, installe Node :

**macOS** — via [Homebrew](https://brew.sh) (recommandé) :

```bash
brew install node@20
```

Ou via [nvm](https://github.com/nvm-sh/nvm) si tu jongles entre plusieurs versions :

```bash
nvm install 20
nvm use 20
```

**Windows** — télécharger l'installeur LTS sur https://nodejs.org puis suivre l'assistant. Coche bien la case **« Automatically install the necessary tools »** à la fin : ça installe Python et les build tools nécessaires pour compiler `better-sqlite3`. Sans ça, `npm install` plantera.

Alternative Windows : utiliser **WSL2** (Ubuntu) puis suivre la procédure Linux ci-dessous — c'est l'expérience la plus proche d'un Mac.

**Linux (Debian/Ubuntu)** :

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3
```

`build-essential` et `python3` sont requis pour compiler `better-sqlite3` à l'install.

Vérifie ensuite :

```bash
node --version   # doit afficher v20.x.x ou plus
npm --version    # doit afficher 10.x.x ou plus
```

### 2. Récupérer une clé API Albert

Sans cette clé, le pipeline RAG ne peut pas appeler Albert et tu n'auras pas de réponses. Le reste du serveur (admin, login, etc.) tourne quand même.

Récupère une clé API sur https://albert.api.etalab.gouv.fr et garde-la sous la main.

### 3. Cloner et installer

```bash
git clone <url-du-depot>
cd E-synthese-mastra
npm install
```

L'install prend 1-2 minutes. La compilation native de `better-sqlite3` se déclenche à la fin — c'est normal qu'elle prenne quelques secondes. Si elle échoue, c'est presque toujours un problème de build tools manquants (cf. étape 1).

### 4. Configurer le `.env`

Copie le modèle dev :

```bash
cp .env.example.dev .env
```

Ouvre `.env` dans ton éditeur et renseigne **uniquement** la clé Albert :

```env
ALBERT_API_KEY=<colle-ici-ta-clé-Albert>
```

Le reste peut rester vide en local. Le serveur générera automatiquement, à chaque démarrage :
- une `ENCRYPTION_KEY` temporaire (les secrets en base seront perdus au redémarrage — c'est OK en dev),
- une `PROXY_API_KEY` temporaire qui sera **imprimée dans les logs** au boot.

> Si tu veux que ces clés soient stables d'un redémarrage à l'autre (par exemple pour ne pas avoir à reconfigurer Albert Conversation à chaque fois), génère-les une fois et colle-les dans `.env` :
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> node -e "console.log('sk-proxy-' + require('crypto').randomBytes(32).toString('hex'))"
> ```

### 5. Lancer le serveur

```bash
npm run dev
```

Tu devrais voir, dans les logs :

```
[WARNING] No PROXY_API_KEY set. Temporary key: sk-proxy-abc123...def
Mastra API server running on http://localhost:4111
```

**Note bien la `PROXY_API_KEY`** affichée : c'est elle qu'il faut envoyer dans le header `Authorization: Bearer ...` pour appeler `/v1/*`.

Le serveur recompile automatiquement à chaque modif dans `src/`.

### 6. Créer le premier compte admin

Ouvre http://localhost:4111/admin dans ton navigateur. Comme aucun compte n'existe, la page bascule sur le formulaire de setup. Renseigne :

- un email (n'importe lequel, il n'y a pas d'envoi de mail),
- un mot de passe (min. 8 caractères, 1 chiffre, 1 majuscule).

Une fois validé, **note bien le code de récupération** affiché à l'écran. C'est le seul moyen de réinitialiser le mot de passe — il ne sera plus jamais ré-affiché.

Tu es maintenant connecté en tant qu'admin.

### 7. Configurer la clé Albert dans l'admin (recommandé)

La clé `ALBERT_API_KEY` du `.env` est utilisée au démarrage, mais l'admin permet de la stocker en base (chiffrée AES-256-GCM) et de la modifier à chaud sans redémarrer.

1. Va sur http://localhost:4111/admin/settings.
2. Colle ta clé Albert dans le champ correspondant.
3. Choisis le modèle (par défaut `albert-large`) et ajuste si besoin `searchK`, `minScore`, etc.
4. Enregistre.

### 8. Tester avec curl

Récupère ta `PROXY_API_KEY` (celle imprimée dans les logs ou celle que tu as définie dans `.env`) et exporte-la :

```bash
export PROXY_API_KEY="sk-proxy-..."
```

Lister les modèles :

```bash
curl -H "Authorization: Bearer $PROXY_API_KEY" \
  http://localhost:4111/v1/models
```

Réponse attendue : un objet JSON contenant `e-synthese-rag` (le modèle virtuel que le proxy expose).

Lancer un appel RAG complet :

```bash
curl -X POST http://localhost:4111/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "e-synthese-rag",
    "messages": [
      { "role": "user", "content": "Bonjour, présente-toi" }
    ]
  }'
```

Si la réponse arrive avec un `choices[0].message.content` non vide, **tout marche**.

### 9. (Optionnel) Brancher Albert Conversation en local

Dans la configuration d'Albert Conversation, ajouter un fournisseur OpenAI-compatible :

| Champ | Valeur |
|---|---|
| Base URL | `http://localhost:4111/v1` |
| API Key | la `PROXY_API_KEY` |
| Model ID | `e-synthese-rag` |

Albert Conversation pense dialoguer avec un modèle standard ; en coulisses, chaque message déclenche le pipeline RAG.

### Repartir de zéro

Si tu veux remettre la base à plat (par exemple pour retester le setup admin) :

```bash
rm data.db data.db-shm data.db-wal
```

Au prochain `npm run dev`, le formulaire de setup réapparaît.

### Problèmes fréquents

| Symptôme | Cause probable | Solution |
|---|---|---|
| `npm install` échoue sur `better-sqlite3` | Build tools manquants | Mac : `xcode-select --install` · Windows : réinstaller Node en cochant les tools · Linux : `sudo apt install build-essential python3` |
| Au boot, erreur `EADDRINUSE: 4111` | Un autre process occupe le port | `lsof -i :4111` (Mac/Linux) puis `kill <pid>`, ou changer `PORT` dans `.env` |
| `401 Invalid API key` sur `/v1/...` | Mauvaise `PROXY_API_KEY` | Recopier celle imprimée dans les logs, attention aux espaces |
| Réponse vide ou `Albert API key is not configured` | Clé Albert absente / invalide | Vérifier `ALBERT_API_KEY` dans `.env` ou dans `/admin/settings` |
| L'admin UI dit `Not authenticated` après refresh | Cookie de session expiré (24 h) | Se reconnecter via `/admin/login` |

---

## Endpoints exposés

### API publique — Bearer `PROXY_API_KEY`

| Endpoint | Rôle |
|---|---|
| `POST /v1/chat/completions` | Pipeline RAG complet (supporte `stream: true`) |
| `GET /v1/models` | Liste le modèle virtuel `e-synthese-rag` |
| `POST /v1/search` | Proxy transparent vers `albert.api.etalab/search` |
| `POST /v1/rerank` | Proxy transparent vers `albert.api.etalab/rerank` |
| `POST /v1/embeddings` | Proxy transparent vers `albert.api.etalab/embeddings` |
| `GET /health` | Healthcheck |

### Admin UI — cookie session + CSRF

| Page | Rôle |
|---|---|
| `/admin/` | Dashboard (statut Albert, config, audit récent) |
| `/admin/login`, `/admin/register`, `/admin/forgot-password`, `/admin/reset-password` | Auth |
| `/admin/settings` | Réglage `ALBERT_API_KEY`, `LLM_MODEL`, prompt système RAG |
| `/admin/collections` | Créer / lister / supprimer les collections Albert |
| `/admin/documents` | Uploader des PDF/TXT (max 10 Mo) |
| `/admin/test` | Pipeline test (visualise search → rerank → LLM étape par étape) |
| `/admin/users-page` | Inviter / supprimer / forcer le reset des admins et éditeurs |
| `/admin/audit-page` | Journal des actions sensibles |
| `/admin/account` | Mon compte (changer mot de passe) |

---

## Variables d'environnement

| Variable | Défaut dev | Rôle |
|---|---|---|
| `NODE_ENV` | `development` | `production` active les cookies `Secure` et le mode strict |
| `ENCRYPTION_KEY` | clé temp générée | Chiffre les secrets en base (64 hex chars) |
| `ALBERT_API_KEY` | — | Clé API Albert (obligatoire pour le RAG) |
| `ALBERT_API_BASE_URL` | `https://albert.api.etalab.gouv.fr` | URL de l'API Albert |
| `PROXY_API_KEY` | clé temp imprimée | Bearer requis pour appeler `/v1/*` |
| `PORT` | `4111` | Port d'écoute |
| `DB_PATH` | `<projet>/data.db` | Fichier SQLite |
| `PUBLIC_DIR` | `<projet>/public` | Assets admin UI |
| `LLM_MODEL` | `albert-large` | Modèle Albert utilisé pour la génération finale |
| `SEARCH_K` | `5` | Nombre de chunks remontés par la recherche |
| `MIN_SCORE` | `0.5` | Score minimum pour conserver un chunk |
| `USE_RERANK` | `true` | Active le reranking après la recherche |
| `DEFAULT_COLLECTIONS` | vide = toutes | IDs Albert séparés par virgules |

Modèle complet : `.env.example.dev`.

---

## Commandes

```bash
npm run dev    # serveur de développement (hot reload, port 4111)
npm run build  # build Mastra (sortie : .mastra/output)
npm run start  # démarre le bundle de production
```

---

## Tests end-to-end

```bash
./scripts/test-e2e.sh
```

Le script build le projet, démarre un serveur isolé sur un port temporaire, et exécute 11 sections : enforcement du Bearer, setup admin, login/logout, rate limiting, CSRF, cap upload 10 Mo, persistance DB, chiffrement, assets statiques, crypto round-trip (scrypt + AES-256-GCM).

Avant un push :

```bash
npx tsc --noEmit       # typecheck
npm run build          # build Mastra
./scripts/test-e2e.sh  # tests e2e
```

---

## Sécurité (résumé)

- scrypt `N=16384` sur les mots de passe + comparaison `timingSafeEqual`
- AES-256-GCM sur les secrets stockés en base (clé Albert)
- Sessions HttpOnly + Secure + SameSite=Strict (24 h, max 5 par utilisateur)
- CSRF token sur toutes les mutations admin
- Bearer `timingSafeEqual` sur l'API
- Rate limiting login (5 tentatives / IP, blocage 15 min)
- Cap upload 10 Mo
- Requêtes SQLite paramétrées
- Admin UI sans `innerHTML` (XSS-resistant)

---

## Statut du dépôt

Ce dépôt est la **source canonique** du proxy. Le service est conçu pour être déployé seul, derrière n'importe quel client OpenAI-compatible.

Pour l'intégration complète avec l'UI Conversations (DINUM / La Suite Numérique), voir les dossiers voisins :

| Dossier | Usage |
|---|---|
| `E-synthese-mastra/` (ici) | Mastra autonome — dev local + déploiement prod isolé |
| `E-synthese-final-dev/` | Intégration **dev** : Mastra + Conversations en HTTP local |
| `E-synthese-final/` | Intégration **prod** : prête à déployer |

Les dossiers d'intégration contiennent une **copie** de Mastra synchronisée depuis ici (`scripts/sync-from-mastra.sh` côté intégration). On ne modifie jamais le Mastra des dossiers d'intégration directement — toujours ici, puis on resynchronise.
