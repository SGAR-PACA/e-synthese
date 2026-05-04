"""
Local-dev settings override for running the upstream image on plain HTTP.

The upstream `Production` class assumes the app sits behind an HTTPS reverse
proxy. Running it on `http://localhost` breaks because:
  - SECURE_SSL_REDIRECT=True forces a 301 to https://
  - CSRF_COOKIE_SECURE / SESSION_COOKIE_SECURE=True make cookies non-functional
    over HTTP (browser won't send them back)

This subclass relaxes exactly those three flags and nothing else.
"""

from conversations.settings import *  # noqa: F401,F403
from conversations.settings import Production


class LocalDev(Production):
    SECURE_SSL_REDIRECT = False
    CSRF_COOKIE_SECURE = False
    SESSION_COOKIE_SECURE = False
    SECURE_HSTS_SECONDS = 0
