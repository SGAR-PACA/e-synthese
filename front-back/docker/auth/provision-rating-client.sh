#!/usr/bin/env bash
set -euo pipefail

# Provisionne le client public Keycloak `mastra-rating-spa` (notation) dans le
# realm `conversations` d'une instance DÉJÀ initialisée.
#
# Pourquoi : l'import du realm (realm.prod.json.tpl, qui contient déjà ce client)
# n'a lieu qu'au TOUT PREMIER boot de Keycloak. Sur un volume keycloak_data
# existant, il faut donc créer le client à la main — c'est ce que fait ce script.
# Idempotent : relançable sans risque.
#
# Usage (sur l'hôte Docker, ex. le serveur Dokploy) :
#   DOMAIN_FRONT=mon.domaine.fr KEYCLOAK_ADMIN_PASSWORD=*** \
#     ./front-back/docker/auth/provision-rating-client.sh
#
# Variables :
#   DOMAIN_FRONT             domaine unique (front + Keycloak sous /auth) — REQUIS
#   KEYCLOAK_ADMIN_PASSWORD  mot de passe admin Keycloak (realm master) — REQUIS
#   KC_CONTAINER             nom du conteneur Keycloak (auto-détecté sinon)

DOMAIN_FRONT=${DOMAIN_FRONT:?DOMAIN_FRONT requis}
ADMIN_PASS=${KEYCLOAK_ADMIN_PASSWORD:?KEYCLOAK_ADMIN_PASSWORD requis}
KC=${KC_CONTAINER:-$(docker ps --format '{{.Names}}' | grep -m1 keycloak || true)}
REALM=conversations
CID=mastra-rating-spa
CFG=/tmp/kcadm-rating.config
KCADM=/opt/keycloak/bin/kcadm.sh

[ -n "$KC" ] || { echo "✗ Conteneur Keycloak introuvable (définir KC_CONTAINER)."; exit 1; }
echo "→ Conteneur Keycloak : $KC"

kc() { docker exec -i "$KC" "$KCADM" "$@" --config "$CFG"; }

echo "→ Authentification admin…"
kc config credentials --server http://localhost:8080/auth --realm master \
  --user admin --password "$ADMIN_PASS"

echo "→ Création du client (si absent)…"
EXISTING=$(kc get clients -r "$REALM" -q clientId="$CID" --fields id --format csv --noquotes 2>/dev/null | tr -d '\r' || true)
if [ -z "$EXISTING" ]; then
  kc create clients -r "$REALM" \
    -s clientId="$CID" -s enabled=true -s protocol=openid-connect \
    -s publicClient=true -s standardFlowEnabled=true \
    -s implicitFlowEnabled=false -s directAccessGrantsEnabled=false \
    -s "redirectUris=[\"https://$DOMAIN_FRONT/*\"]" \
    -s "webOrigins=[\"https://$DOMAIN_FRONT\"]" \
    -s 'attributes."pkce.code.challenge.method"=S256'
  echo "  ✓ client créé."
else
  echo "  ✓ client déjà présent ($EXISTING)."
fi

ID=$(kc get clients -r "$REALM" -q clientId="$CID" --fields id --format csv --noquotes | tr -d '\r')

echo "→ Mapper d'audience (aud=$CID)…"
HAS_MAPPER=$(kc get "clients/$ID/protocol-mappers/models" -r "$REALM" --fields name --format csv --noquotes 2>/dev/null | grep -c audience-mastra-rating || true)
if [ "${HAS_MAPPER:-0}" = "0" ]; then
  kc create "clients/$ID/protocol-mappers/models" -r "$REALM" \
    -s name=audience-mastra-rating -s protocol=openid-connect \
    -s protocolMapper=oidc-audience-mapper \
    -s 'config."included.client.audience"='"$CID" \
    -s 'config."access.token.claim"=true' \
    -s 'config."id.token.claim"=false'
  echo "  ✓ mapper créé."
else
  echo "  ✓ mapper déjà présent."
fi

echo "✅ Client $CID prêt dans le realm $REALM."
