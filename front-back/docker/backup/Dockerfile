# Sauvegarde quotidienne des 3 bases Postgres vers Scaleway Object Storage.
# Multi-stage : on récupère le binaire mc depuis l'image officielle MinIO,
# puis on l'ajoute à une image postgres-alpine qui contient pg_dump.

FROM minio/mc:latest AS mc

FROM postgres:17.5-alpine

# bash : requis par backup.sh (set -uo pipefail, ${!var:-}, etc.).
RUN apk add --no-cache bash

# Récupère mc (single static binary) depuis l'image MinIO officielle.
COPY --from=mc /usr/bin/mc /usr/local/bin/mc

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

ENTRYPOINT ["/usr/local/bin/backup.sh"]
