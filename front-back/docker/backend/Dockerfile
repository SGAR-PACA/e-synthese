# Image dérivée du backend la-suite/conversations — patch E-Synthèse.
#
# But : forwarder le token OIDC de l'utilisateur final au backend LLM (Mastra)
# via l'en-tête `X-User-Token`, afin que Mastra cloisonne le RAG par groupe
# Keycloak. On ne modifie PAS le comportement du chat/persistance : on ajoute
# seulement un header à la requête sortante vers Mastra.
#
# Stratégie : image dérivée + patches surgicaux (pas de fork intégral). Les
# patches ciblent des lignes précises du commit ci-dessous — si tu bumps l'image
# de base, `patch` échouera le build (signal clair pour re-synchroniser).
#
# Base épinglée = commit b8b5630 (résolu depuis le digest).
FROM lasuite/conversations-backend:main@sha256:337516bd02be0e93e5720016bc8c8faab9df263e33931e76d7a015a4e48f2613

USER root:root

# Nouveau module : ContextVar portant le token utilisateur pour la requête.
COPY chat/user_token_context.py /app/chat/user_token_context.py

# Patches (base.py = injection du header ; pydantic_ai.py = pose du ContextVar).
COPY patches/ /tmp/esynthese-patches/
RUN set -eux; \
    apk add --no-cache patch; \
    cd /app; \
    patch -p1 < /tmp/esynthese-patches/base.py.patch; \
    patch -p1 < /tmp/esynthese-patches/pydantic_ai.py.patch; \
    apk del patch; \
    rm -rf /tmp/esynthese-patches; \
    python -c "import ast; \
ast.parse(open('chat/agents/base.py').read()); \
ast.parse(open('chat/clients/pydantic_ai.py').read()); \
ast.parse(open('chat/user_token_context.py').read())"

# Retour à l'utilisateur non-root de l'image de base (uid 1001).
USER 1001
