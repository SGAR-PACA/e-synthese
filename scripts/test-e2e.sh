#!/usr/bin/env bash
# End-to-end tests for E-Synthese Mastra proxy.
# Boots the built server on a temp port with fake keys, hits every critical
# endpoint with curl, checks responses. Exit 0 if all pass, 1 otherwise.
#
# Usage: scripts/test-e2e.sh
#
# Requires: node 20+, curl, npm. No external deps.

set -uo pipefail
cd "$(dirname "$0")/.."

PORT=4333
BASE="http://127.0.0.1:$PORT"
TMP="/tmp/estest-$$"
DB_PATH="$TMP.db"
COOKIE="$TMP.cookie"
LOG="$TMP.log"
BIGFILE="$TMP.big"

PROXY_API_KEY="sk-proxy-$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0

ok()      { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
ko()      { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL+1)); }
section() { echo -e "\n${BOLD}${YELLOW}▸ $1${NC}"; }

assert_eq() {
  local expected=$1
  local actual=$2
  local desc=$3
  if [[ "$actual" == "$expected" ]]; then
    ok "$desc (= $actual)"
  else
    ko "$desc : attendu $expected, reçu $actual"
  fi
}

cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  wait "${SERVER_PID:-}" 2>/dev/null || true
  rm -f "$DB_PATH" "$DB_PATH-shm" "$DB_PATH-wal" "$COOKIE" "$LOG" "$BIGFILE"
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
# Build & boot
# -----------------------------------------------------------------------------
section "Build Mastra"
if ! npm run build >/dev/null 2>&1; then
  echo "   Build failed. Run 'npm run build' for details." >&2
  exit 1
fi
ok "Build OK"

section "Boot server (port $PORT, DB $DB_PATH)"
PORT=$PORT \
DB_PATH="$DB_PATH" \
PUBLIC_DIR="$(pwd)/public" \
PROXY_API_KEY="$PROXY_API_KEY" \
ENCRYPTION_KEY="$ENCRYPTION_KEY" \
ALBERT_API_KEY="dummy-for-tests" \
NODE_ENV=production \
  node .mastra/output/index.mjs > "$LOG" 2>&1 &
SERVER_PID=$!

for i in {1..30}; do
  if curl -s -o /dev/null "$BASE/health" 2>/dev/null; then
    ok "Serveur démarré (pid $SERVER_PID)"
    break
  fi
  sleep 0.3
done

if ! curl -s -o /dev/null "$BASE/health"; then
  ko "Serveur n'a pas démarré dans les 10s"
  echo "--- Logs ---" >&2
  cat "$LOG" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# 1. Infrastructure
# -----------------------------------------------------------------------------
section "1. Infrastructure"
assert_eq 200 "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health")" "/health répond 200"
assert_eq 200 "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/auth-status")" "/admin/auth-status public"

# -----------------------------------------------------------------------------
# 2. Bearer enforcement sur /v1/*
# -----------------------------------------------------------------------------
section "2. Bearer token sur /v1/*"

for endpoint in "/v1/chat/completions:POST" "/v1/search:POST" "/v1/rerank:POST" "/v1/embeddings:POST" "/v1/models:GET"; do
  route="${endpoint%:*}"
  method="${endpoint##*:}"
  status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "$BASE$route" -H 'Content-Type: application/json' -d '{}')
  assert_eq 401 "$status" "$route sans Bearer → 401"

  status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "$BASE$route" \
    -H "Authorization: Bearer sk-proxy-wrong-key" \
    -H 'Content-Type: application/json' -d '{}')
  assert_eq 401 "$status" "$route Bearer invalide → 401"
done

# Bon Bearer : /v1/models doit renvoyer 200 (pas d'appel Albert, route locale)
assert_eq 200 "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/models" -H "Authorization: Bearer $PROXY_API_KEY")" \
  "/v1/models Bearer valide → 200"

# -----------------------------------------------------------------------------
# 3. Admin setup (1er OK, 2e refusé)
# -----------------------------------------------------------------------------
section "3. Admin setup"

