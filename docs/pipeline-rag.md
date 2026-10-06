# Pipeline RAG

Le service `mastra/` (framework [Mastra](https://mastra.ai), Node.js 22) répond
aux questions à partir du corpus documentaire. Il ne stocke pas lui-même de
vecteurs : les embeddings et la recherche vectorielle sont fournis par les
**collections d'Albert API**.

## 1. Ingestion des documents

Les documents sont déposés depuis l'admin Mastra, page **Documents**.

| Contrainte | Valeur |
|---|---|
| Format | PDF uniquement (signature `%PDF-` vérifiée) |
| Taille | 10 Mo par fichier |
| Destination | une collection Albert choisie au dépôt |

Étapes, exécutées en arrière-plan par le worker d'ingestion
(`mastra/src/lib/document-worker.ts`, interrogation toutes les 3 secondes) :

1. **Stockage** : le PDF est enregistré dans le bucket `S3_DOCS_BUCKET`
   (`{id}/original.pdf`) et une ligne `document_files` est créée avec le statut
   `processing`.
2. **OCR** : le PDF est envoyé au service `ocr`, qui ajoute une couche de texte
   aux pages scannées (OCRmyPDF, langue française). Le résultat remplace
   l'original (`{id}/searchable.pdf`). Si l'OCR échoue, l'original est conservé
   et indexé tel quel.
3. **Découpage** : le texte est extrait localement avec MuPDF, page par page, et
   regroupé en passages d'environ 1 900 caractères, sans couper les lignes
   (`ALBERT_LOCAL_PDF_CHUNK_SIZE`). Chaque passage garde ses numéros de page.
   Si l'extraction échoue, le PDF entier est confié à Albert qui le découpe
   lui-même.
4. **Indexation** : un document est créé dans la collection Albert et les
   passages y sont envoyés par lots de 64. Albert calcule les embeddings.
5. **Surlignage** : chaque passage est aligné sur les mots du PDF pour
   enregistrer ses coordonnées exactes (tables `document_chunk_highlights` et
   `document_highlight_manifests`). Un échec ici n'empêche pas l'indexation ;
   un rattrapage automatique retente plus tard.
6. Le document passe au statut `ready` (ou `failed`, avec le message d'erreur).

Le worker ne démarre que si `S3_DOCS_BUCKET` et `OCR_SERVICE_URL` sont
renseignés. La suppression d'un document l'efface d'Albert, de la base et du
bucket.

## 2. Réponse à une question

Point d'entrée : `POST /v1/chat/completions` (`mastra/src/routes/chat-completions.ts`),
compatible avec l'API OpenAI. Le champ `model` envoyé par le client est ignoré.

### Contrôles

- Clé `Authorization: Bearer <PROXY_API_KEY>` (comparaison à temps constant).
- Jeton Keycloak de l'utilisateur dans `X-User-Token`, vérifié contre les clés
  publiques du realm. Sans jeton : refus (401), sauf si
  `MASTRA_REQUIRE_USER_TOKEN=false`.
- Calcul des collections autorisées à partir des rôles (voir
  [Architecture](architecture.md#droits-daccès-aux-documents)).

### Étapes

1. **Planification** (`pipeline/planner.ts`, température 0). Le modèle décide :
   - réponse directe, sans aucune recherche, pour une salutation ou un échange
     de politesse ;
   - sinon, jusqu'à `maxSearchQueries` reformulations (2 par défaut, 4 au plus).
     Les sigles du glossaire (`pipeline/glossary.ts` : DSIL, DETR, SGAR…) sont
     développés.
2. **Recherche** (`pipeline/retrieval.ts`) : une recherche Albert par
   reformulation, en parallèle, limitée aux collections autorisées, avec
   `searchWideK` résultats chacune (20 par défaut). Les résultats sont
   fusionnés et dédoublonnés.
3. **Rerank** (si `useRerank`) : Albert reclasse les passages par rapport à la
   question d'origine (modèle `BAAI/bge-reranker-v2-m3`).
4. **Seuil** : si le meilleur score est inférieur à `rerankMinScore` (0,2), ou à
   `minScore` (0,5) sans rerank, aucun passage n'est retenu. Sinon les `finalK`
   meilleurs (8) sont transmis.
5. **Rédaction** (`pipeline/writer.ts`) : le modèle de génération reçoit le
   prompt système (modifiable dans l'admin), la question et les passages
   numérotés. Sans passage, il doit répondre honnêtement qu'il n'a rien trouvé.
6. **Sources** : la réponse se termine par un bloc

   ```
   **Sources :**
   - Source 1 : *nom du document*
   ```

   Les renvois dans le texte (`[1]`, `[Source 1]`…) sont interdits. Si le modèle
   oublie le bloc, Mastra l'ajoute ; s'il refuse de répondre, le bloc est
   retiré. Chaque ligne est ensuite transformée en **lien signé** vers la
   visionneuse (voir plus bas).

En mode flux (`stream: true`), l'interface reçoit d'abord des étapes de
progression (« Analyse de la question… », « Recherche dans les documents… »,
« Rédaction de la réponse… »), puis le texte au fil de l'eau ; le bloc Sources
est retenu puis envoyé, réécrit, à la fin.

### Coût en appels Albert

Avec les réglages par défaut, une question documentaire consomme au plus cinq
appels : planification, deux recherches, rerank, rédaction. Une salutation n'en
consomme qu'un. L'évaluation automatique en ajoute un sur 10 % des réponses.

## 3. Visionneuse de sources

Un lien de source a la forme
`/v1/source/{documentId}?used={passages}&exp={échéance}&sig={signature}`.

- La signature HMAC (`MASTRA_SOURCE_LINK_KEY`) empêche de fabriquer un lien ;
  elle expire au bout de 30 jours (`MASTRA_SOURCE_LINK_TTL_SECONDS`).
- À l'ouverture, l'utilisateur est authentifié par Keycloak (client
  `mastra-sources`, connexion silencieuse s'il est déjà connecté au chat).
- Mastra vérifie que la collection du document fait partie des collections
  autorisées pour ses rôles, sinon l'accès est refusé.
- Le PDF est affiché avec pdf.js (copié dans `mastra/public/source/`), les
  passages utilisés sont surlignés et la page défile jusqu'au premier.

Si `MASTRA_SOURCE_LINK_KEY` est vide, les sources restent affichées en texte
simple, sans lien.

## 4. Évaluation automatique

Chaque réponse documentaire est enregistrée dans la table `rag_runs`. Une partie
d'entre elles (`evalSamplingRate`, 10 % par défaut) est notée en arrière-plan
par un **modèle juge**, distinct du modèle de génération (`deepseek-v4-flash`
par défaut). Un seul appel renvoie quatre notes entre 0 et 1 :

| Métrique | Question posée au juge |
|---|---|
| `system_prompt` | La réponse respecte-t-elle les consignes (français, format, bloc Sources) ? |
| `faithfulness` | Chaque affirmation est-elle appuyée par les passages ? |
| `completeness` | La réponse couvre-t-elle ce que les passages permettent de dire ? |
| `retrieval_quality` | Les passages trouvés étaient-ils les bons ? |

Pour un refus, seule `system_prompt` est notée. Les résultats se consultent dans
l'admin, page **Évaluation**, qui permet aussi de lancer le juge à la demande
sur une réponse. Le juge donne une tendance, pas une vérité : il
doit être recoupé par une relecture humaine sur un échantillon.

Cette évaluation est indépendante de la **notation par les utilisateurs** (une à
cinq étoiles sous chaque réponse), décrite dans [Administration](administration.md#notes-des-utilisateurs).

## 5. Réglages

Tous les réglages se font dans l'admin Mastra, page **Configuration**. La valeur
enregistrée en base est prioritaire sur la variable d'environnement : après un
déploiement, c'est la valeur affichée dans l'admin qui compte.

### Valeurs de référence

| Paramètre | Valeur | Raison |
|---|---:|---|
| Modèle de génération | `openweight-large` | Qualité générale |
| Température | 0,20 | Réponses factuelles et stables |
| Top P | 1 | Désactivé : régler la température **ou** Top P, pas les deux |
| Sortie maximale | 2 048 jetons | Plafond, pas une cible |
| Reformulations maximales | 2 | Équilibre couverture / nombre d'appels |
| `searchWideK` | 20 | Candidats par recherche, avant rerank |
| `finalK` | 8 | Passages transmis au rédacteur |
| Rerank | activé | Meilleur classement, au prix d'un appel |
| `rerankMinScore` | 0,20 | À calibrer sur le corpus |
| Modèle juge | `deepseek-v4-flash` | Différent du modèle de génération |
| Température du juge | 0 | Notes reproductibles |
| Taux d'évaluation | 0,10 | Une réponse sur dix |
| Recherche élargie du juge | désactivée | Réservée aux audits (+1 appel) |

Quelques repères :

- un `finalK` trop élevé noie l'information utile au milieu d'un long contexte ;
  le couple 16/6 est la principale alternative à tester ;
- le seuil de rerank dépend du modèle et du corpus : il se calibre en observant
  les scores réels ;
- chaque reformulation supplémentaire coûte une recherche ; au-delà de deux, le
  gain doit être démontré sur les questions de référence.

### Protocole pour modifier un réglage

1. **Préparer 15 à 30 questions de référence**, en quatre familles : faits
   simples, questions demandant plusieurs documents, questions hors corpus (qui
   doivent produire un refus honnête), questions sensibles aux dates, montants
   et sigles. Noter pour chacune les sources et éléments de réponse attendus.
2. **Comparer les profils de recherche**, juge désactivé, dans l'admin page
   **Test pipeline** (ou avec le banc `scripts/bench/`, voir
   [Développement](developpement.md#banc-de-questions)) :

   | Profil | Reformulations | `searchWideK` | `finalK` | Rerank |
   |---|---:|---:|---:|---|
   | A, équilibré | 2 | 20 | 8 | oui |
   | B, contexte resserré | 2 | 16 | 6 | oui |
   | C, économique | 1 | 12 | 5 | non |

   Ne changer qu'un paramètre entre deux séries. Retenir le profil le plus fidèle
   aux documents et qui refuse correctement, pas celui qui produit les réponses
   les plus longues.
3. **Comparer la température** (0,10, 0,20, 0,30) avec le meilleur profil, Top P
   restant à 1.
4. **Valider le juge** sur une série d'audit : activer la recherche élargie,
   cocher « Exécuter le judge » dans le test, comparer ses notes à la revue
   humaine, puis désactiver la recherche élargie.

Les séries doivent rester séquentielles : le limiteur à 8 requêtes par minute
mettrait sinon les tests en file d'attente.

## 6. Données en base

Base PostgreSQL `mastra`. Le schéma est créé et complété automatiquement au
premier accès (`mastra/src/lib/db.ts`), sans fichier de migration.

| Table | Contenu |
|---|---|
| `config` | Réglages de l'admin ; la clé Albert y est chiffrée (AES-256-GCM, `ENCRYPTION_KEY`) |
| `users`, `sessions`, `invitations`, `password_resets` | Comptes de l'admin Mastra |
| `user_collections` | Collections autorisées pour chaque éditeur de l'admin |
| `group_collections` | Correspondance rôle Keycloak → collections |
| `document_files` | Documents déposés, statut, emplacement dans le bucket |
| `document_chunk_highlights`, `document_highlight_manifests` | Coordonnées de surlignage |
| `source_sessions`, `source_logout_tokens` | Sessions de la visionneuse |
| `rag_runs`, `rag_scores` | Réponses journalisées et notes du juge |
| `pipeline_test_runs` | Historique des tests lancés depuis l'admin |
| `user_ratings` | Notes données par les utilisateurs |
| `audit_log` | Journal des actions (connexions, dépôts, consultations de sources…) |

Les tables internes du framework Mastra (traces, mémoire) partagent la même base.
