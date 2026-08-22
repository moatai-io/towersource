#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TOWER_APP_DIR:-/opt/tower}"
DATA_DIR="${TOWER_DATA_DIR:-/var/lib/tower}"
CLOSURE_LINK="${TOWER_NIX_CLOSURE_LINK:-$DATA_DIR/nix/tower-app}"
WORKER_ID="${TOWER_LOCAL_WORKER_ID:-tower-oss-local-01}"
WORKER_PORT="${TOWER_LOCAL_WORKER_PORT:-43325}"
CONTROL_PLANE_URL="${TOWER_LOCAL_WORKER_CONTROL_PLANE_URL:-http://127.0.0.1:32364}"
EXECUTION_USER="${TOWER_EXECUTION_USER:-tower-worker}"
WORKER_DIR="$DATA_DIR/workers/$WORKER_ID"
STATE_FILE="$WORKER_DIR/activated"
REQUEST_FILE="$DATA_DIR/workers/bootstrap.request"

log(){ printf '[tower-oss-worker] %s\n' "$*"; }
fail(){ printf '[tower-oss-worker] ERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail 'run as root'
[[ -x "$CLOSURE_LINK/bin/tower-workbench-worker" ]] || fail "Nix Worker closure missing: $CLOSURE_LINK"
[[ -f "$DATA_DIR/tower.env" ]] || fail "Tower environment missing: $DATA_DIR/tower.env"
[[ -f "$APP_DIR/dist/backend/packages/backend/scripts/bootstrap-system-workbench-worker-credentials.js" ]] || fail 'compiled Worker bootstrap missing'

mkdir -p "$WORKER_DIR" /etc/tower-workers
chmod 700 "$WORKER_DIR"
chown root:"$EXECUTION_USER" /etc/tower-workers
chmod 750 /etc/tower-workers
if [[ -f "$STATE_FILE" ]]; then
  rm -f "$REQUEST_FILE"
  systemctl disable --now tower-oss-worker-bootstrap.timer >/dev/null 2>&1 || true
  exit 0
fi

# App boot creates General before the first administrator. Credentials intentionally
# wait for the first administrator because identity records require an actor user.
read -r PROJECT_ID PROJECT_ROOT ACTOR_USER_ID < <(
  set -a
  # shellcheck disable=SC1090
  source "$DATA_DIR/tower.env"
  set +a
  sudo -u postgres psql -d tower -At -F ' ' -c "
    SELECT p.id,p.root_path,u.id
    FROM projects p CROSS JOIN LATERAL (
      SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1
    ) u
    WHERE p.archived=0 AND (lower(p.name)='general' OR p.root_path LIKE '%/projects/general')
    ORDER BY p.created_at LIMIT 1;
  "
)
[[ -n "${PROJECT_ID:-}" && -n "${PROJECT_ROOT:-}" && -n "${ACTOR_USER_ID:-}" ]] || {
  log 'waiting for first administrator and General project'
  exit 0
}
[[ -d "$PROJECT_ROOT" ]] || fail "General project root missing: $PROJECT_ROOT"

# The dedicated execution user owns only project execution content, never app or DB secrets.
chown -R "$EXECUTION_USER:$EXECUTION_USER" "$PROJECT_ROOT"
chmod 750 "$PROJECT_ROOT"
stage="$(mktemp -d "$WORKER_DIR/stage.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
chmod 700 "$stage"

log 'issuing local Worker identity and transport credential'
set -a
# shellcheck disable=SC1090
source "$DATA_DIR/tower.env"
set +a
TOWER_BOOTSTRAP_WORKER_ID="$WORKER_ID" \
TOWER_BOOTSTRAP_PROJECT_ID="$PROJECT_ID" \
TOWER_BOOTSTRAP_PROJECT_ROOT="$PROJECT_ROOT" \
TOWER_BOOTSTRAP_STAGE_DIR="$stage" \
TOWER_BOOTSTRAP_DEPLOYMENT_ID=production \
TOWER_BOOTSTRAP_WORKER_HOST=127.0.0.1 \
TOWER_BOOTSTRAP_WORKER_PORT="$WORKER_PORT" \
TOWER_BOOTSTRAP_ACTOR_USER_ID="$ACTOR_USER_ID" \
TOWER_BOOTSTRAP_MAX_RUNS=4 \
node "$APP_DIR/dist/backend/packages/backend/scripts/bootstrap-system-workbench-worker-credentials.js"

install -o root -g "$EXECUTION_USER" -m 640 "$stage/$WORKER_ID.json" "/etc/tower-workers/$WORKER_ID.json"
install -o root -g "$EXECUTION_USER" -m 640 "$stage/$WORKER_ID.env" "/etc/tower-workers/$WORKER_ID.env"
install -o root -g "$EXECUTION_USER" -m 640 "$stage/$WORKER_ID.identity.jwt" "/etc/tower-workers/$WORKER_ID.identity.jwt"

log 'installing and starting system Worker units'
TOWER_EXECUTION_USER="$EXECUTION_USER" \
TOWER_EXECUTION_GROUP="$EXECUTION_USER" \
TOWER_LOCAL_WORKER_ID="$WORKER_ID" \
TOWER_LOCAL_WORKER_DEPLOYMENT_ID=production \
TOWER_LOCAL_WORKER_BASE_URL="http://127.0.0.1:$WORKER_PORT" \
TOWER_LOCAL_WORKER_CONTROL_PLANE_URL="$CONTROL_PLANE_URL" \
TOWER_LOCAL_WORKER_PROJECT_IDS="$PROJECT_ID" \
TOWER_LOCAL_WORKER_CONFIG_FILE="/etc/tower-workers/$WORKER_ID.json" \
TOWER_LOCAL_WORKER_ENV_FILE="/etc/tower-workers/$WORKER_ID.env" \
TOWER_LOCAL_WORKER_IDENTITY_FILE="/etc/tower-workers/$WORKER_ID.identity.jwt" \
"$CLOSURE_LINK/bin/install-system-workbench-worker-units"
systemctl restart "tower-workbench-worker-$WORKER_ID.service" "tower-workbench-worker-$WORKER_ID-heartbeat.service"

for _ in $(seq 1 40); do
  curl -fsS --max-time 2 "http://127.0.0.1:$WORKER_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 5 "http://127.0.0.1:$WORKER_PORT/health" >/dev/null || fail 'local Worker health timeout'

transport="$(sed -n 's/^TOWER_REMOTE_WORKER_TOKEN=//p' "/etc/tower-workers/$WORKER_ID.env")"
[[ -n "$transport" ]] || fail 'Worker transport credential is missing'
smoke="$(curl -fsS --max-time 30 -X POST "http://127.0.0.1:$WORKER_PORT/v1/runs" \
  -H "Authorization: Bearer $transport" -H 'Content-Type: application/json' \
  --data "{\"spec\":{\"jobId\":990000001,\"projectId\":\"$PROJECT_ID\",\"command\":\"pwd; printf oss-worker-smoke-ok\",\"timeoutSec\":20,\"environmentKeys\":[],\"artifacts\":[]},\"credentials\":{}}")"
grep -Fq "$PROJECT_ROOT" <<<"$smoke" && grep -Fq 'oss-worker-smoke-ok' <<<"$smoke" \
  || fail 'local Worker direct execution smoke failed'

log 'activating Worker-first binding and materializing project skills'
TOWER_OSS_PROJECT_ID="$PROJECT_ID" TOWER_OSS_WORKER_ID="$WORKER_ID" TOWER_OSS_ACTOR_USER_ID="$ACTOR_USER_ID" \
node "$APP_DIR/dist/backend/packages/backend/scripts/activate-oss-local-worker.js"
node "$APP_DIR/dist/backend/packages/backend/scripts/materialize-managed-skills.js" --project "$PROJECT_ID" --json

printf '%s\n' "$(date -u +%FT%TZ)" > "$STATE_FILE"
chmod 600 "$STATE_FILE"
rm -f "$REQUEST_FILE"
systemctl disable --now tower-oss-worker-bootstrap.timer >/dev/null 2>&1 || true
log 'local Worker and General project are ready'
