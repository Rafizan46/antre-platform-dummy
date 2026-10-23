#!/usr/bin/env bash
# Runs the k6 load test inside Docker (no local k6) on the compose network of the prod-like stack.
#   bash load/run.sh [env-file]     with PROFILE=smoke|quiet|normal|peak and SCENARIOS=mixed,login,holds,sse,webhook
# Environment: COMPOSE_PROJECT_NAME (default antre-prod) picks the compose project whose `edge`
# network k6 joins; K6_EXTRA passes more k6 flags (for example "--summary-export=/work/out.json").
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${1:-.env.prod}"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
PROJECT="${COMPOSE_PROJECT_NAME:-antre-prod}"
export MSYS_NO_PATHCONV=1 # Git Bash on Windows must not rewrite the container paths below
# shellcheck disable=SC2086
docker run --rm --network "${PROJECT}_edge" \
  -v "$PWD/load:/work" -w /work \
  -e BASE_URL=http://gateway:8000 \
  -e CORE_URL=http://core-services:3000 \
  -e WA_CHANNEL_SERVICE_TOKEN -e PAYMENT_CALLBACK_SECRET -e WA_APP_SECRET \
  -e PROFILE="${PROFILE:-smoke}" -e SCENARIOS="${SCENARIOS:-mixed,login,holds,sse,webhook}" \
  grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34 \
  run ${K6_EXTRA:-} antre.js
