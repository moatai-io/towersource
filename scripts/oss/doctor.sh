#!/usr/bin/env bash
set -u

APP_DIR="${TOWER_APP_DIR:-/opt/tower}"
DATA_DIR="${TOWER_DATA_DIR:-/var/lib/tower}"
URL="${TOWER_PUBLIC_URL:-http://127.0.0.1}"
CLOSURE_LINK="${TOWER_NIX_CLOSURE_LINK:-$DATA_DIR/nix/tower-app}"
WORKER_ID="${TOWER_LOCAL_WORKER_ID:-tower-oss-local-01}"

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
check "Nix package manager installed" bash -c 'command -v nix >/dev/null || [[ -x /nix/var/nix/profiles/default/bin/nix ]]'
check "Tower Nix closure linked" test -x "$CLOSURE_LINK/bin/tower-workbench-worker"
check "Compute baseline ready" "$CLOSURE_LINK/bin/runtime-compute-doctor"
check "Tower build exists" test -f "$APP_DIR/dist/backend/packages/backend/index.js"
check "Runtime shared package linked" test -f "$APP_DIR/node_modules/@tower/shared/index.js"
check "Environment file protected" bash -c '[[ -f "$1/tower.env" && "$(stat -c %a "$1/tower.env")" == 600 ]]' _ "$DATA_DIR"
check "Workspace exists" test -d "$DATA_DIR/workspace"
check "Managed skill source seeded" bash -c '[[ -s "$1/workspace/projects/teamskills/skillset.json" && -f "$1/workspace/projects/teamskills/skills/tower-intro/SKILL.md" ]]' _ "$DATA_DIR"
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

release_identity_ok() {
  local manifest="$CLOSURE_LINK/share/tower/release-manifest.json"
  local release_env="$DATA_DIR/release.env"
  local body
  [[ -s "$manifest" && -s "$release_env" ]] || return 1
  body=$(curl -fsS --max-time 10 "$URL/api/health") || return 1
  python3 - "$manifest" "$release_env" "$body" <<'PY'
import json
import pathlib
import sys

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
env = {}
for line in pathlib.Path(sys.argv[2]).read_text(encoding='utf-8').splitlines():
    if line and not line.startswith('#'):
        name, value = line.split('=', 1)
        env[name] = value
health = json.loads(sys.argv[3])
assert health.get('version') == manifest.get('version'), (health, manifest)
assert health.get('baseVersion') == manifest.get('baseVersion'), (health, manifest)
assert health.get('sourceRev') == env.get('SOURCE_REV'), (health, env)
assert health.get('gitSha') == env.get('GIT_SHA'), (health, env)
assert health.get('metadataSource') == 'injected', health
PY
}
check "Release identity matches Nix manifest" release_identity_ok

status_ok() {
  local body
  body=$(curl -fsS --max-time 10 "$URL/api/auth/status") || return 1
  python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("authEnabled") is True and isinstance(d.get("hasUsers"), bool)' <<<"$body"
}
check "First-login endpoint" status_ok

has_users=$(curl -fsS --max-time 10 "$URL/api/auth/status" 2>/dev/null | python3 -c 'import json,sys; print("true" if json.load(sys.stdin).get("hasUsers") else "false")' 2>/dev/null || echo unknown)
if [[ "$has_users" == "true" ]]; then
  check "OSS Worker bootstrap completed" test -s "$DATA_DIR/workers/$WORKER_ID/activated"
  check "Local Worker service active" systemctl is-active --quiet "tower-workbench-worker-$WORKER_ID.service"
  check "Local Worker heartbeat active" systemctl is-active --quiet "tower-workbench-worker-$WORKER_ID-heartbeat.service"
  check "General skills materialized" bash -c 'manifest=$(find "$1/workspace/projects/general" -path "*/.tower/skills/manifest.json" -print -quit); [[ -n "$manifest" ]] && python3 -c '\''import json,sys; d=json.load(open(sys.argv[1])); assert len(d.get("skills", [])) > 0'\'' "$manifest"' _ "$DATA_DIR"
else
  check "Post-setup Worker bootstrap timer enabled" systemctl is-enabled --quiet tower-oss-worker-bootstrap.timer
  check "Post-setup Worker bootstrap timer active" systemctl is-active --quiet tower-oss-worker-bootstrap.timer
  check "Post-setup Worker bootstrap path active" systemctl is-active --quiet tower-oss-worker-bootstrap.path
fi

printf '\nDoctor result: %d passed, %d failed\n' "$PASS" "$FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  echo "Inspect: sudo journalctl -u tower -n 100 --no-pager"
  exit 1
fi