# Validation password : mdp faible rejeté AVANT que l'admin soit créé
assert_eq 400 "$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/setup" \
  -H 'Content-Type: application/json' \
  -d '{"email":"x@y.fr","password":"weak"}')" \
  "Setup password < 8 chars refusé (400)"

response=$(curl -s -c "$COOKIE" -X POST "$BASE/admin/setup" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@test.fr","password":"Pass1234"}')

if echo "$response" | grep -q '"ok":true'; then
  ok "1er setup admin accepté"
else
  ko "1er setup refusé: $response"
fi

CSRF=$(echo "$response" | sed -nE 's/.*"csrfToken":"([^"]+)".*/\1/p')
if [[ -n "$CSRF" ]]; then
  ok "CSRF token retourné ($(echo "$CSRF" | cut -c1-10)…)"
else
  ko "Pas de CSRF dans la réponse setup"
fi

assert_eq 403 "$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/setup" \
  -H 'Content-Type: application/json' \
  -d '{"email":"other@test.fr","password":"Pass1234"}')" \
  "2e setup refusé (403)"

# -----------------------------------------------------------------------------
# 4. Admin login / mauvais mdp
# -----------------------------------------------------------------------------
section "4. Login / logout"

assert_eq 401 "$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@test.fr","password":"WrongPass"}')" \
  "Login mauvais mdp → 401"

response=$(curl -s -c "$COOKIE" -X POST "$BASE/admin/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@test.fr","password":"Pass1234"}')
if echo "$response" | grep -q '"ok":true'; then
  ok "Login bon mdp → 200 ok:true"
else
  ko "Login bon mdp a échoué: $response"
fi
CSRF=$(echo "$response" | sed -nE 's/.*"csrfToken":"([^"]+)".*/\1/p')

# /admin/me authentifié → 200
assert_eq 200 "$(curl -s -b "$COOKIE" -o /dev/null -w "%{http_code}" "$BASE/admin/me")" \
  "/admin/me authentifié → 200"

# -----------------------------------------------------------------------------
# 5. Rate limit login
# -----------------------------------------------------------------------------
section "5. Rate limiting login (6 tentatives foirées)"

for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -X POST "$BASE/admin/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"attacker@x.fr","password":"bad"}' >/dev/null
done

assert_eq 429 "$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"attacker@x.fr","password":"bad"}')" \
  "7e tentative depuis même IP → 429"

# -----------------------------------------------------------------------------
# 6. CSRF sur mutations admin
# -----------------------------------------------------------------------------
section "6. CSRF sur mutations"

# /admin/change-password sans header CSRF
assert_eq 403 "$(curl -s -b "$COOKIE" -o /dev/null -w "%{http_code}" -X PUT "$BASE/admin/change-password" \
  -H 'Content-Type: application/json' \
  -d '{"currentPassword":"Pass1234","newPassword":"New12345"}')" \
  "PUT /admin/change-password sans CSRF → 403"

# /v1/collections POST sans CSRF
assert_eq 403 "$(curl -s -b "$COOKIE" -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/collections" \
  -H 'Content-Type: application/json' \
  -d '{"name":"x","description":"y"}')" \
  "POST /v1/collections sans CSRF → 403"

# /v1/documents POST sans CSRF
assert_eq 403 "$(curl -s -b "$COOKIE" -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/documents" \
  -F "collection_id=1" -F "file=@$0")" \
  "POST /v1/documents sans CSRF → 403"

# -----------------------------------------------------------------------------
# 7. Cap upload 10 Mo
# -----------------------------------------------------------------------------
section "7. Limite upload 10 Mo"

dd if=/dev/zero of="$BIGFILE" bs=1m count=13 >/dev/null 2>&1
assert_eq 413 "$(curl -s -b "$COOKIE" -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/documents" \
  -H "X-CSRF-Token: $CSRF" \
  -F "collection_id=1" -F "file=@$BIGFILE")" \
  "Upload 13 Mo rejeté avec 413"

# -----------------------------------------------------------------------------
# 8. Logout et session invalidée
# -----------------------------------------------------------------------------
section "8. Logout invalide la session"

