#!/usr/bin/env bash
set -u

APP_DIR="${TOWER_APP_DIR:-/opt/tower}"
DATA_DIR="${TOWER_DATA_DIR:-/var/lib/tower}"
URL="${TOWER_PUBLIC_URL:-http://127.0.0.1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --url) URL="${2%/}"; shift 2 ;;
    -h|--help)
      echo "Usage: sudo bash scripts/oss/doctor.sh [--app-dir PATH] [--data-dir PATH] [--url URL]"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0
check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '\033[0;32mPASS\033[0m  %s\n' "$label"
    PASS=$((PASS+1))
  else
    printf '\033[0;31mFAIL\033[0m  %s\n' "$label"
    FAIL=$((FAIL+1))
  fi
}

check "Ubuntu supported" bash -c '. /etc/os-release; [[ "$ID" == ubuntu && ("$VERSION_ID" == 22.04 || "$VERSION_ID" == 24.04) ]]'
check "Node.js 22+" node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
check "Tower build exists" test -f "$APP_DIR/dist/backend/packages/backend/index.js"
check "Runtime shared package linked" test -f "$APP_DIR/node_modules/@tower/shared/index.js"
check "Environment file protected" bash -c '[[ -f "$1/tower.env" && "$(stat -c %a "$1/tower.env")" == 600 ]]' _ "$DATA_DIR"
check "Workspace exists" test -d "$DATA_DIR/workspace"
check "PostgreSQL service active" systemctl is-active --quiet postgresql
check "PostgreSQL extensions ready" sudo -u postgres psql -d tower -Atqc "SELECT count(*)=3 FROM pg_extension WHERE extname IN ('uuid-ossp','pg_trgm','vector')"
check "Tower service active" systemctl is-active --quiet tower
check "nginx service active" systemctl is-active --quiet nginx

# Give first boot and migrations a bounded readiness window.
for _ in $(seq 1 30); do
  curl -fsS --max-time 2 "$URL/api/health" >/dev/null 2>&1 && break
  sleep 2
done

health_ok() {
  local body
  body=$(curl -fsS --max-time 10 "$URL/api/health") || return 1
  python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("status") in ("ok","healthy") or d.get("ok") is True' <<<"$body"
}
check "Public health endpoint" health_ok

status_ok() {
  local body
  body=$(curl -fsS --max-time 10 "$URL/api/auth/status") || return 1
  python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("authEnabled") is True and isinstance(d.get("hasUsers"), bool)' <<<"$body"
}
check "First-login endpoint" status_ok

printf '\nDoctor result: %d passed, %d failed\n' "$PASS" "$FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  echo "Inspect: sudo journalctl -u tower -n 100 --no-pager"
  exit 1
fi
