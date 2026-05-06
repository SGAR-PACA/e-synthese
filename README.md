# E-Synthèse Final — version PRODUCTION

Configuration prête à déployer sur un VPS Linux (OVH, Scaleway, etc.) via **Dokploy**, avec TLS automatique (Let's Encrypt via Traefik).

```
Internet ──HTTPS──▶ Traefik (Dokploy) ──▶ Conversations ──▶ Mastra ──▶ Albert API
                    auto Let's Encrypt    (front + back)    (RAG)
```

> Pour le développement local, voir **`E-synthese-final-dev/`** (HTTP, hot reload, comptes test).
> Pour Mastra seul, voir **`E-synthese-mastra/`** (source canonique).

---

## Sommaire

- **[DEPLOY.md](DEPLOY.md)** : procédure pas à pas pour déployer sur OVH avec Dokploy
- Ce README : vue d'ensemble, test prod en local, rollback, exploitation

---

## Différences avec final-dev

| Aspect | `final-dev` | `final` (ce dossier) |
|---|---|---|
| Reverse-proxy | aucun (HTTP direct) | Traefik via Dokploy (auto-HTTPS) |
| Ports exposés | 3000, 4111, 8071, 8083, 9001, 1081 | 80 + 443 (Traefik) uniquement |
| Mastra | Build `Dockerfile.dev` + bind mount `src/` (hot reload) | Build `Dockerfile` (image immutable, plus tard image GHCR pinnée) |
| Restart policy | aucune | `always` partout |
| Volumes | bind mounts + `mastra_data` named | named volumes durables (postgres, kc_postgres, redis, minio, mastra, keycloak) |
| Django config | `LocalDev` (TLS désactivé) | `Production` (TLS strict) |
| Keycloak | `realm.json` avec comptes test + URLs `localhost` | `realm.prod.json.tpl` (sans comptes, URLs templatées avec `__DOMAIN_FRONT__` substitué au boot via `sed`) |
| Maildev | inclus | retiré (utiliser un vrai SMTP) |
| nginx (reverse-proxy auth) | inclus | retiré (Traefik fait le travail) |
| Secrets | `.env` auto-généré par bootstrap | `.env` rempli par Dokploy UI (jamais commité) |
| `llm.json` | rendu par bootstrap depuis `.tpl` | rendu au démarrage du conteneur via `envsubst` |

---

## Prérequis

- Un VPS Linux (Ubuntu 22.04+ ou Debian 12+ recommandé) avec Docker et Docker Compose v2.
- ≥ 4 GB RAM, ≥ 40 GB disque.
- Deux noms de domaine (ou sous-domaines) qui pointent vers l'IP du VPS :
  - `DOMAIN_FRONT` (ex : `esynthese.example.fr`) — pour l'UI chat
  - `DOMAIN_AUTH` (ex : `auth-esynthese.example.fr`) — pour Keycloak
- Ports 80 et 443 ouverts (Let's Encrypt + trafic HTTPS).
- Un service SMTP (Mailjet, SendGrid, OVH SMTP, etc.) pour les emails transactionnels.
- Une clé API Albert (https://albert.api.etalab.gouv.fr).
- **Dokploy installé sur le VPS** : `curl -sSL https://dokploy.com/install.sh | sh`

Pour la procédure complète de déploiement, voir **[DEPLOY.md](DEPLOY.md)**.

---

## Tester la config prod en local (avant déploiement)

Utile pour vérifier que `compose.yml` est valide et que tous les services démarrent sans erreur, avant de pousser sur GitHub.

```bash
cd E-synthese-final

# 1. Créer un .env local avec des valeurs de test
cp .env.example.prod .env
# Édite .env :
#   - DOMAIN_FRONT=localhost
#   - DOMAIN_AUTH=localhost
#   - Génère tous les secrets aléatoires : openssl rand -hex 32
#   - ALBERT_API_KEY=ta-clé-réelle (sinon Mastra démarre mais le RAG échoue)

# 2. Valider la syntaxe du compose
docker compose config --quiet && echo OK

# 3. Lancer (ATTENTION : Traefik n'est PAS lancé, donc l'UI ne sera
#    pas accessible en HTTPS — c'est juste un test que tout démarre)
docker compose up -d

# 4. Vérifier l'état
docker compose ps

# 5. Arrêter
docker compose down
```

> ⚠️ Cette procédure ne teste pas la couche TLS / Traefik. Pour valider le
> déploiement complet, il faut le faire sur un vrai serveur via Dokploy
> (voir **[DEPLOY.md](DEPLOY.md)**).

---

## Mécanisme de rollback (3 niveaux)

| Niveau | Cas typique | Procédure |
|---|---|---|
| **1. Code applicatif** | Bug introduit dans un commit récent | Dokploy UI → onglet "Deployments" → "Redeploy" sur un commit antérieur. ~30 secondes. |
| **2. Image Mastra** | Image GHCR cassée (une fois la CI publiée) | Dans `compose.yml`, ligne `mastra: image: …@sha256:…`, remettre l'ancien digest, push, Dokploy redéploie. |
| **3. Stack Conversations** | DINUM pousse un `:main` cassé | Le digest est déjà pinné dans `compose.yml`, donc protégé. Ne bumper le digest qu'avec un test préalable. Rollback = `git revert` du commit qui a bumpé. |

**Le digest pinning est la base du rollback fiable** : chaque ligne `image: foo@sha256:xxx` est une ancre temporelle immutable. Tu peux toujours revenir en arrière en remettant le digest précédent.

---

## Exploitation

### Logs

Dokploy expose les logs de chaque service dans son UI. En SSH sur le serveur :

```bash
docker compose -f /etc/dokploy/<projet>/docker-compose.yml logs -f mastra
docker compose -f /etc/dokploy/<projet>/docker-compose.yml logs -f app-dev
```

### Backups

Les données critiques vivent dans 4 volumes nommés :

| Volume | Contenu |
|---|---|
| `postgres_data` | Conversations DB (chats, users, documents indexés) |
| `kc_postgres_data` | Keycloak DB (users authentifiés, realm) |
| `mastra_data` | Mastra DB (admins, sessions, secrets chiffrés) |
| `minio_data` | Pièces jointes uploadées |

Snapshot quotidien recommandé :

```bash
# À mettre dans un cron côté serveur
for vol in postgres_data kc_postgres_data mastra_data minio_data; do
  docker run --rm \
    -v e-synthese-prod_${vol}:/data \
    -v /backups:/backup \
    alpine tar czf /backup/${vol}-$(date +%F).tar.gz -C / data
done
```

Conserver ≥ 30 jours, tester la restauration régulièrement.

### Mise à jour

```bash
# 1. En local : modifier le code, tester sur final-dev, commiter, push
git push origin main

# 2. Dokploy détecte le push (webhook) et redéploie automatiquement
#    OU manuellement via l'UI : "Redeploy"
```

### Migration OVH → Scaleway (ou inverse)

Procédure portable, ~1 heure :

1. Installer Dokploy sur le nouveau serveur.
2. Backup des 4 volumes nommés depuis l'ancien serveur (commande ci-dessus).
3. Restore par `tar xzf … -C /` dans des volumes Docker du nouveau serveur.
4. Mettre à jour les DNS (`DOMAIN_FRONT` et `DOMAIN_AUTH`) vers la nouvelle IP.
5. Lancer Dokploy + déployer le repo + remplir les env vars (les mêmes secrets).

Aucune modification de code. Aucun fournisseur cloud spécifique.

---

## Architecture

| Service | Image / source | Port interne | Exposé public |
|---|---|---|---|
| `mastra` | Build local depuis `mastra/Dockerfile` (à terme : image GHCR pinnée) | 4111 | Non (sauf ajout de labels Traefik) |
| `app-dev` (backend Conversations) | `lasuite/conversations-backend:main@sha256:337516…` | 8000 | Non (proxy via frontend) |
| `frontend-development` | `lasuite/conversations-frontend:main@sha256:b204d0…` | 3000 | **Oui via Traefik** (`DOMAIN_FRONT`) |
| `keycloak` | `quay.io/keycloak/keycloak:26.3` | 8080 | **Oui via Traefik** (`DOMAIN_AUTH`) |
| `postgresql` | `postgres:16` | 5432 | Non |
| `kc_postgresql` | `postgres:17.5` | 5432 | Non |
| `redis` | `redis:5` | 6379 | Non |
| `minio` | `minio/minio` | 9000 | Non (extension future possible) |
| `createbuckets` | `minio/mc` | (job d'init) | Non |

---

## Limitations connues / TODO

- **Image Mastra GHCR** : la CI GitHub Actions n'est pas encore en place. Tant que c'est le cas, `compose.yml` build l'image localement à chaque déploiement. À basculer sur une image immutable dès que la CI est OK.
- **Monitoring / alerting** : non inclus dans cette spec. À ajouter via Grafana Cloud, Better Uptime, ou Dokploy native (selon plan).
- **MinIO console** : non exposée publiquement par défaut. Pour y accéder : tunnel SSH (`ssh -L 9001:minio:9001 …`) ou ajouter des labels Traefik.

---

## Pour aller plus loin

- **Procédure de déploiement** : [DEPLOY.md](DEPLOY.md)
- **Mastra autonome** : voir la branche `mastra` du repo
- **Intégration dev en HTTP local** : voir la branche `dev` du repo
