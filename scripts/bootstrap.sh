#!/usr/bin/env bash
# Première installation : génère les secrets, lance la stack.
# Idempotent : si .env existe déjà, on saute la génération de secrets.
set -euo pipefail

cd "$(dirname "$0")/.."

# 0. Pré-check : Docker tourne et a assez d'espace
if ! docker info >/dev/null 2>&1; then
  echo "❌ Docker n'est pas en cours d'exécution."
  echo "   Lance Docker Desktop (ou ton démon Docker) et relance ce script."
  exit 1
fi

# Espace disque côté Docker : la stack a besoin d'au moins 10 GB libres
# pour les images (~5 GB) + les volumes Postgres / SQLite Mastra.
# On lit l'espace dispo dans la VM Docker via un conteneur ad-hoc.
DOCKER_FREE_GB=$(docker run --rm alpine df -BG /var 2>/dev/null | awk 'NR==2 {gsub("G",""); print $4}' || echo "0")
if [ "${DOCKER_FREE_GB:-0}" -lt 10 ]; then
  echo "⚠️  Docker dispose seulement de ${DOCKER_FREE_GB} GB libres (10 GB minimum recommandés)."
  echo
  echo "Pour libérer de l'espace :"
  echo "  • docker system prune -a --volumes -f         (libère images/volumes inutilisés)"
  echo "  • Docker Desktop → Settings → Resources → Disk image size → augmenter à ≥128 GB"
  echo
  read -p "Continuer quand même ? (y/N) " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

# 1. Créer .env si absent
if [ ! -f .env ]; then
  cp .env.example .env
  PROXY_KEY="sk-proxy-$(openssl rand -hex 24)"

  # Substituer le placeholder dans .env
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|sk-proxy-PLACEHOLDER|$PROXY_KEY|g" .env
  else
    sed -i "s|sk-proxy-PLACEHOLDER|$PROXY_KEY|g" .env
  fi

  # Rendre llm.json depuis le template avec la même clé
  cp front-back/docker/patches/llm.json.tpl front-back/docker/patches/llm.json
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|\${PROXY_API_KEY}|$PROXY_KEY|g" front-back/docker/patches/llm.json
  else
    sed -i "s|\${PROXY_API_KEY}|$PROXY_KEY|g" front-back/docker/patches/llm.json
  fi

  echo "✅ .env créé + PROXY_API_KEY générée et synchronisée dans llm.json"
else
  echo "ℹ️  .env existe déjà — secrets conservés"

  # S'assurer que llm.json existe (il pourrait avoir été supprimé manuellement)
  if [ ! -f front-back/docker/patches/llm.json ]; then
    PROXY_KEY=$(grep '^PROXY_API_KEY=' .env | cut -d= -f2-)
    cp front-back/docker/patches/llm.json.tpl front-back/docker/patches/llm.json
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|\${PROXY_API_KEY}|$PROXY_KEY|g" front-back/docker/patches/llm.json
    else
      sed -i "s|\${PROXY_API_KEY}|$PROXY_KEY|g" front-back/docker/patches/llm.json
    fi
    echo "✅ llm.json regénéré depuis le template"
  fi
fi

# 2. Lancer la stack
#
# Note : au 1er démarrage après un reset complet (volumes vierges),
# Postgres peut prendre ~30 secondes pour finir sa "consistent recovery
# state". docker-compose peut alors abandonner sur dependency failed.
# On retry une fois automatiquement — Postgres sera prêt au 2e essai.
echo
echo "⏳ Build et démarrage des services..."
if ! docker compose up -d --build; then
  echo
  echo "⚠️  Premier lancement interrompu (Postgres lent à finaliser sa recovery)"
  echo "    Retry automatique dans 10 secondes..."
  sleep 10
  docker compose up -d
fi

# 3. Attendre que le backend soit prêt et lancer la migration Django
echo
echo "⏳ Attente du backend (max 60 s)..."
for i in {1..30}; do
  if docker compose exec -T -u root app-dev python -c 'import django' 2>/dev/null; then
    echo "✅ Backend prêt"
    break
  fi
  sleep 2
done

echo "⏳ Migration de la base Django..."
if ! docker compose exec -T -u root app-dev python manage.py migrate; then
  echo "⚠️  La migration a échoué — vérifie les logs : docker compose logs app-dev"
fi

echo
echo "🎉 E-Synthèse (mode dev) démarré !"
echo
echo "   Frontend (chat)  : http://localhost:3000"
echo "   Backend (API)    : http://localhost:8071/api/v1.0/config/"
echo "   Mastra (RAG)     : http://localhost:4111/v1/models"
echo "   Keycloak admin   : http://localhost:8083/admin (admin / admin)"
echo "   MinIO console    : http://localhost:9001 (conversations / password)"
echo "   Maildev          : http://localhost:1081"
echo
echo "Comptes test : voir front-back/docker/auth/realm.json"
echo "  conversations@conversations.world / conversations"
echo
echo "Pour créer un superuser Django :"
echo "  docker compose exec -u root app-dev python manage.py createsuperuser"
