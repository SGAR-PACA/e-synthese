#!/bin/sh
set -eu

# Ce script tourne dans l'image Keycloak, après le démarrage du serveur. Il est
# idempotent afin de corriger aussi un client `mastra-sources` déjà créé à la
# main sur un volume Keycloak existant.

DOMAIN_FRONT=${DOMAIN_FRONT:?DOMAIN_FRONT requis}
CLIENT_ID=${MASTRA_OIDC_CLIENT_ID:-mastra-sources}
CLIENT_SECRET=${MASTRA_OIDC_CLIENT_SECRET:?MASTRA_OIDC_CLIENT_SECRET requis}
REDIRECT_URI=${MASTRA_OIDC_REDIRECT_URI:-https://${DOMAIN_FRONT}/v1/source/callback}
REALM=conversations
KCADM=/opt/keycloak/bin/kcadm.sh
CFG=/tmp/kcadm-mastra-sources.config
ORIGIN=https://${DOMAIN_FRONT}
FRONTCHANNEL_URL=${ORIGIN}/v1/source/frontchannel-logout
# Keycloak et Mastra partagent le réseau Docker `default`. Le back-channel est
# donc privé et ne dépend pas d'un hairpin DNS/Traefik public. Surchageable si
# Keycloak est externalisé.
BACKCHANNEL_URL=${MASTRA_OIDC_BACKCHANNEL_LOGOUT_URL:-http://mastra:4111/v1/source/backchannel-logout}

n=0
until "$KCADM" config credentials --config "$CFG" \
        --server http://keycloak:8080/auth --realm master \
        --user admin --password "$KEYCLOAK_ADMIN_PASSWORD" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -ge 20 ]; then
    echo "Keycloak injoignable."
    exit 1
  fi
  echo "Keycloak pas encore prêt (tentative $n)…"
  sleep 3
done

existing=$("$KCADM" get clients --config "$CFG" -r "$REALM" \
  -q "clientId=$CLIENT_ID" --fields id --format csv --noquotes 2>/dev/null | tr -d '\r' || true)

set_client() {
  "$KCADM" "$1" "${2:-}" --config "$CFG" -r "$REALM" \
    -s "clientId=$CLIENT_ID" \
    -s enabled=true \
    -s protocol=openid-connect \
    -s clientAuthenticatorType=client-secret \
    -s "secret=$CLIENT_SECRET" \
    -s publicClient=false \
    -s bearerOnly=false \
    -s standardFlowEnabled=true \
    -s implicitFlowEnabled=false \
    -s directAccessGrantsEnabled=false \
    -s serviceAccountsEnabled=false \
    -s consentRequired=false \
    -s "redirectUris=[\"$REDIRECT_URI\"]" \
    -s "webOrigins=[\"$ORIGIN\"]" \
    -s frontchannelLogout=false \
    -s "attributes.\"backchannel.logout.url\"=$BACKCHANNEL_URL" \
    -s 'attributes."backchannel.logout.session.required"=true' \
    -s 'attributes."backchannel.logout.revoke.offline.tokens"=true' \
    -s "attributes.\"frontchannel.logout.url\"=$FRONTCHANNEL_URL" \
    -s 'attributes."post.logout.redirect.uris"=+' \
    -s fullScopeAllowed=true
}

if [ -z "$existing" ]; then
  set_client create clients
  echo "Client $CLIENT_ID créé dans le realm $REALM."
else
  set_client update "clients/$existing"
  echo "Client $CLIENT_ID mis à jour dans le realm $REALM."
fi

echo "Client OIDC source prêt (code flow + PKCE, back-channel logout)."
