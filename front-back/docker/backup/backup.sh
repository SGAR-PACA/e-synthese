#!/usr/bin/env bash
#
# Sauvegarde quotidienne pg_dump → Scaleway Object Storage.
# Boucle infinie : dump → gzip → upload via mc → purge >30 jours → sleep 24h.
# Une erreur sur une base n'interrompt pas les autres.
#
# Variables d'environnement requises (voir front-back/env.d/production/backup
# pour la config publique et .env Dokploy pour les secrets) :
#   BACKUP_S3_ENDPOINT, BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY,
#   BACKUP_S3_BUCKET, BACKUP_RETENTION_DAYS
#   MASTRA_DB_HOST, MASTRA_DB_USER, MASTRA_DB_NAME, MASTRA_DB_PASSWORD
#   CONVERSATIONS_DB_HOST, CONVERSATIONS_DB_USER, CONVERSATIONS_DB_NAME, POSTGRES_PASSWORD
#   KEYCLOAK_DB_HOST, KEYCLOAK_DB_USER, KEYCLOAK_DB_NAME, KC_DB_PASSWORD
#
# Argument optionnel : --once → un seul cycle puis exit (utile pour tests).

set -uo pipefail

log() {
  echo "[$(date -u +%FT%TZ)] $*"
}

err() {
  echo "[$(date -u +%FT%TZ)] ERROR: $*" >&2
}

once=0
[ "${1:-}" = "--once" ] && once=1

# Validation des variables d'env critiques avant de démarrer.
for var in BACKUP_S3_ENDPOINT BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY BACKUP_S3_BUCKET BACKUP_RETENTION_DAYS; do
  if [ -z "${!var:-}" ]; then
    err "$var is required"
    exit 1
  fi
done

# Configuration de l'alias mc vers Scaleway.
log "configuring mc alias scw → $BACKUP_S3_ENDPOINT"
if ! mc alias set scw "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" >/dev/null; then
  err "mc alias set failed — vérifier credentials et endpoint"
  exit 1
fi

dump_one() {
  local label="$1" host="$2" user="$3" db="$4" password="$5"
  local today
  today=$(date -u +%F)
  local out="/tmp/${label}-${today}.sql.gz"

  log "dump $label start (host=$host db=$db)"

  if ! PGPASSWORD="$password" pg_dump -h "$host" -U "$user" -d "$db" --no-owner --no-privileges 2>/tmp/pg_dump.err | gzip > "$out"; then
    err "dump $label failed at pg_dump: $(cat /tmp/pg_dump.err)"
    rm -f "$out"
    return 1
  fi
  rm -f /tmp/pg_dump.err

  local size
  size=$(du -h "$out" | cut -f1)
  log "dump $label dumped ($size)"

  if ! mc cp --quiet "$out" "scw/$BACKUP_S3_BUCKET/$label/" >/dev/null; then
    err "dump $label upload failed"
    rm -f "$out"
    return 1
  fi
  log "dump $label uploaded to scw/$BACKUP_S3_BUCKET/$label/${label}-${today}.sql.gz"

  rm -f "$out"

  # Purge des anciens dumps (>30 jours par défaut).
  if ! mc rm --recursive --force --older-than "${BACKUP_RETENTION_DAYS}d" "scw/$BACKUP_S3_BUCKET/$label/" >/dev/null 2>&1; then
    err "dump $label cleanup of old files failed (non-fatal)"
  fi

  return 0
}

run_cycle() {
  log "===== backup cycle start ====="
  dump_one mastra        "$MASTRA_DB_HOST"        "$MASTRA_DB_USER"        "$MASTRA_DB_NAME"        "$MASTRA_DB_PASSWORD"        || true
  dump_one conversations "$CONVERSATIONS_DB_HOST" "$CONVERSATIONS_DB_USER" "$CONVERSATIONS_DB_NAME" "$POSTGRES_PASSWORD"         || true
  dump_one keycloak      "$KEYCLOAK_DB_HOST"      "$KEYCLOAK_DB_USER"      "$KEYCLOAK_DB_NAME"      "$KC_DB_PASSWORD"            || true
  log "===== backup cycle done ====="
}

if [ "$once" = 1 ]; then
  run_cycle
  exit 0
fi

# Boucle quotidienne. BACKUP_INTERVAL_SECONDS surchargeable pour tests.
interval="${BACKUP_INTERVAL_SECONDS:-86400}"
while true; do
  run_cycle
  log "sleeping ${interval}s before next cycle"
  sleep "$interval"
done
