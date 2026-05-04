#!/usr/bin/env bash
# Régénère la PROXY_API_KEY et resynchronise .env + llm.json.
# Utile pour tester la rotation, ou en cas de fuite de la clé en dev.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "❌ .env introuvable — lance d'abord ./scripts/bootstrap.sh"
  exit 1
fi

NEW_KEY="sk-proxy-$(openssl rand -hex 24)"

# Met à jour .env
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s|^PROXY_API_KEY=.*|PROXY_API_KEY=$NEW_KEY|g" .env
else
  sed -i "s|^PROXY_API_KEY=.*|PROXY_API_KEY=$NEW_KEY|g" .env
fi

# Régénère llm.json depuis le template
cp front-back/docker/patches/llm.json.tpl front-back/docker/patches/llm.json
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s|\${PROXY_API_KEY}|$NEW_KEY|g" front-back/docker/patches/llm.json
else
  sed -i "s|\${PROXY_API_KEY}|$NEW_KEY|g" front-back/docker/patches/llm.json
fi

echo "✅ PROXY_API_KEY régénérée"
echo "   Nouvelle valeur : $NEW_KEY"
echo
echo "Redémarre les services pour appliquer :"
echo "  docker compose restart mastra app-dev"
