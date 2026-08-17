#!/bin/bash
# Tower 사용량 추적 — 한 줄 wrapper
#
# 사용법:
#   ./packages/backend/scripts/usage-report.sh
#
# DATABASE_URL 은 .env 에서 자동 로드.
# 모든 self-hosted server 에서 동일하게 작동.
#
# 근거: workspace/decisions/2026-05-14-sdk-credit-economy.md

set -e
cd "$(dirname "$0")/../../.."

if [[ -z "$DATABASE_URL" ]]; then
  if [[ -f .env ]]; then
    set -a
    source .env
    set +a
  fi
fi

if [[ -z "$DATABASE_URL" ]]; then
  echo "ERROR: DATABASE_URL not set" >&2
  exit 1
fi

psql "$DATABASE_URL" -f packages/backend/scripts/usage-report.sql
