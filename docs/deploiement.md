# Déploiement

E-Synthèse tourne sur une instance Scaleway, pilotée par
[Dokploy](https://dokploy.com). Dokploy clone le dépôt GitHub, construit les
images, lance `compose.yml` et gère Traefik, qui obtient les certificats
Let's Encrypt. Chaque push sur `main` déclenche un redéploiement.

Compter environ une heure et demie pour une installation complète.

## Prérequis

| Élément | Détail |
|---|---|
| Compte Scaleway | Instances, Object Storage et IAM |
| Nom de domaine | Un sous-domaine, par exemple `esynthese.example.fr` |
| Clé Albert API | Demande sur [albert.api.etalab.gouv.fr](https://albert.api.etalab.gouv.fr) |
| Accès au dépôt GitHub | `<organisation>/<dépôt>` |
| Serveur SMTP | Pour les e-mails envoyés par le backend Conversations |
| Coffre-fort de mots de passe | Pour conserver tous les secrets générés |

## 1. Créer l'instance

Console Scaleway, **Compute → Instances → Create instance** :

| Réglage | Valeur conseillée |
|---|---|
| Type | 4 vCPU et 8 Go de RAM au moins |
| Image | Ubuntu 22.04 ou plus récent |
| Région | `fr-par` (Paris) |
| Disque | 50 Go |
| Clé SSH | Ajouter la clé publique de chaque administrateur |

L'architecture doit être **x86-64** : l'image du backend Conversations est forcée
en `linux/amd64`.

Une fois l'instance créée, noter son IP publique, puis :

```bash
ssh root@<IP>
apt update && apt upgrade -y
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

Ajouter localement un raccourci dans `~/.ssh/config` :

```
Host mon-serveur
  HostName <IP>
  User root
  IdentityFile ~/.ssh/<clé>
```

## 2. Configurer le DNS

Chez le registrar, créer un enregistrement **A** pour le sous-domaine, pointant
vers l'IP de l'instance. Un seul domaine suffit : Keycloak et Mastra sont servis
sous des chemins du même domaine.

```bash
dig +short esynthese.example.fr    # doit renvoyer l'IP de l'instance
```

## 3. Créer les buckets et les clés Scaleway

Deux buckets privés, région `fr-par`, dans **Object Storage → Create bucket** :

| Bucket | Usage | Variables |
|---|---|---|
| `<bucket-sauvegardes>` | Sauvegardes quotidiennes des bases | `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` |
| `<bucket-documents>` | Documents du corpus | `S3_DOCS_BUCKET`, `S3_DOCS_ACCESS_KEY`, `S3_DOCS_SECRET_KEY` |

Pour chacun, dans **IAM**, créer une application dédiée, lui attacher une
politique d'accès à Object Storage limitée au bucket concerné, puis générer une
clé d'API. Copier la clé secrète immédiatement : elle n'est plus affichée
ensuite.

Le nom du bucket de sauvegarde se règle par `BACKUP_S3_BUCKET` dans
`front-back/env.d/production/backup`.

## 4. Installer Dokploy

```bash
curl -sSL https://dokploy.com/install.sh | sh
```

Le script installe Docker, Dokploy et Traefik. Ouvrir ensuite
`http://<IP>:3000`, créer le compte administrateur de Dokploy, puis lui
attribuer un domaine (**Settings → Domains**) pour y accéder en HTTPS.

Dans **Settings → Git Providers**, connecter le compte GitHub qui a accès au
dépôt.

## 5. Créer l'application

1. **Projects → New Project**, puis **Create Service → Compose**.
2. Source : GitHub, dépôt `<organisation>/<dépôt>`, branche `main`, chemin du
   fichier `compose.yml`.
3. Activer le déploiement automatique (webhook GitHub).

## 6. Renseigner les variables

Onglet **Environment** de l'application : recopier `.env.example.prod` et
remplir chaque valeur. La signification de chaque variable est dans
[Variables d'environnement](variables-environnement.md).

```bash
openssl rand -hex 32                  # mots de passe et clés
echo "sk-proxy-$(openssl rand -hex 32)" # PROXY_API_KEY
openssl rand -hex 50                  # DJANGO_SECRET_KEY
```

`OIDC_RP_CLIENT_SECRET` reçoit une valeur provisoire : elle sera remplacée à
l'étape 8.

**Avant d'enregistrer, copier tous les secrets dans le coffre-fort.** La perte de
`ENCRYPTION_KEY` rend illisible la clé Albert stockée en base (il faut alors la
ressaisir dans l'admin).

## 7. Premier déploiement

Onglet **Deployments → Deploy**. Le premier déploiement prend 10 à 20 minutes :
construction de quatre images (frontend, backend, Mastra, OCR), import du realm
Keycloak, migrations Django.

Quand il est terminé, tous les services doivent être démarrés ; les deux tâches
`keycloak-provision-*` et `createbuckets` s'arrêtent normalement après leur
travail.

## 8. Régénérer le secret du client `conversations`

Le realm est importé avec un secret d'exemple pour le client `conversations`.

1. Ouvrir `https://<DOMAIN_FRONT>/auth/admin/`, se connecter avec `admin` et
   `KEYCLOAK_ADMIN_PASSWORD`.
2. Realm **conversations → Clients → conversations → Credentials →
   Regenerate**.
3. Copier le secret dans `OIDC_RP_CLIENT_SECRET` (Dokploy), enregistrer et
   redéployer.

Le client `mastra-sources` n'a pas besoin de cette étape : son secret est
appliqué automatiquement à partir de `MASTRA_OIDC_CLIENT_SECRET`.

## 9. Configurer l'application

1. **Admin Mastra** : ouvrir `https://<DOMAIN_FRONT>/admin/` et créer le compte
   administrateur. Dans **Configuration**, vérifier la clé Albert, le modèle et
   les réglages (voir [Pipeline RAG](pipeline-rag.md#5-réglages)).
2. **Corpus** : créer les collections, déposer les PDF, associer les rôles
   Keycloak aux collections (voir [Administration](administration.md)).
3. **Agents** : créer les comptes et leur attribuer les rôles dans Keycloak.

## 10. Vérifier

| Vérification | Résultat attendu |
|---|---|
| `https://<DOMAIN_FRONT>/` | Page d'accueil du chat, certificat valide |
| Connexion avec un compte agent | Retour sur le chat, connecté |
| Une question couverte par le corpus | Réponse avec un bloc « Sources » dont les liens ouvrent le PDF surligné |
| Une question hors corpus | Refus honnête, sans source |
| Étoiles sous une réponse | Note enregistrée, visible dans l'admin page **Notes** |
| Logs de `mastra_backup` | Cycle terminé par `backup cycle done` |
| Bucket de sauvegarde | Trois fichiers `.sql.gz` du jour |

Les logs de chaque service sont accessibles dans l'onglet **Logs** de Dokploy,
ou en SSH (voir [Exploitation](exploitation.md#logs)).

## Points d'attention

- **Limite Let's Encrypt** : au-delà de cinq certificats pour le même domaine en
  une semaine, Let's Encrypt refuse d'en délivrer d'autres. Éviter de recréer
  l'application en boucle.
- **Frontend et domaine** : l'adresse du domaine est intégrée au build du
  frontend. Changer `DOMAIN_FRONT` impose un redéploiement complet (reconstruction).
- **Une seule instance de Mastra** : ne pas augmenter le nombre de réplicas, le
  limiteur de débit vers Albert est en mémoire.