assert_eq 200 "$(curl -s -b "$COOKIE" -c "$COOKIE" -o /dev/null -w "%{http_code}" \
  -X POST "$BASE/admin/logout")" \
  "/admin/logout → 200"

assert_eq 401 "$(curl -s -b "$COOKIE" -o /dev/null -w "%{http_code}" "$BASE/admin/me")" \
  "/admin/me après logout → 401"

# -----------------------------------------------------------------------------
# 9. DB_PATH respecté + encryption
# -----------------------------------------------------------------------------
section "9. Persistance et crypto"

if [[ -f "$DB_PATH" ]]; then
  ok "DB créée au DB_PATH imposé ($DB_PATH)"
else
  ko "DB absente au DB_PATH imposé"
fi

# Vérifie qu'aucune clé "dummy-for-tests" (ALBERT_API_KEY) ne traîne en clair dans data.db
if strings "$DB_PATH" 2>/dev/null | grep -q "dummy-for-tests"; then
  ko "ALBERT_API_KEY présent en clair dans data.db (chiffrement cassé)"
else
  ok "ALBERT_API_KEY absente en clair de data.db (chiffrement OK)"
fi

# -----------------------------------------------------------------------------
# 10. Fichiers statiques admin (Pico local + pages HTML)
# -----------------------------------------------------------------------------
section "10. Statiques admin"

assert_eq 200 "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/pico.min.css")" "/admin/pico.min.css servi"
assert_eq 200 "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/login")" "/admin/login (HTML) servi"
assert_eq 200 "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/app.js")" "/admin/app.js servi"

# Vérifie qu'aucune page ne réfère plus à jsdelivr
if grep -l "jsdelivr" public/admin/*.html >/dev/null 2>&1; then
  ko "Références jsdelivr restantes dans public/admin/*.html"
else
  ok "Plus de CDN externe dans les pages admin"
fi

# -----------------------------------------------------------------------------
# 11. Crypto unit-test inline
# -----------------------------------------------------------------------------
section "11. Crypto round-trip (unit)"

node --input-type=module -e "
import { hashPassword, verifyPassword, encrypt, decrypt } from './src/lib/crypto.ts';
" 2>/dev/null && USE_TSX=0 || USE_TSX=1

CRYPTO_RESULT=$(node --import=tsx --input-type=module -e "
import { hashPassword, verifyPassword, encrypt, decrypt } from './src/lib/crypto.ts';

const { hash, salt } = hashPassword('MySecret123');
console.log('hashVerify:', verifyPassword('MySecret123', hash, salt));
console.log('hashReject:', verifyPassword('wrong', hash, salt));

const key = 'a'.repeat(64);
const { encrypted, iv, tag } = encrypt('hello world', key);
console.log('decryptRoundtrip:', decrypt(encrypted, iv, tag, key));
" 2>&1)

if echo "$CRYPTO_RESULT" | grep -q "hashVerify: true"; then
  ok "hashPassword + verifyPassword aller-retour OK"
else
  ko "Round-trip scrypt cassé"
fi

if echo "$CRYPTO_RESULT" | grep -q "hashReject: false"; then
  ok "verifyPassword rejette mauvais mdp"
else
  ko "verifyPassword ne rejette pas les mauvais mdp"
fi

if echo "$CRYPTO_RESULT" | grep -q "decryptRoundtrip: hello world"; then
  ok "encrypt/decrypt AES-256-GCM aller-retour OK"
else
  ko "Round-trip AES cassé"
fi

# -----------------------------------------------------------------------------
# Récap
# -----------------------------------------------------------------------------
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}✓ Tous les tests passent : $PASS / $((PASS+FAIL))${NC}"
else
  echo -e "${RED}${BOLD}✗ Échecs : $FAIL / $((PASS+FAIL))${NC}"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Non couvert par ce script (nécessite mock Albert) :"
echo "  - Clamp effectif de max_tokens (vérifiable par code review)"
echo "  - Timeout albertFetch 120s (vérifiable par code review)"
echo "  - Réponse RAG bout-en-bout"
echo ""

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
