# Déploiement E-Synthèse sur Scaleway avec Dokploy

Procédure pas-à-pas pour déployer la stack en production sur **Scaleway**, avec HTTPS automatique via Let's Encrypt et redéploiement continu sur `git push`.

**Durée estimée :** 1 h 30 (provisionnement + configuration + 1er déploiement).

**Pré-requis avant de commencer** :

- Un compte **Scaleway** avec un moyen de paiement.
- Un nom de domaine que tu contrôles (n'importe quel registrar : OVH, Gandi, Namecheap, etc.).
- Une clé API **Albert** (https://albert.api.etalab.gouv.fr).
- Un compte **GitHub** où le repo `e-synthese` est déjà poussé sur la branche `main`.
- Un service **SMTP** (Mailjet, SendGrid, OVH Mail, etc.) pour les emails transactionnels.

---

## Sommaire

1. [Provisionner l'instance Scaleway](#1-provisionner-linstance-scaleway)
2. [Configurer le DNS](#2-configurer-le-dns)
3. [Installer Dokploy](#3-installer-dokploy)
4. [Connecter Dokploy à GitHub](#4-connecter-dokploy-à-github)
5. [Créer l'application dans Dokploy](#5-créer-lapplication-dans-dokploy)
6. [Configurer les variables d'environnement](#6-configurer-les-variables-denvironnement)
7. [Premier déploiement](#7-premier-déploiement)
8. [Vérifications post-déploiement](#8-vérifications-post-déploiement)
9. [Régénérer le secret OIDC Keycloak](#9-régénérer-le-secret-oidc-keycloak)
10. [Tester le pipeline RAG bout-en-bout](#10-tester-le-pipeline-rag-bout-en-bout)
11. [Maintenance courante](#11-maintenance-courante)

---

## 1. Provisionner l'instance Scaleway

1. Console Scaleway : https://console.scaleway.com/
2. **Compute → Instances → Create instance** :
   - **Type** : `DEV1-M` (3 vCPU, 4 GB RAM, 40 GB SSD) — suffisant pour démarrer. Plus de marge avec `GP1-S` (4 vCPU, 8 GB RAM).
   - **Image** : `Ubuntu 22.04 Jammy Jellyfish`.
   - **Région** : `fr-par-1` (Paris) — recommandé pour la latence côté France.
   - **Volume** : 40 GB (par défaut).
   - **SSH keys** : ajouter ta clé publique SSH (sinon tu ne pourras pas te connecter).
3. Cliquer **Create instance**. Provisionnement : ~2 min.
4. Une fois lancée, copier l'**IP publique** (visible dans le détail de l'instance).

### Configuration initiale via SSH

Connecte-toi en SSH avec l'utilisateur par défaut `root` (ou `ubuntu` selon l'image) :

```bash
ssh root@<IP-DU-SERVEUR>
```

Mise à jour du système et configuration du pare-feu :

```bash
apt update && apt upgrade -y

# Pare-feu : autoriser SSH + HTTP + HTTPS
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

> ✅ **Vérification** : `ufw status` doit afficher `Status: active` avec les 3 règles.

---

## 2. Configurer le DNS

Tu as besoin de **deux sous-domaines** qui pointent vers l'IP du serveur Scaleway :

| Sous-domaine | Usage |
|---|---|
| `esynthese.ton-domaine.fr` | UI de chat (frontend Conversations) |
| `auth-esynthese.ton-domaine.fr` | Keycloak (authentification OIDC) |

Dans la console DNS de ton registrar (peu importe lequel : OVH, Gandi, Cloudflare, etc.), créer **2 records A** :

| Type | Nom | Valeur |
|---|---|---|
| A | `esynthese` | `<IP-DU-SERVEUR>` |
| A | `auth-esynthese` | `<IP-DU-SERVEUR>` |

> ✅ **Vérification** (5–15 min de propagation) :
> ```bash
> dig +short esynthese.ton-domaine.fr
> dig +short auth-esynthese.ton-domaine.fr
> ```
> Les deux doivent renvoyer l'IP du serveur.

---

## 3. Installer Dokploy

Sur le serveur (toujours en SSH) :

```bash
curl -sSL https://dokploy.com/install.sh | sh
```

Le script installe Docker, Traefik et Dokploy en une seule commande (~5 min). Quand il termine, l'URL d'accès s'affiche : `http://<IP>:3000`.

### Setup initial de l'UI Dokploy

1. Ouvrir http://<IP>:3000 dans ton navigateur.
2. Créer le **compte admin** (email + mot de passe fort).
3. (Recommandé) Configurer un **domaine pour Dokploy lui-même** : `dokploy.ton-domaine.fr` (créer un 3ème record A et l'ajouter dans Dokploy → Settings → Domains). Tu accèderas alors à l'UI en HTTPS via un certificat Let's Encrypt automatique.

> ✅ **Vérification** : tu peux te connecter à `https://dokploy.ton-domaine.fr` (ou `http://<IP>:3000`) et voir le dashboard Dokploy.

---

## 4. Connecter Dokploy à GitHub

Pour que Dokploy puisse cloner ton repo automatiquement :

1. Dokploy → **Settings → Git Providers → Add GitHub**.
2. Suivre l'assistant OAuth (autoriser Dokploy à accéder à tes repos privés).

À la fin, Dokploy a accès au repo `SGAR-PACA/e-synthese` (ou le nom de ton repo).

---

## 5. Créer l'application dans Dokploy

1. Dokploy → **Projects → New Project** : nommer `e-synthese`.
2. Dans le projet : **New Application → Docker Compose**.
3. Remplir :
   - **Source** : GitHub
   - **Repository** : `<ton-org>/e-synthese`
   - **Branch** : `main`
   - **Build path** : `/` (racine du repo)
   - **Compose path** : `compose.yml`
4. **Save**. Pas encore de déploiement (il faut d'abord les variables d'environnement).

---

## 6. Configurer les variables d'environnement

Dans **Application → Environment** : coller chaque variable de `.env.example.prod` avec sa **vraie valeur**.

### Variables obligatoires

| Variable | Comment la générer |
|---|---|
| `DOMAIN_FRONT` | `esynthese.ton-domaine.fr` |
| `DOMAIN_AUTH` | `auth-esynthese.ton-domaine.fr` |
| `PROXY_API_KEY` | `echo "sk-proxy-$(openssl rand -hex 32)"` |
| `ALBERT_API_KEY` | Récupère depuis ton compte Albert |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` ⚠️ **Conserver une copie** |
| `DJANGO_SECRET_KEY` | `openssl rand -hex 50` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 32` |
| `KC_DB_PASSWORD` | `openssl rand -hex 32` |
| `KEYCLOAK_ADMIN_PASSWORD` | `openssl rand -hex 16` (à mémoriser) |
| `OIDC_RP_CLIENT_SECRET` | Provisoire `openssl rand -hex 32` — sera **régénéré** à l'étape 9 |
| `AWS_S3_SECRET_ACCESS_KEY` | `openssl rand -hex 32` |
| `EMAIL_HOST` | ex. `in-v3.mailjet.com` |
| `EMAIL_PORT` | `587` |
| `EMAIL_USER` | identifiant SMTP |
| `EMAIL_PASSWORD` | mot de passe SMTP |
| `LLM_MODEL` | `albert-large` (par défaut) |

### Sauvegarder les secrets ailleurs

Avant de cliquer **Save** dans Dokploy, **stocke aussi tous ces secrets dans un coffre-fort** (Bitwarden, 1Password, fichier chiffré KeePass, etc.).

> ⚠️ **Si tu perds `ENCRYPTION_KEY`**, les secrets stockés dans la base SQLite Mastra deviennent illisibles définitivement. Pas de récupération possible.

Une fois tout collé, cliquer **Save**.

---

## 7. Premier déploiement

1. Dokploy → ton application → **Deployments → Deploy**.
2. Dokploy fait : `git clone` → `docker compose build` → `docker compose up -d`.
3. **Premier build : 5–10 min** (téléchargement images upstream + build Mastra + import du realm Keycloak + migrations Django).
4. Suivre les logs en temps réel dans l'UI Dokploy.

> ⚠️ **Erreur "Let's Encrypt rate limit"** : si tu redéploies plus de 5 fois en 1 heure pour les mêmes domaines, Let's Encrypt peut bloquer la génération des certs. Solution : passer Traefik en mode `acme.staging` pendant les tests, puis basculer en prod une fois stabilisé.

---

## 8. Vérifications post-déploiement

### Dans l'UI Dokploy

- Onglet **Containers** : tous les services doivent être `Up` et `healthy`.
- Onglet **Logs** sur `mastra` : tu dois voir `Mastra API listening on port 4111`.
- Onglet **Logs** sur `app-dev` : tu dois voir `INFO Application startup complete.`

### Dans le navigateur

| URL | Attendu |
|---|---|
| `https://esynthese.ton-domaine.fr` | Page de connexion Conversations avec icône 🔒 (cert Let's Encrypt valide) |
| `https://auth-esynthese.ton-domaine.fr/admin` | Page de login Keycloak admin |
| `https://esynthese.ton-domaine.fr/api/v1.0/config/` | JSON de config Django (200 OK) |

> Si l'un des deux domaines ne charge pas → vérifier les logs Traefik dans Dokploy. Le plus souvent : DNS pas encore propagé, ou record A mal configuré.

---

## 9. Régénérer le secret OIDC Keycloak

Le realm Keycloak est importé automatiquement avec un secret OIDC arbitraire. Tu dois le **régénérer** et synchroniser sa nouvelle valeur avec la variable d'environnement `OIDC_RP_CLIENT_SECRET`.

1. Aller sur `https://auth-esynthese.ton-domaine.fr/admin`.
2. Se connecter avec `admin` + `KEYCLOAK_ADMIN_PASSWORD` (la valeur que tu as mise dans Dokploy).
3. En haut à gauche, basculer du realm `master` vers `conversations`.
4. **Clients → conversations → Credentials**.
5. Cliquer **Regenerate secret** → copier la nouvelle valeur.
6. Retour Dokploy → Environment → mettre à jour `OIDC_RP_CLIENT_SECRET` avec la nouvelle valeur.
7. Cliquer **Save** puis **Redeploy** depuis Dokploy.

---

## 10. Tester le pipeline RAG bout-en-bout

### Créer un superuser Django

```bash
ssh root@<IP-DU-SERVEUR>

# Trouver le nom exact du conteneur backend
docker ps --filter "name=app-dev" --format "{{.Names}}"

# Créer le superuser
docker exec -it -u root <nom-conteneur-app-dev> python manage.py createsuperuser
```

### Créer un utilisateur Keycloak

1. Keycloak admin → realm `conversations` → **Users → Create new user**.
2. Renseigner email + nom + activer le compte.
3. Onglet **Credentials → Set password**.

### Se logger via l'UI

1. `https://esynthese.ton-domaine.fr` → cliquer **Se connecter**.
2. Redirection automatique vers Keycloak → login avec l'utilisateur créé.
3. Retour vers Conversations connecté.

### Envoyer une question RAG

1. Sélectionner le modèle **« E-Synthèse RAG (Mastra) »** dans le menu déroulant.
2. Poser une question (ex. « Quels sont les enjeux du SGAR PACA ? »).
3. La réponse doit citer des sources `[Source 1]`, `[Source 2]`, etc.

> ✅ Si la réponse arrive avec des sources, **toute la chaîne fonctionne**.

---

## 11. Maintenance courante

### Déploiement automatique sur push

Dokploy détecte les push sur `main` (via webhook GitHub auto-configuré à l'étape 4) et redéploie tout seul. Tu peux désactiver/activer ça dans **Application → Settings → Auto deploy**.

Pour redéployer manuellement : **Deployments → Deploy**.

### Rollback en 1 clic

**Application → Deployments**. Cliquer sur un déploiement antérieur → **Redeploy this deployment**. ~30 secondes.

### Logs

- **UI Dokploy** : onglet **Logs** par service (interface graphique).
- **SSH** : `docker logs -f <nom-conteneur>` (équivalent en ligne de commande).

### Backups

Les données critiques vivent dans **6 volumes Docker nommés** :

| Volume | Contenu |
|---|---|
| `postgres_data` | Base Conversations (chats, users) |
| `kc_postgres_data` | Base Keycloak (auth) |
| `mastra_data` | Base Mastra (admins, secrets chiffrés) |
| `keycloak_data` | Configuration Keycloak |
| `minio_data` | Pièces jointes uploadées |
| `redis_data` | Cache (recréable, optionnel) |

Snapshot quotidien recommandé (à mettre dans un cron sur le serveur) :

```bash
mkdir -p /backups
for vol in postgres_data kc_postgres_data mastra_data keycloak_data minio_data; do
  docker run --rm \
    -v <projet-dokploy>_${vol}:/data \
    -v /backups:/backup \
    alpine tar czf /backup/${vol}-$(date +%F).tar.gz -C / data
done
# Conserver 30 jours
find /backups -name "*.tar.gz" -mtime +30 -delete
```

> Le nom du préfixe `<projet-dokploy>_` est visible avec `docker volume ls`.

### Mise à jour

```bash
# En local
git pull          # ou modifier puis git push
git push origin main

# Dokploy redéploie automatiquement (webhook).
```

### Migration vers un autre serveur (Scaleway → autre)

Procédure portable, ~1 heure :

1. Installer Dokploy sur le nouveau serveur.
2. Backup les 6 volumes (commande ci-dessus) depuis l'ancien serveur, copier les `.tar.gz` sur le nouveau.
3. Restorer les volumes : `tar xzf … -C /` dans des volumes Docker du nouveau serveur.
4. Mettre à jour les DNS (`DOMAIN_FRONT` et `DOMAIN_AUTH`) vers la nouvelle IP.
5. Sur le nouveau Dokploy : créer la même application, coller les **mêmes** variables d'env (récupérées du coffre-fort).
6. Deploy.

Aucune modification de code ni de config nécessaire.

### Rotation de la `PROXY_API_KEY`

1. Dokploy → Environment → générer une nouvelle valeur (`echo "sk-proxy-$(openssl rand -hex 32)"`).
2. Coller dans `PROXY_API_KEY`.
3. Save → Redeploy.

L'ancienne clé est immédiatement invalidée (pas de période de grâce). Le `llm.json` est régénéré au boot du backend avec la nouvelle clé.

### Rotation de l'`ENCRYPTION_KEY` (opération délicate)

⚠️ **Ne jamais faire à la légère** : la clé chiffre les secrets en base SQLite Mastra. Si tu changes la clé sans précaution, tous les secrets stockés (clé Albert, etc.) deviennent illisibles.

Procédure :

1. Récupérer chaque secret en clair depuis l'admin Mastra (`https://esynthese.ton-domaine.fr/admin/settings`).
2. Stopper le service mastra : Dokploy → mastra → Stop.
3. SSH + `docker exec mastra sqlite3 /data/data.db "DELETE FROM config WHERE key='albertApiKey';"`.
4. Dokploy → Environment → mettre à jour `ENCRYPTION_KEY` avec la nouvelle valeur.
5. Save → Redeploy.
6. Re-saisir les secrets dans l'admin Mastra — ils seront re-chiffrés avec la nouvelle clé.
