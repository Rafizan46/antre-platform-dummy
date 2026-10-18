#!/usr/bin/env bash
# Smoke test of the prod-like stack through the Traefik gateway (docker-compose.prod.yml).
#   docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --wait
#   bash infra/docker/smoke-prod.sh [env-file]          (default: .env.prod)
# Needs curl, node, and openssl on the host. Creates a throwaway tenant (random slug) per run.
# Exit code 0 only when every check passed. The login rate-limit check sends 25 failed logins and
# therefore runs last (the gateway then answers 429 to this IP for about a minute).
set -uo pipefail

ENV_FILE="${1:-.env.prod}"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

BASE="http://127.0.0.1:${GATEWAY_HTTP_PORT:-18080}"
TLS_BASE="https://127.0.0.1:${GATEWAY_HTTPS_PORT:-18443}"
JSON='content-type: application/json'
SUFFIX="$(openssl rand -hex 3)"
SLUG="smoke-${SUFFIX}"
EMAIL="owner-${SUFFIX}@smoke.test"
PASSWORD="Sup3rSecret-${SUFFIX}"
PHONE="62813555${RANDOM}0"
FAILED=0
SSE_FILE="$(mktemp)"

check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (expected $2, got $3)"; FAILED=1; fi
}
contains() { # contains <description> <needle> <haystack>
  if [[ "$3" == *"$2"* ]]; then echo "PASS  $1"; else echo "FAIL  $1 (missing: $2)"; FAILED=1; fi
}
field() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== auth and catalog"
REGISTER=$(curl -s -X POST "$BASE/api/v1/auth/register" -H "$JSON" -d "{\"tenant\":{\"name\":\"Smoke $SUFFIX\",\"slug\":\"$SLUG\",\"business_type\":\"CLINIC\",\"admin_wa_phone\":\"6281234567890\"},\"location\":{\"name\":\"Pusat\",\"code\":\"pusat\"},\"owner\":{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}}")
LOCATION_ID=$(echo "$REGISTER" | field '.location.id')
contains "register" '"role":"OWNER"' "$REGISTER"
TOKEN=$(curl -s -X POST "$BASE/api/v1/auth/login" -H "$JSON" -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | field '.access_token')
AUTH="authorization: Bearer $TOKEN"
check "login returns a token" "3" "$(echo "$TOKEN" | awk -F. '{print NF}')"
SERVICE_ID=$(curl -s -X POST "$BASE/api/v1/catalog/services" -H "$JSON" -H "$AUTH" -d '{"name":"Konsultasi","ticket_prefix":"A","avg_duration_min":15}' | field '.id')
HOURS=$(node -pe 'JSON.stringify({slot_interval_min:30,days:[0,1,2,3,4,5,6].map((d)=>({day_of_week:d,open_time:"00:00",close_time:"23:30",break_start:null,break_end:null}))})')
check "operating hours" "200" "$(status -X PUT "$BASE/api/v1/catalog/locations/$LOCATION_ID/operating-hours" -H "$JSON" -H "$AUTH" -d "$HOURS")"
check "resource" "201" "$(status -X POST "$BASE/api/v1/catalog/resources" -H "$JSON" -H "$AUTH" -d "{\"location_id\":\"$LOCATION_ID\",\"name\":\"Dokter 1\",\"service_ids\":[\"$SERVICE_ID\"]}")"

echo "== gateway exposure"
for path in /internal/v1/locations/resolve /internal/v1/queues/tickets /healthz /readyz /metrics /api/v1/unknown; do
  check "GET $path is 404 at the gateway" "404" "$(status -H "authorization: Bearer $WA_CHANNEL_SERVICE_TOKEN" "$BASE$path")"
done
check "HTTPS answers (self-signed)" "200" "$(status -k "$TLS_BASE/")"

echo "== realtime SSE + WhatsApp webhook"
curl -sN --max-time 25 "$BASE/api/v1/realtime/locations/$LOCATION_ID/stream?access_token=$TOKEN" >"$SSE_FILE" 2>&1 &
SSE_PID=$!
sleep 2
sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$WA_APP_SECRET" | sed 's/^.* //'; }
webhook() { # webhook <text>
  local body
  body=$(node -pe 'const [from,text]=process.argv.slice(1);JSON.stringify({object:"whatsapp_business_account",entry:[{id:"W",changes:[{field:"messages",value:{messaging_product:"whatsapp",metadata:{display_phone_number:"628100000000",phone_number_id:"1234567890"},contacts:[{wa_id:from,profile:{name:"Budi"}}],messages:[{from,id:"wamid.S"+Math.random().toString(36).slice(2),timestamp:"1792378800",type:"text",text:{body:text}}]}}]}]})' "$PHONE" "$1")
  status -X POST "$BASE/api/v1/channels/wa/webhook" -H "$JSON" -H "x-hub-signature-256: sha256=$(sign "$body")" -d "$body"
}
check "webhook verification handshake" "12345" "$(curl -s "$BASE/api/v1/channels/wa/webhook?hub.mode=subscribe&hub.verify_token=$WA_VERIFY_TOKEN&hub.challenge=12345")"
check "webhook with a bad signature" "401" "$(status -X POST "$BASE/api/v1/channels/wa/webhook" -H "$JSON" -H 'x-hub-signature-256: sha256=00' -d '{}')"
check "webhook keyword (signed)" "200" "$(webhook "ANTRE $SLUG pusat")"
sleep 2
check "webhook menu: Ambil Antrean" "200" "$(webhook 1)"
sleep 2
check "webhook service choice" "200" "$(webhook 1)"
sleep 4
WORKER_LOG=$(docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml logs --no-log-prefix notification-worker 2>&1)
contains "sandbox message: ticket created" "Nomor antrean Anda: *A-001*" "$WORKER_LOG"
wait "$SSE_PID" 2>/dev/null
SSE_OUT=$(cat "$SSE_FILE")
contains "SSE snapshot through the gateway" "event: snapshot" "$SSE_OUT"
contains "SSE ticket event through the gateway" "queue.ticket.created" "$SSE_OUT"
rm -f "$SSE_FILE"

echo "== static pages"
for path in / /kiosk.html; do
  check "GET $path" "200" "$(status "$BASE$path")"
done
contains "CSP header on the web app" "Content-Security-Policy" "$(curl -sI "$BASE/")"

echo "== rate limit (login)"
CODES=""
for i in $(seq 1 25); do
  CODES="$CODES $(status -X POST "$BASE/api/v1/auth/login" -H "$JSON" -d "{\"email\":\"nobody$i@smoke.test\",\"password\":\"wrongwrong1\"}")"
done
contains "gateway answers 429 after the burst" "429" "$CODES"

[ "$FAILED" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit "$FAILED"
