# E-Synthèse

Assistant conversationnel documentaire du SGAR Provence-Alpes-Côte d'Azur. Les
agents posent leurs questions en langage naturel ; l'assistant cherche les
passages pertinents dans le corpus de documents de l'administration et rédige
une réponse sourcée. Chaque source citée est un lien vers le PDF d'origine, ouvert
à la bonne page avec les passages utilisés surlignés.

L'application est hébergée sur une instance Scaleway et déployée avec Dokploy.

```
                      ┌──────────────── un seul domaine, HTTPS (Traefik) ────────────────┐
navigateur ──────────▶│  /          interface de chat (fork de Conversations, La Suite)   │
                      │  /auth      Keycloak (comptes, SSO)                               │
                      │  /admin     administration Mastra                                 │
                      │  /v1        API Mastra (notation, visionneuse de sources)         │
                      └───────────────────────────────────────────────────────────────────┘
backend Conversations ──▶ Mastra (pipeline RAG) ──▶ Albert API (recherche, rerank, génération)
                                │
                                ├──▶ service OCR (PDF scannés)
                                └──▶ Scaleway Object Storage (PDF sources)
```

## Briques

| Brique | Rôle | Dossier |
|---|---|---|
| Interface de chat | Fork du frontend [Conversations](https://github.com/suitenumerique/conversations) (DINUM), avec notation des réponses | `conversations-frontend/` |
| Backend de chat | Image officielle Conversations (Django) complétée de trois correctifs | `front-back/` |
| Mastra | Service RAG : planification, recherche, rerank, rédaction, sources signées, administration | `mastra/` |
| OCR | Rend les PDF scannés interrogeables (OCRmyPDF, français) | `ocr-service/` |
| Keycloak | Authentification unique et droits d'accès par rôle | `front-back/docker/auth/` |
| Albert API | Modèles de langue et index vectoriel de l'État ([albert.api.etalab.gouv.fr](https://albert.api.etalab.gouv.fr)) | service externe |

## Documentation

| Document | Contenu |
|---|---|
| [Architecture](docs/architecture.md) | Services, réseau, routage, authentification, flux d'une question |
| [Pipeline RAG](docs/pipeline-rag.md) | Ingestion des documents, recherche, rédaction, citations, évaluation, réglages |
| [Administration](docs/administration.md) | Admin Mastra, gestion des utilisateurs et des droits, notation |
| [Déploiement](docs/deploiement.md) | Installation sur Scaleway avec Dokploy, pas à pas |
| [Variables d'environnement](docs/variables-environnement.md) | Référence de toutes les variables |
| [Exploitation](docs/exploitation.md) | Sauvegardes, mises à jour, retour arrière, rotation des secrets, dépannage |
| [Frontend et backend Conversations](docs/frontend.md) | Ce qui diffère de La Suite et comment suivre ses mises à jour |
| [Développement](docs/developpement.md) | Travailler en local, tests, banc de questions |

## Branches

| Branche | Usage |
|---|---|
| `preprod` | Branche de travail |
| `main` | Production : reçoit `preprod` par pull request ; Dokploy déploie chaque push |
| `dev`, `mastra` | Anciennes versions (mai 2026), conservées pour l'historique |

## Licence

MIT, voir [LICENSE](LICENSE). Le dossier `conversations-frontend/` et l'image du
backend proviennent du projet open source Conversations (DINUM) et restent
soumis à sa licence.
