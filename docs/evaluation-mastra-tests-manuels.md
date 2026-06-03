# Évaluation des réponses RAG via Mastra — Procédure de tests manuels

Feature : 4 scorers LLM-juges Mastra (`gpt-oss-120b`) notant les réponses RAG, en live
échantillonné sur `/v1/chat/completions` (mode A) et à la demande via `/v1/score` (mode C),
persistés dans `rag_runs` / `rag_scores`, consultables via `GET /admin/scores`.

## Statut — VALIDÉ EN LIVE le 2026-06-02

| Vérification | État |
|---|---|
| `tsc --noEmit` (projet entier) | ✅ 0 erreur |
| `npm test` (unitaires `isRefusal`) | ✅ 4/4 |
| Revue finale holistique (6 contrats bout-en-bout) | ✅ (1 critique corrigé : nesting `.payload` des tool results) |
| Schéma auto-créé (`rag_runs`, `rag_scores`) | ✅ |
| `POST /v1/score` (mode C) — 4 scorers + juge + persistance | ✅ |
| Recherche élargie #4 sur vrai corpus | ✅ (juge a détecté que « 400 M€ » contredit le corpus ≈ 29,36 M€) |
| Refus → seul `system_prompt`, `is_refusal=true` | ✅ |
| Live mode A **non-stream** déclenche le scoring | ✅ |
| Live mode A **streaming** déclenche le scoring (risque #1) | ✅ levé (356 events SSE + `[DONE]`, run écrit après le flux) |
| Extraction des chunks rerankés de l'agent (fix `.payload`) | ✅ (`used_chunks` = vrai doc reranké, 3235 car.) |
| `GET /admin/scores` (401 sans auth ; moyennes + filtres + détail avec auth) | ✅ |
| Non-régression `EVAL_SAMPLING_RATE=0` → aucun run, réponse intacte | ✅ |

### Validé avec une stack isolée (sans toucher d'autres conteneurs)

```bash
# Postgres jetable sur un port libre (5440)
docker run -d --name esynth-eval-pg -e POSTGRES_USER=mastra -e POSTGRES_PASSWORD=evaltest \
  -e POSTGRES_DB=mastra -p 5440:5432 postgres:17.5

# Mastra depuis le checkout préprod, port libre (4120), clés reprises du .env dev
cd mastra
export $(grep -E '^(ALBERT_API_KEY|ALBERT_API_BASE_URL|PROXY_API_KEY|ENCRYPTION_KEY)=' \
  ../../E-synthese-final-dev/.env | xargs)
export DATABASE_URL=postgresql://mastra:evaltest@localhost:5440/mastra
export PORT=4120 ALBERT_JUDGE_MODEL=openweight-large EVAL_SAMPLING_RATE=1.0 DEFAULT_COLLECTIONS=5963,2280
npm run dev    # health: http://localhost:4120/health

# nettoyage ensuite
docker rm -f esynth-eval-pg
```

> Collections Albert utilisées : `5963` (SGARPACA, 300 docs) et `2280` (SGARPACAV01, 13 docs).

## Pré-requis

- `DATABASE_URL` défini et Postgres joignable.
- `ALBERT_API_KEY` défini (sinon le juge envoie un Bearer vide → 401). Optionnel :
  `ALBERT_JUDGE_MODEL=openweight-large` (défaut), `EVAL_SAMPLING_RATE=1.0`, `EVAL_WIDE_K=20`.
- `defaultCollections` configurées (admin) avec un corpus ingéré.
- Stack démarrée : `npm run dev` (depuis `mastra/`) ou `docker compose up --build`.

## Procédure

### 1. Schéma créé
```sql
\d rag_runs
\d rag_scores
```
Attendu : les deux tables avec les colonnes du plan (`used_chunks JSONB`, `score REAL`,
`is_refusal BOOLEAN`, `created_at TEXT`…), index `idx_rag_scores_run/metric`, `idx_rag_runs_created`.

### 2. Mode A (live) — question métier couverte par le corpus (non-stream)
Envoyer une requête (clé proxy) :
```bash
curl -s -X POST http://localhost:4111/v1/chat/completions \
  -H "Authorization: Bearer <CLE_PROXY>" -H "Content-Type: application/json" \
  -d '{"model":"albert","messages":[{"role":"user","content":"<question couverte par le corpus>"}]}'
```
Puis vérifier la persistance :
```sql
SELECT id, source, is_refusal, wide_k, left(question,40) FROM rag_runs ORDER BY id DESC LIMIT 1;
SELECT metric, score, left(reason,60) FROM rag_scores WHERE run_id=(SELECT max(id) FROM rag_runs);
```
Attendu : 1 run `source='live'`, `wide_k>0`, et **4** scores (`system_prompt`, `faithfulness`,
`completeness`, `retrieval_quality`), tous ∈ [0,1].

**Contrôle clé du fix critique** : vérifier que `used_chunks` contient bien les chunks
**rerankés réellement vus par l'agent** (mêmes noms/contenu que la réponse cite), et pas un
repli de recherche brute :
```sql
SELECT jsonb_array_length(used_chunks) AS n,
       used_chunks->0->>'name' AS premier_doc
FROM rag_runs ORDER BY id DESC LIMIT 1;
```
> Si `rag_runs` reste vide ou `used_chunks` semble incohérent : logguer dans `maybeScoreLive`
> la forme réelle de `result` (`JSON.stringify` des clés, et de `result.toolResults` /
> `result.steps[].toolResults`) pour confirmer le chemin `.payload.toolName` / `.payload.result.chunks`
> utilisé par `extractUsedChunks` (risque #3 de la spec — déjà adressé par l'extraction défensive).

### 3. Mode A (live) — streaming (RISQUE #1)
Même requête avec `"stream": true`. Vérifier que le flux SSE arrive normalement **et** qu'une
nouvelle ligne `rag_runs`/`rag_scores` apparaît après la fin du flux.
```sql
SELECT count(*) FROM rag_runs WHERE source='live';
```
> Si aucune ligne en streaming alors que le non-stream marche : `result.text` ne se résout pas
> après consommation de `textStream`. Repli (à implémenter alors) : accumuler le texte streamé
> dans `toOpenAISSE` et le passer à `scoreRun` via un callback de fin de flux.

### 4. Mode A — refus (question hors corpus)
Poser une question sans rapport avec le corpus (refus attendu).
```sql
SELECT is_refusal FROM rag_runs ORDER BY id DESC LIMIT 1;          -- attendu : true
SELECT count(*) FROM rag_scores WHERE run_id=(SELECT max(id) FROM rag_runs);  -- attendu : 1 (system_prompt seul)
```

### 5. Mode C — /v1/score
```bash
curl -s -X POST http://localhost:4111/v1/score \
  -H "Authorization: Bearer <CLE_PROXY>" -H "Content-Type: application/json" \
  -d '{"question":"Quelle est la répartition DSIL 2025 ?","answer":"La DSIL prévoit 400 M€.\n\n**Sources :**\n- Source 1 : *note.pdf*","contexts":["La DSIL 2025 prévoit 400 M€ pour la région."]}'
```
Attendu : `{ "scores": [4 métriques], "is_refusal": false }`.

### 6. Endpoint admin
Connecté en admin (cookie de session) :
```bash
curl -s "http://localhost:4111/admin/scores?limit=5" -H "Cookie: <session>"
curl -s "http://localhost:4111/admin/scores?metric=faithfulness&minScore=0.8" -H "Cookie: <session>"
```
Attendu : `{ averages: { faithfulness:{avg,n}, ... }, count, items:[{run_id, scores:[{metric,score,reason}]}] }`,
filtres respectés.

### 7. Non-régression du contrat
Mettre temporairement `EVAL_SAMPLING_RATE=0`, refaire les requêtes stream et non-stream :
les réponses doivent être **identiques** à avant la feature (aucun run écrit) — preuve que le
scoring n'altère jamais la réponse servie.

## Résultats observés (2026-06-02)

- [x] 1. **Schéma** — `rag_runs` + `rag_scores` auto-créées au 1er accès.
- [x] 2. **Live non-stream** — run `live` écrit ; `used_chunks` = chunk reranké réel
  (« 1-note au sgar- projet répartition DSIL-DSID 2025…pdf », 3235 car.), 4 scores
  (`system_prompt`=1, `faithfulness`=0.95, `completeness`=0.35, `retrieval_quality`=0.3).
- [x] 3. **Live streaming** — 356 events SSE + `[DONE]`, puis run `live` écrit après le flux
  (risque #1 levé, sans repli nécessaire). 4 scores.
- [x] 4. **Refus** — `is_refusal=true`, 1 seul score (`system_prompt`=0.5 : refus correct mais
  bloc Sources absent).
- [x] 5. **`/v1/score`** — 4 scores cohérents ; le `retrieval_quality`=0 a correctement signalé
  qu'une valeur inventée (400 M€) contredisait le corpus (≈ 29,36 M€) via la recherche élargie.
- [x] 6. **`/admin/scores`** — 401 sans auth ; avec admin : moyennes SQL par métrique
  (`system_prompt` n=4, RAG n=3), 4 runs détaillés avec justifications, filtres `source`/`metric`/`maxScore` corrects.
- [x] 7. **Non-régression** — `EVAL_SAMPLING_RATE=0` → chat HTTP 200, réponse non vide, **0 run écrit**.

## Limitation connue (à traiter si besoin)

`evalSamplingRate` / `evalWideK` sont lus depuis la **config DB → env → défaut**, mais ne sont
**pas dans la whitelist de la route `PUT /admin/config`** : ils ne sont donc pilotables que par
**variable d'environnement** (ou insertion directe dans la table `config`), pas encore via le
panneau admin. Pour les rendre admin-éditables : ajouter les clés à la liste `allowed` du
handler `/admin/config` (+ UI). Le modèle juge (`ALBERT_JUDGE_MODEL`) est volontairement env-only
(contrainte de construction synchrone des scorers).
