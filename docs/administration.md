# Administration

L'administration se fait à deux endroits :

| Outil | Adresse | Sert à |
|---|---|---|
| Admin Mastra | `https://<DOMAIN_FRONT>/admin/` | Documents, collections, droits par rôle, réglages du pipeline, tests, évaluation, notes |
| Console Keycloak | `https://<DOMAIN_FRONT>/auth/admin/` | Comptes des agents et rôles (realm `conversations`) |

## Admin Mastra

### Comptes

Les comptes de l'admin Mastra sont **propres à Mastra**, indépendants de
Keycloak.

| Rôle | Accès |
|---|---|
| `admin` | Toutes les pages |
| `editor` | Dashboard, Documents, Test Pipeline et Mon compte, limité aux collections qui lui sont attribuées |

- **Premier administrateur** : sur une base vide, la page de connexion propose
  de créer le compte administrateur.
- **Ajouter quelqu'un** : page **Utilisateurs**, créer une invitation (code
  `INV-…`, collections autorisées, durée de validité), puis transmettre le code.
  La personne s'inscrit sur `/admin/register` avec le rôle `editor`.
- **Mot de passe oublié** : chaque compte reçoit un code de récupération
  `RECUP-…` à la création et après chaque changement de mot de passe, à
  conserver. Un administrateur peut aussi générer un lien de réinitialisation
  (page **Utilisateurs**, « forcer la réinitialisation »).
- Mots de passe : 8 caractères au moins, dont un chiffre et une majuscule.
- Après cinq échecs de connexion, l'adresse IP est bloquée quinze minutes.

### Pages

| Page | Contenu |
|---|---|
| Dashboard | État de la connexion à Albert, derniers événements |
| Configuration | Clé et adresse d'Albert, débit maximal, modèles, réglages de recherche et de rédaction, juge, prompt système, adresse de contact |
| Collections | Création et suppression des collections Albert |
| Groupes | Correspondance entre un rôle Keycloak et des collections |
| Documents | Dépôt de PDF (10 Mo maximum chacun) dans une collection, suivi du traitement, suppression |
| Test Pipeline | Pose une question au pipeline avec le détail des étapes, des passages et du nombre d'appels ; historique conservé |
| Utilisateurs | Comptes de l'admin, invitations, révocation des sessions |
| Audit | Journal des actions |
| Évaluation | Notes du juge par métrique, filtres, jugement à la demande |
| Notes | Notes données par les agents (voir plus bas) |
| Mon compte | Changement de mot de passe |

### Ajouter des documents

1. **Collections** : créer la collection si elle n'existe pas (par exemple une
   par service ou par thème).
2. **Documents** : choisir la collection, déposer un ou plusieurs PDF.
3. Attendre le statut « prêt » : l'OCR d'un document scanné peut prendre
   plusieurs minutes. Un statut « échec » affiche la cause.
4. **Groupes** : vérifier que les rôles concernés ont accès à la collection.
5. **Test Pipeline** : poser une question dont la réponse est dans le document.

Pour remplacer un document, supprimer l'ancien puis déposer le nouveau : deux
versions présentes en même temps seraient citées toutes les deux.

### Modifier le prompt système

Page **Configuration**, champ « Prompt système ». Il fixe le ton, la langue et
surtout le format du bloc Sources dont dépendent les liens cliquables. Après
toute modification, refaire quelques questions dans **Test Pipeline** et vérifier
que les sources restent cliquables.

## Agents et droits (Keycloak)

Les agents qui utilisent le chat ont un compte dans le realm `conversations`.
L'inscription libre est désactivée.

### Créer un compte

1. Console Keycloak, se connecter avec `admin` et `KEYCLOAK_ADMIN_PASSWORD`.
2. Choisir le realm **conversations** (menu en haut à gauche).
3. **Users → Add user** : adresse électronique, prénom, nom, compte activé.
4. Onglet **Credentials → Set password** : mot de passe provisoire, case
   « Temporary » cochée pour que l'agent le change à la première connexion.
5. Onglet **Role mapping → Assign role** : attribuer le ou les rôles de realm
   qui ouvrent l'accès aux bonnes collections.

Sans rôle associé à une collection, l'agent peut se connecter mais l'assistant
ne trouvera aucun document. Le rôle `admin` donne accès à tout le corpus.

### Créer un nouveau périmètre d'accès

1. Keycloak : **Realm roles → Create role**, par exemple le nom d'un service.
2. Admin Mastra, page **Groupes** : saisir exactement le même nom et cocher les
   collections correspondantes.
3. Attribuer le rôle aux agents concernés.

Les rôles sont lus dans les jetons de l'agent : un changement peut ne prendre
effet qu'après renouvellement de ses jetons, et pour la visionneuse qu'à sa
prochaine connexion. En cas de doute, lui demander de se déconnecter puis de se
reconnecter.

### Réglages appliqués à chaque déploiement

La tâche `keycloak-provision-rating` repasse à chaque déploiement :

- inscription libre désactivée ;
- français par défaut ;
- sessions de 10 heures ;
- double authentification (OTP) désactivée, **et les OTP déjà configurés par les
  utilisateurs sont supprimés** ;
- création du client `mastra-rating-spa` s'il manque.

Toute modification manuelle de ces points dans la console est donc écrasée au
déploiement suivant. Pour les changer durablement, modifier la tâche dans
`compose.yml`.

### Envoi d'e-mails par Keycloak

Le realm est importé sans serveur SMTP : la fonction « mot de passe oublié » de
Keycloak n'envoie rien tant qu'un SMTP n'est pas renseigné dans
**Realm settings → Email**. Le SMTP de `EMAIL_*` ne sert qu'au backend
Conversations.

## Notes des utilisateurs

Sous chaque réponse, les agents peuvent attribuer une à cinq étoiles et laisser
un commentaire (2 000 caractères au plus). Une seule note par agent et par
réponse, modifiable. L'identité vient du jeton Keycloak.

La page **Notes** de l'admin présente :

- le nombre de notes, la moyenne, la part de notes de 4 ou 5 et l'activité de la
  semaine ;
- la répartition des notes et la moyenne quotidienne sur 30 jours ;
- la liste filtrable (positives, négatives, avec commentaire, recherche texte) ;
- pour chaque note : la question, la réponse, et les passages des sources citées.

Les réponses mal notées sont le meilleur point de départ pour améliorer le
corpus ou les réglages.
