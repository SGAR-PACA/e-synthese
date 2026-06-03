# Issue #8 — Refactoriser l'appel à `rag-agent`

> Document unique de l'issue #8 : **audit + décision technique** (partie A) et
> **procédure de non-régression + rapport de tests** (partie B).
>
> Statut : ✅ décision prise — **refactoriser** (voir A.5). Non-régression
> vérifiée (voir B).

---

# Partie A — Audit et décision technique

> Répond au **critère d'acceptation n°1** de l'issue : « une décision technique
> claire est prise — conserver l'import direct ou refactoriser ».

## A.1 — Objectif de l'issue

Étudier et, **si le bénéfice est confirmé**, refactoriser l'appel à `rag-agent`
afin de passer par l'**instance Mastra** plutôt que par un import direct du
module, pour mieux bénéficier des services partagés Mastra (storage, traces,
logs, scorers, registre) — services qui deviennent importants pour
l'évaluation et l'observabilité (issues #2, #3, #5 du plan).

L'issue est volontairement prudente : elle demande de **ne refactoriser que si
le bénéfice est avéré**, et de garantir l'absence de régression.

## A.2 — État des lieux (audit)

### Comment la route appelle l'agent aujourd'hui

Fichier `mastra/src/routes/chat-completions.ts` :

```ts
import { ragAgent } from '../mastra/agents/rag-agent.js';
...
const result = await (ragAgent as any).stream(cleanedMessages, { ... });
const result = await (ragAgent as any).generate(cleanedMessages, { ... });
```

La route consomme l'agent par **import direct du module**, puis caste l'objet
en `any` pour appeler `.stream()` / `.generate()`.

### Constats

1. **Couplage fort** : la route connaît le chemin interne
   `../mastra/agents/rag-agent.js`. Tout déplacement du module casse la route.
2. **Contournement du registre** : l'instance Mastra
   (`mastra/src/mastra/index.ts`) enregistre pourtant l'agent
   (`agents: { ragAgent }`). La route n'utilise pas ce registre.
3. **Dette de typage** : le `as any` désactive toute vérification de types sur
   ces appels — l'agent, les messages *et* les options ne sont plus typés.
4. **Audit des autres routes** : `search.ts` et `admin-api.ts` ont été
   inspectées. Elles appellent le *gateway* `albert.rerank` directement (appel
   HTTP à l'API Albert), **pas** l'agent ni les outils Mastra. Elles sont donc
   hors du périmètre de cette issue.

## A.3 — Options comparées

| Critère | A — Conserver l'import direct | B — Résoudre via l'instance (`getAgent`) |
|---|---|---|
| Accès aux services partagés Mastra | Indirect, non garanti | Via le registre — voie officielle |
| Couplage | Fort (chemin d'import interne) | Faible (nom logique `'ragAgent'`) |
| Typage | Masqué par `as any` | Typé (agent, messages, options) |
| Pattern recommandé Mastra | Non | Oui (`c.get('mastra').getAgent(...)`) |
| Risque de régression | — | Quasi nul (voir A.4) |
| Effort | Nul | Faible (un seul fichier) |

## A.4 — Analyse : bénéfices et risques

### Le point clé : risque quasi nul

À l'exécution, **`getAgent('ragAgent')` renvoie le même objet** que l'import
direct : l'instance Mastra enregistre précisément l'agent importé depuis ce
même module. Le refactor ne modifie donc **aucun comportement** à l'instant T.
C'est ce qui rend le risque de régression quasi nul.

### Le bénéfice est confirmé

Le bénéfice n'est pas fonctionnel immédiat — il est **architectural et
prospectif** :

- La route dépend désormais du **registre de l'instance Mastra**, qui est le
  point d'entrée où seront branchés le `storage`, l'`observability` (traces) et
  les `scorers` lors des phases #2 / #3 / #5 du plan d'évaluation.
- Le plan `PLAN-EVALUATION-RAG.md` (§12) qualifie #8 de
  « verrou technique : sans elle, #2 et #5 n'instrumentent rien ».
- Bénéfice secondaire immédiat : suppression du couplage fragile et de la dette
  de typage (`as any`).

### Conclusion de l'analyse

Risque ≈ nul + bénéfice confirmé pour l'observabilité et les évaluations
⟹ le critère « ne refactoriser que si le bénéfice est confirmé » est satisfait.

## A.5 — Décision

**REFACTORISER (option B).**

L'appel à l'agent passe par l'instance Mastra :

```ts
const ragAgent = c.get('mastra').getAgent('ragAgent');
const result = await ragAgent.stream(cleanedMessages, { modelSettings: ... });
const result = await ragAgent.generate(cleanedMessages, { modelSettings: ... });
```

## A.6 — Périmètre des changements

Un seul fichier modifié : `mastra/src/routes/chat-completions.ts`.

1. Suppression de l'import direct `ragAgent`.
2. Résolution de l'agent via `c.get('mastra').getAgent('ragAgent')` dans le
   handler.
3. Suppression des `as any` sur `.stream()` / `.generate()`.
4. `OpenAIMessage` transformé en union discriminée (un membre par rôle, rôle
   `'tool'` inutilisé retiré) — changement **purement de typage**, pour rendre
   le tableau de messages assignable au type Mastra `MessageListInput` une fois
   le `as any` retiré.
5. `modelOptions` typé précisément (`{ temperature?, maxOutputTokens? }`) — idem,
   changement de typage uniquement.

**Inchangé** : contrat de réponse OpenAI, streaming SSE, filtrage des marqueurs
de citation et des messages placeholder, l'agent et ses outils, les routes
`search.ts` et `admin-api.ts`.

## A.7 — Couverture des critères d'acceptation

| Critère d'acceptation | Statut |
|---|---|
| Une décision technique claire est prise | ✅ Refactoriser — partie A |
| Le contrat externe de `/v1/chat/completions` est préservé | ✅ Partie B : T1–T3, T5–T6 |
| Le streaming continue de fonctionner | ✅ Partie B : T2 |
| L'agent bénéficie des services partagés Mastra | ✅ Résolution via le registre de l'instance |
| Les risques de régression sont couverts | ✅ `tsc` + procédure de validation manuelle (partie B) |

---

# Partie B — Procédure de non-régression et rapport de tests

> Tests **manuels** de la route `/v1/chat/completions` après le refactor.
> Objectif : prouver que le contrat externe consommé par **Albert Conversation**
> est **strictement inchangé**. Aucun framework de test n'est utilisé — on
> déroule cette checklist à la main.

## B.1 — Rappel de ce qui a changé

Fichier modifié : `mastra/src/routes/chat-completions.ts`.

- **Avant** : `import { ragAgent } from '../mastra/agents/rag-agent.js'` puis
  `(ragAgent as any).stream(...)` / `.generate(...)`.
- **Après** : `const ragAgent = c.get('mastra').getAgent('ragAgent')` dans le
  handler ; appels `ragAgent.stream(...)` / `.generate(...)` typés, sans `as any`.

À l'exécution, `getAgent('ragAgent')` renvoie **le même objet** que l'import
direct : aucune régression de comportement n'est attendue. Cette procédure le
confirme empiriquement.

## B.2 — Prérequis

- [ ] Dépendances installées : `npm install` dans `mastra/`.
- [ ] La compilation passe : `npx tsc --noEmit` → **0 erreur**.
- [ ] Variables d'environnement nécessaires définies (`.env`) : accès à l'API
      Albert (clé) et, idéalement, `PROXY_API_KEY`.
- [ ] Une collection RAG contenant au moins un document indexé (pour T4).

### Lancer le serveur

```bash
cd mastra
npm run dev
```

Le serveur écoute sur le port `4111` par défaut (`PORT` dans l'environnement).

### Récupérer la clé d'API du proxy

L'en-tête `Authorization: Bearer <clé>` est obligatoire.

- Si `PROXY_API_KEY` est définie dans `.env` → utiliser cette valeur.
- Sinon, en développement, une clé temporaire est générée et **affichée dans les
  logs au démarrage** :
  `[WARNING] No PROXY_API_KEY set. Temporary key: sk-proxy-...`

Dans les commandes ci-dessous, remplacer `$KEY` par cette clé :

```bash
export KEY="sk-proxy-..."
export URL="http://localhost:4111/v1/chat/completions"
```

## B.3 — Tests

Légende : `🔲 à tester` · `✅ conforme` · `❌ régression détectée`

### T1 — Réponse simple (non-streaming) · contrat OpenAI

```bash
curl -s "$URL" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{ "role": "user", "content": "Bonjour, qui es-tu ?" }],
    "stream": false
  }' | jq
```

Résultat attendu :
- [ ] Code HTTP `200`.
- [ ] JSON avec `id` (préfixe `chatcmpl-`), `object: "chat.completion"`,
      `created`, `model`.
- [ ] `choices[0].message.role` = `"assistant"`, `content` non vide.
- [ ] `choices[0].finish_reason` présent.
- [ ] Bloc `usage` avec `prompt_tokens`, `completion_tokens`, `total_tokens`.
- [ ] Aucun marqueur de citation parasite `【...】`.

### T2 — Streaming SSE

```bash
curl -N -s "$URL" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{ "role": "user", "content": "Explique brièvement le RAG." }],
    "stream": true
  }'
```

Résultat attendu :
- [ ] Réponse en `Content-Type: text/event-stream`.
- [ ] Premier événement : `delta` contient `{ "role": "assistant" }`.
- [ ] Événements suivants : `delta.content` avec des fragments de texte.
- [ ] Avant-dernier événement : `finish_reason: "stop"`.
- [ ] Dernière ligne : `data: [DONE]`.
- [ ] Aucun marqueur `【` ou `】`.

### T3 — Compatibilité Albert Conversation (message placeholder)

Albert Conversation envoie un message final
`{ "role": "assistant", "content": null }` (placeholder), à filtrer sans erreur.

```bash
curl -s "$URL" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "user", "content": "Quelles aides pour les collectivités ?" },
      { "role": "assistant", "content": null }
    ],
    "stream": false
  }' | jq
```

Résultat attendu :
- [ ] Code HTTP `200` (placeholder ignoré, pas d'erreur Mastra).
- [ ] Réponse au format `chat.completion` valide.

### T4 — L'agent exécute bien le pipeline RAG

```bash
curl -s "$URL" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{ "role": "user", "content": "<question couverte par un document indexé>" }],
    "stream": false
  }' | jq -r '.choices[0].message.content'
```

Résultat attendu :
- [ ] La réponse s'appuie sur le contenu d'un document indexé.
- [ ] Elle se termine par un bloc `**Sources :**` listant les documents utilisés.

### T5 — Authentification

```bash
# Sans en-tête Authorization
curl -s -o /dev/null -w "%{http_code}\n" "$URL" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test"}]}'

# Avec une clé invalide
curl -s -o /dev/null -w "%{http_code}\n" "$URL" \
  -H "Authorization: Bearer cle-bidon" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test"}]}'
```

Résultat attendu :
- [ ] Sans en-tête → `401`.
- [ ] Clé invalide → `401`.

### T6 — Validation des entrées

```bash
# messages vide
curl -s -o /dev/null -w "%{http_code}\n" "$URL" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[]}'

# uniquement un placeholder assistant null
curl -s -o /dev/null -w "%{http_code}\n" "$URL" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"assistant","content":null}]}'
```

Résultat attendu :
- [ ] `messages` vide → `400`.
- [ ] Uniquement un placeholder → `400`.

### T7 — Résolution de l'agent via l'instance Mastra (cœur de #8)

`getAgent('ragAgent')` lève une erreur si le nom n'est pas enregistré. Le simple
fait que T1–T4 réussissent prouve que la résolution via l'instance fonctionne.

Vérification statique :
- [ ] `grep -n "import.*rag-agent" src/routes/chat-completions.ts` ne renvoie
      **rien**.
- [ ] `grep -n "as any" src/routes/chat-completions.ts` ne renvoie **rien** sur
      les appels `.stream()` / `.generate()`.

## B.4 — Résultats de l'exécution du 2026-05-19

Exécution complète. Serveur lancé depuis `E-synthese-final/mastra/` (code
refactoré, issue #8) avec la clé API Albert chargée depuis le `.env` de
l'environnement `E-synthese-final-dev`. `PROXY_API_KEY` laissée en clé
temporaire générée au démarrage.

| Test | Sujet | Statut | Détail |
|---|---|---|---|
| T1 | Réponse simple (contrat OpenAI) | ✅ | HTTP 200 en 1,24 s. JSON `chat.completion` complet : `id` `chatcmpl-…`, `model`, `finish_reason: stop`, `message.role: assistant`, contenu cohérent, `usage` 731/60/791. |
| T2 | Streaming SSE | ✅ | 44 événements `data:`, 1er événement `delta.role: assistant`, `finish_reason: stop`, ligne finale `[DONE]`, 0 marqueur `【】`. |
| T3 | Compatibilité placeholder Conversation | ✅ | HTTP 200. Le message `{role:assistant, content:null}` est filtré sans erreur ; réponse au format `chat.completion` valide. |
| T4 | Pipeline RAG (outils + sources) | ⚠️ partiel | HTTP 200, agent fonctionnel, réponse cohérente. Mais aucune collection indexée dans l'environnement de test (`DEFAULT_COLLECTIONS` vide) → réponse « Aucune information disponible », pas de bloc Sources. La citation des sources n'a pas pu être vérifiée. Hors périmètre #8 : le pipeline RAG n'est pas modifié par ce refactor. |
| T5 | Authentification | ✅ | 401 sans en-tête, 401 clé invalide. |
| T6 | Validation des entrées | ✅ | 400 messages vide, 400 placeholder seul. |
| T7 | Résolution via l'instance Mastra | ✅ | Import direct et `as any` absents ; `getAgent('ragAgent')` présent. T1–T3 confirment empiriquement que l'agent résolu via l'instance répond correctement. |

## B.5 — Conclusion

Le refactor de l'issue #8 ne provoque **aucune régression** sur le contrat
externe de `/v1/chat/completions` : réponse simple, streaming SSE, filtrage des
placeholders, authentification et validation sont identiques au comportement
attendu. T4 reste à compléter dans un environnement disposant d'une collection
RAG indexée, mais ce point ne dépend pas de l'issue #8.
