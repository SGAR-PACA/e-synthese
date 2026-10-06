# Développement

## Mastra seul

Le plus simple pour travailler sur le pipeline : lancer Mastra en local avec une
base PostgreSQL jetable.

Prérequis : Node.js 22 et Docker.

```bash
docker run -d --name rag-pg -p 5440:5432 \
  -e POSTGRES_USER=mastra -e POSTGRES_PASSWORD=mastra -e POSTGRES_DB=mastra \
  postgres:17.5

cd mastra
npm ci
export DATABASE_URL=postgresql://mastra:mastra@localhost:5440/mastra
export ALBERT_API_KEY=<clé de développement>
export MASTRA_REQUIRE_USER_TOKEN=false     # pas de Keycloak en local
npm run dev
```

- Le serveur écoute sur <http://localhost:4111> ; l'admin est sur `/admin/`.
- Hors production, Mastra génère une clé `PROXY_API_KEY` temporaire (affichée
  dans le terminal) et une clé de chiffrement temporaire : la clé Albert saisie
  dans l'admin est perdue au redémarrage, sauf à fixer `PROXY_API_KEY` et
  `ENCRYPTION_KEY`.
- Avec `MASTRA_REQUIRE_USER_TOKEN=false`, aucun filtrage par rôle n'est appliqué :
  toutes les collections sont interrogées.
- L'ingestion de documents nécessite en plus `S3_DOCS_*` et `OCR_SERVICE_URL`
  (service OCR lancé à part : `docker build -t ocr-local ocr-service && docker run -p 8080:8080 ocr-local`).

Poser une question :

```bash
curl -s http://localhost:4111/v1/chat/completions \
  -H "Authorization: Bearer <PROXY_API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"e-synthese-rag","messages":[{"role":"user","content":"Quelles aides existent pour les collectivités ?"}]}'
```

## Tests de Mastra

```bash
cd mastra
npm test
```

Tests unitaires avec le lanceur intégré de Node (`node:test`), dossier `test/`.
Ils couvrent la planification, la recherche et le filtrage par collection, le
prompt, les liens de sources et leur signature, la visionneuse et l'OIDC,
l'ingestion, le surlignage, le juge et la notation. Deux fichiers ont besoin de
PostgreSQL et sont ignorés si `DATABASE_URL` n'est pas défini.

### Tests de bout en bout

Ils s'exécutent contre un Mastra lancé sur le port 4112, branché sur un faux
Albert :

```bash
node scripts/mock-albert-e2e.mjs &                # faux Albert sur le port 55440
PORT=4112 DATABASE_URL=... MASTRA_REQUIRE_USER_TOKEN=false npm run dev &

npm run test:e2e:admin          # création de l'admin, configuration, test du pipeline
npm run test:e2e:restart        # persistance après redémarrage
npm run test:e2e:live-sources   # question en flux et bloc Sources
npm run test:e2e:ratings        # statistiques de notes (base préalablement remplie)
```

Dans l'admin, régler l'adresse d'Albert sur `http://127.0.0.1:55440`
(`test:e2e:admin` le fait).

## Frontend

```bash
cd conversations-frontend/src/frontend
yarn install
yarn app:dev        # http://localhost:3000
yarn app:test       # tests unitaires (Jest)
yarn lint
```

Le frontend attend un backend Conversations sur `http://localhost:8071`
(`apps/conversations/.env.development`) ; sans variables Keycloak, le widget de
notation reste inactif.

## Pile complète en local

Pour vérifier que `compose.yml` et les variables sont cohérents avant un
déploiement :

```bash
cp .env.example.prod .env          # remplir toutes les valeurs requises
docker network create dokploy-network
docker compose config --quiet && echo OK
docker compose up -d --build
docker compose ps
```

Sans le Traefik de Dokploy, l'application n'est pas accessible par le
navigateur : ce test vérifie seulement que tous les services démarrent.

## Banc de questions

`scripts/bench/run_bench.py` envoie une série de questions au pipeline d'une
instance déployée, via l'admin Mastra, et produit un rapport.

```bash
cd scripts/bench
export ESY_BENCH_PASSWORD=<mot de passe admin Mastra>
python3 run_bench.py --base-url https://<DOMAIN_FRONT> --email <admin@...>
python3 run_bench.py ... --with-judge --only P01,P02   # avec le juge, sur deux questions
```

- Les questions sont lues dans `scripts/bench/questions.json` (liste
  d'objets `id`, `question`, `reponse_attendue`, `sources_attendues`). Ce fichier
  et les résultats (`scripts/bench/results/`) ne sont **pas versionnés** : ils
  contiennent des éléments du corpus.
- Les questions passent l'une après l'autre (limiteur Albert) ; `--resume`
  reprend une série interrompue.
- Résultat : `results/<date>/results.json` et `report.md`.

## Conventions

- Travailler sur une branche issue de `preprod`, fusionner dans `preprod`, puis
  passer en production par une pull request `preprod` → `main`.
- Messages de commit en français, à l'infinitif ou à l'indicatif, décrivant
  l'effet de la modification.
- Ne jamais versionner de secret : le `.gitignore` exclut `.env`, `.env.prod` et
  `mastra/.env`.
