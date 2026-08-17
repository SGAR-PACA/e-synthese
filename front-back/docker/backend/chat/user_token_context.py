"""Contexte de requête : token OIDC de l'utilisateur courant (patch E-Synthèse).

Posé par ``AIAgentService`` depuis la session Django (nécessite
``OIDC_STORE_ACCESS_TOKEN=True``) et lu par ``chat.agents.base.prepare_custom_model``
pour le forwarder au backend LLM (Mastra) via l'en-tête ``X-User-Token``.
Objectif : cloisonnement du RAG par groupe Keycloak, sans passer par le proxy
anonyme (clé partagée). Ne fait PAS partie de l'upstream la-suite/conversations.
"""

from contextvars import ContextVar

# ``None`` quand aucun token n'est disponible (ex. génération hors requête).
current_user_token: ContextVar[str | None] = ContextVar(
    "current_user_token", default=None
)
