#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# deploy.sh — Tower 사이트/앱 배포 스크립트
# version: 2026-04-22  (canonical: tower/templates/workspace/scripts/deploy.sh)
#
# 사용법:
#   bash ~/workspace/scripts/deploy.sh <이름> <소스폴더> [옵션]
#
# 경로 판단 (workspace/decisions/2026-04-19-publishing-path-policy.md):
#   - 단기 (≤30일) / 내부 공유 → --local (빠름, 저렴)
#   - 장기 / 최종 고객 URL 전달 / 외부 공개 → 기본 (Gateway → CF Pages / Azure)
#   - 어느 쪽인지 모호하면 "URL 이 30일 후에도 살아있어야 하나?" 로 자문
#
# 예시:
#   # 정적 사이트 → Cloudflare Pages  (빠름 — 동기 경로)
#   bash ~/workspace/scripts/deploy.sh my-report ./my-report-site/
#
#   # 동적 앱 (Python/Node) → Azure Container Apps  (느림 — 자동 async 경로)
#   bash ~/workspace/scripts/deploy.sh salary-calc ./salary-app/ --type dynamic --port 8000
#
#   # 아무거나 async 강제 (게이트웨이가 느릴 때)
#   bash ~/workspace/scripts/deploy.sh my-site ./site/ --async
#
#   # 로컬 published/sites/에만 배포 (외부 배포 안 함)
#   bash ~/workspace/scripts/deploy.sh my-page ./my-page/ --local
#
# 이 스크립트가 하는 일:
#   1. --local 이면: 소스 → published/sites/<이름>/ 복사 (즉시 URL 접근 가능)
#   2. --local 아니면: 소스 → tar.gz → Gateway API → Cloudflare/Azure 배포
#      - 정적(static) 기본 → 동기 (보통 <60초)
#      - 동적(dynamic) 기본 → async (ACR 빌드 3-8분 → nginx 타임아웃 회피)
#      - --async 명시 → 어떤 타입이든 async
#   3. 두 경로 모두 workspace/published/.publish-log.jsonl 에 한 줄 append
#      (Publishing Hub 의 통합 감사용. DB 없어도 "누가 언제 뭘 올렸나" 조회 가능)
# ──────────────────────────────────────────────────────────
set -euo pipefail

# ── 공통: publish-log append 헬퍼 ──
# 사용: publish_log_append <path> <name> <src> [extra-json-fields...]
# 실패해도 배포 자체는 막지 않음 (non-fatal)
publish_log_append() {
  local _path="$1"; local _name="$2"; local _src="$3"; shift 3
  local _log="${WORKSPACE:-$HOME/workspace}/published/.publish-log.jsonl"
  local _ts; _ts=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S%z)
  local _user="${USER:-$(id -un 2>/dev/null || echo unknown)}"
  local _extra=""
  while [[ $# -gt 0 ]]; do _extra+=",$1"; shift; done
  mkdir -p "$(dirname "$_log")" 2>/dev/null || true
  printf '{"ts":"%s","path":"%s","name":"%s","src":"%s","user":"%s"%s}\n' \
    "$_ts" "$_path" "$_name" "$_src" "$_user" "$_extra" >> "$_log" 2>/dev/null || true
}

# ── 인자 파싱 ──
NAME="${1:-}"
TYPE=""
PORT=""
LOCAL=false
DESCRIPTION=""
ENV_VARS=""
DELETE=false
ASYNC=false
POLL_TIMEOUT_SEC=1800   # 30 minutes — matches gateway cold-start cutoff
POLL_INTERVAL_SEC=10

# 두번째 인자: "--delete" 혹은 다른 플래그면 SOURCE 없음.
# 그 외(일반 문자열)면 SOURCE로 취급.
if [[ "${2:-}" == --* ]]; then
  SOURCE=""
  shift 1 2>/dev/null || true
else
  SOURCE="${2:-}"
  shift 2 2>/dev/null || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)      TYPE="$2"; shift 2 ;;
    --port)      PORT="$2"; shift 2 ;;
    --local)     LOCAL=true; shift ;;
    --desc)      DESCRIPTION="$2"; shift 2 ;;
    --env-vars)  ENV_VARS="$2"; shift 2 ;;
    --delete)    DELETE=true; shift ;;
    --async)     ASYNC=true; shift ;;
    --timeout)   POLL_TIMEOUT_SEC="$2"; shift 2 ;;
    *)           echo "알 수 없는 옵션: $1"; exit 1 ;;
  esac
done

# Dynamic 앱은 기본 async (ACR 빌드가 nginx 타임아웃보다 길어서 동기는 깨짐)
if [[ "$TYPE" == "dynamic" && "$ASYNC" == "false" ]]; then
  ASYNC=true
fi

# ── 이름 검증 (공통) ──
if [[ -z "$NAME" ]]; then
  echo "사용법:"
  echo "  배포:  deploy.sh <이름> <소스폴더> [--local] [--type static|dynamic] [--port 8080] [--env-vars KEY=VAL,KEY2=VAL2]"
  echo "  삭제:  deploy.sh <이름> --delete"
  echo ""
  echo "예시:"
  echo "  deploy.sh my-report ./report/                                       # Gateway 배포"
  echo "  deploy.sh my-api ./api/ --type dynamic --port 8080 \\"
  echo "    --env-vars DATABASE_URL=postgres://...,SECRET_KEY=abc             # 동적 앱 + 시크릿"
  echo "  deploy.sh my-report ./report/ --local                               # 로컬"
  echo "  deploy.sh my-report --delete                                        # Gateway에서 제거"
  exit 1
fi

if [[ ! "$NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "❌ 이름은 소문자 영어 + 숫자 + 하이픈만 가능합니다 (예: my-report)"
  exit 1
fi

# ── 삭제 모드 ──
if $DELETE; then
  ENV_FILE="${HOME}/tower/.env"
  if [[ -f "$ENV_FILE" ]]; then
    # 삭제용 엔드포인트: /api/gateway/publish/<name>
    GATEWAY_BASE=$(grep '^PUBLISH_GATEWAY_URL=' "$ENV_FILE" | cut -d'=' -f2- | sed 's|/publish$||')
    API_KEY=$(grep '^PUBLISH_API_KEY=' "$ENV_FILE" | cut -d'=' -f2-)
  fi
  if [[ -z "${GATEWAY_BASE:-}" || -z "${API_KEY:-}" ]]; then
    echo "❌ Gateway 설정이 없습니다. (PUBLISH_GATEWAY_URL / PUBLISH_API_KEY)"
    exit 1
  fi
  echo "🗑  Gateway에서 삭제 요청: $NAME"
  RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE "$GATEWAY_BASE/publish/$NAME" \
    -H "X-Customer-Key: $API_KEY")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')
  if [[ "$HTTP_CODE" == "200" ]]; then
    echo "✅ 삭제 완료"
    echo "   $BODY"
  else
    echo "❌ 삭제 실패 (HTTP $HTTP_CODE)"
    echo "   $BODY"
    exit 1
  fi
  exit 0
fi

# ── 배포 모드: 소스 필요 ──
if [[ -z "$SOURCE" ]]; then
  echo "❌ 배포에는 소스 폴더가 필요합니다."
  echo "   deploy.sh $NAME <소스폴더> [옵션]"
  exit 1
fi

if [[ ! -d "$SOURCE" ]]; then
  echo "❌ 소스 폴더를 찾을 수 없습니다: $SOURCE"
  exit 1
fi

if [[ ! "$NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "❌ 이름은 소문자 영어 + 숫자 + 하이픈만 가능합니다 (예: my-report)"
  exit 1
fi

WORKSPACE="${WORKSPACE_ROOT:-$HOME/workspace}"
SITES_DIR="$WORKSPACE/published/sites"

# ── 로컬 배포 ──
# 2026-04-26 하이브리드 저장 구조:
#   소스가 workspace/projects/<project>/... 안이면 → 진실의 원천을
#   projects/<project>/published/<name>/ 으로 옮기고 published/sites/<name>은 symlink.
#   소스가 프로젝트 밖(/tmp 등)이면 → 기존 평면 구조 그대로 (legacy).
#   결정 문서: workspace/decisions/2026-04-26-publishing-storage-restructure.md
if $LOCAL; then
  # 소스의 절대 경로에서 project 추출 (workspace/projects/<name>/ 패턴)
  ABS_SOURCE=$(readlink -f "$SOURCE")
  PROJECT=""
  if [[ "$ABS_SOURCE" =~ /workspace/projects/([^/]+) ]]; then
    PROJECT="${BASH_REMATCH[1]}"
  fi

  if [[ -n "$PROJECT" ]]; then
    # 하이브리드: projects/<p>/published/<name>/ 가 진실의 원천
    PROJECT_PUB_DIR="$WORKSPACE/projects/$PROJECT/published/$NAME"
    echo "📁 로컬 배포 (하이브리드): $NAME"
    echo "   소스 → $PROJECT_PUB_DIR"
    echo "   symlink ← $SITES_DIR/$NAME"
    mkdir -p "$PROJECT_PUB_DIR"
    cp -r "$SOURCE"/. "$PROJECT_PUB_DIR/"

    # 기존 평면 폴더가 있으면 안전하게 백업한 뒤 symlink 로 교체
    if [[ -e "$SITES_DIR/$NAME" && ! -L "$SITES_DIR/$NAME" ]]; then
      mv "$SITES_DIR/$NAME" "$SITES_DIR/${NAME}.pre-symlink.$(date +%s).bak"
    fi
    ln -sfn "../../projects/$PROJECT/published/$NAME" "$SITES_DIR/$NAME"
    LOG_PROJECT_FIELD=",\"project\":\"$PROJECT\""
  else
    # 평면 (legacy fallback): 프로젝트 밖에서 온 소스
    echo "📁 로컬 배포 (평면): $NAME → $SITES_DIR/$NAME/"
    mkdir -p "$SITES_DIR/$NAME"
    cp -r "$SOURCE"/. "$SITES_DIR/$NAME/"
    LOG_PROJECT_FIELD=""
  fi

  # 도메인 + role 감지 — 어느 URL 패턴이 실제로 동작하는지 결정
  # full/standalone: wildcard DNS 없음 → /sites/<slug>/ 만 동작
  # managed: wildcard DNS 있음 → <slug>.<domain>/ 동작
  DOMAIN=$(grep -oP 'PUBLIC_URL=https?://\K[^/]+' ~/tower/.env 2>/dev/null || echo "서버도메인")
  TOWER_ROLE_VAL=$(grep -oP '^TOWER_ROLE=\K\S+' ~/tower/.env 2>/dev/null || echo "standalone")

  if [[ "$TOWER_ROLE_VAL" == "managed" ]]; then
    PRIMARY_URL="https://$NAME.$DOMAIN/"
  else
    PRIMARY_URL="https://$DOMAIN/sites/$NAME/"
  fi

  # 통합 감사 로그 (publish_log 결정 문서 §3 Phase 1)
  publish_log_append "local" "$NAME" "$SOURCE" \
    "\"url\":\"$PRIMARY_URL\"" \
    "\"desc\":\"${DESCRIPTION//\"/\\\"}\"${LOG_PROJECT_FIELD}"

  echo ""
  echo "✅ 배포 완료!"
  echo "   📍 $PRIMARY_URL"
  echo "   🛰  TOWER_ROLE=$TOWER_ROLE_VAL"
  [[ -n "$PROJECT" ]] && echo "   🏷  project: $PROJECT"
  exit 0
fi

# ── Gateway 배포 ──

# .env에서 설정 읽기
ENV_FILE="${HOME}/tower/.env"
if [[ -f "$ENV_FILE" ]]; then
  GATEWAY_URL=$(grep '^PUBLISH_GATEWAY_URL=' "$ENV_FILE" | cut -d'=' -f2-)
  API_KEY=$(grep '^PUBLISH_API_KEY=' "$ENV_FILE" | cut -d'=' -f2-)
fi

if [[ -z "${GATEWAY_URL:-}" || -z "${API_KEY:-}" ]]; then
  echo "❌ Gateway 설정이 없습니다."
  echo "   ~/tower/.env에 다음을 추가하세요:"
  echo "   PUBLISH_GATEWAY_URL=https://tower.tower.example.com/api/gateway/publish"
  echo "   PUBLISH_API_KEY=<발급받은 키>"
  echo ""
  echo "💡 로컬 배포를 원하면: deploy.sh $NAME $SOURCE --local"
  exit 1
fi

# tar.gz 생성
TMPDIR=$(mktemp -d)
TAR_FILE="$TMPDIR/source.tar.gz"

echo "📦 패키징: $SOURCE → tar.gz..."
tar -czf "$TAR_FILE" -C "$SOURCE" .
TAR_SIZE=$(du -h "$TAR_FILE" | cut -f1)
echo "   크기: $TAR_SIZE"

# Gateway로 전송
if $ASYNC; then
  POST_URL="${GATEWAY_URL}?async=true"
  echo "🚀 Gateway로 전송 중 (async): $POST_URL"
else
  POST_URL="$GATEWAY_URL"
  echo "🚀 Gateway로 전송 중: $POST_URL"
fi

CURL_ARGS=(
  -s -w "\n%{http_code}"
  -X POST "$POST_URL"
  -H "X-Customer-Key: $API_KEY"
  -F "name=$NAME"
  -F "file=@$TAR_FILE;type=application/gzip"
)

[[ -n "$TYPE" ]] && CURL_ARGS+=(-F "type=$TYPE")
[[ -n "$PORT" ]] && CURL_ARGS+=(-F "port=$PORT")
[[ -n "$DESCRIPTION" ]] && CURL_ARGS+=(-F "description=$DESCRIPTION")
[[ -n "$ENV_VARS" ]] && CURL_ARGS+=(-F "env_vars=$ENV_VARS")

RESPONSE=$(curl "${CURL_ARGS[@]}")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

# 업로드 tmp는 이미 받았으니 정리 (양쪽 경로 공통)
rm -rf "$TMPDIR"

# ──────── Async 경로: 202 받고 폴링 ────────
if $ASYNC; then
  if [[ "$HTTP_CODE" != "202" ]]; then
    echo ""
    echo "❌ async 제출 실패 (HTTP $HTTP_CODE)"
    echo "   $BODY"
    exit 1
  fi

  DEPLOY_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('deploy_id',''))" 2>/dev/null || echo "")
  if [[ -z "$DEPLOY_ID" ]]; then
    echo "❌ 응답에서 deploy_id를 찾을 수 없습니다."
    echo "   $BODY"
    exit 1
  fi

  GATEWAY_BASE="${GATEWAY_URL%/publish}"
  STATUS_URL="$GATEWAY_BASE/publish/status/$DEPLOY_ID"

  echo "   🪪 deploy_id: $DEPLOY_ID"
  echo "   ⏱  상태 폴링: ${POLL_INTERVAL_SEC}s 간격 (최대 $((POLL_TIMEOUT_SEC / 60))분)"
  echo ""

  START_TS=$(date +%s)
  LAST_PHASE=""
  while :; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - START_TS))
    if (( ELAPSED > POLL_TIMEOUT_SEC )); then
      echo ""
      echo "⏰ 폴링 타임아웃 — gateway는 계속 진행 중일 수 있습니다."
      echo "   상태 재확인: curl -H \"X-Customer-Key: \$API_KEY\" $STATUS_URL"
      exit 2
    fi

    STATUS_RESP=$(curl -s -w "\n%{http_code}" "$STATUS_URL" -H "X-Customer-Key: $API_KEY")
    STATUS_CODE=$(echo "$STATUS_RESP" | tail -1)
    STATUS_BODY=$(echo "$STATUS_RESP" | sed '$d')

    if [[ "$STATUS_CODE" != "200" ]]; then
      echo "⚠️  상태 조회 실패 (HTTP $STATUS_CODE) — 다시 시도"
      echo "   $STATUS_BODY"
      sleep "$POLL_INTERVAL_SEC"
      continue
    fi

    STATUS=$(echo "$STATUS_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
    PHASE=$(echo "$STATUS_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('phase','') or '')" 2>/dev/null || echo "")

    # 진행 단계가 바뀌면 한 줄 출력 (동일 상태는 조용히)
    if [[ "$PHASE" != "$LAST_PHASE" ]]; then
      TS_PRETTY=$(printf "%02d:%02d" $((ELAPSED/60)) $((ELAPSED%60)))
      case "$PHASE" in
        extracting) ICON="📦" ;;
        building)   ICON="🔨" ;;
        deploying)  ICON="🚀" ;;
        finalizing) ICON="🧹" ;;
        *)          ICON="⏳" ;;
      esac
      echo "   [$TS_PRETTY] $ICON $PHASE"
      LAST_PHASE="$PHASE"
    fi

    case "$STATUS" in
      success)
        URL=$(echo "$STATUS_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('url','') or '')" 2>/dev/null || echo "")
        TARGET=$(echo "$STATUS_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('target','') or '')" 2>/dev/null || echo "")
        DURATION=$(echo "$STATUS_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('duration_ms','') or '')" 2>/dev/null || echo "")

        publish_log_append "gateway" "$NAME" "$SOURCE" \
          "\"url\":\"${URL//\"/\\\"}\"" \
          "\"target\":\"${TARGET//\"/\\\"}\"" \
          "\"mode\":\"async\"" \
          "\"deploy_id\":\"$DEPLOY_ID\"" \
          "\"desc\":\"${DESCRIPTION//\"/\\\"}\""

        echo ""
        echo "✅ 배포 성공! (총 ${ELAPSED}초)"
        [[ -n "$URL" ]] && echo "   📍 $URL"
        [[ -n "$TARGET" ]] && echo "   🎯 배포 대상: $TARGET"
        [[ -n "$DURATION" ]] && echo "   ⏱  서버 측 소요: $((DURATION / 1000))초"
        exit 0
        ;;
      failed)
        ERR=$(echo "$STATUS_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','') or '')" 2>/dev/null || echo "")
        echo ""
        echo "❌ 배포 실패"
        echo "   $ERR"
        exit 1
        ;;
      queued|running|'')
        sleep "$POLL_INTERVAL_SEC"
        ;;
      *)
        echo "⚠️  알 수 없는 status: $STATUS — 계속 폴링"
        sleep "$POLL_INTERVAL_SEC"
        ;;
    esac
  done
fi

# ──────── Sync 경로 (기존 동작) ────────
if [[ "$HTTP_CODE" == "200" ]]; then
  URL=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('url',''))" 2>/dev/null || echo "")
  TARGET=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('target',''))" 2>/dev/null || echo "")

  # 통합 감사 로그 (publish_log 결정 문서 §3 Phase 1)
  publish_log_append "gateway" "$NAME" "$SOURCE" \
    "\"url\":\"${URL//\"/\\\"}\"" \
    "\"target\":\"${TARGET//\"/\\\"}\"" \
    "\"desc\":\"${DESCRIPTION//\"/\\\"}\""

  echo ""
  echo "✅ 배포 성공!"
  [[ -n "$URL" ]] && echo "   📍 $URL"
  [[ -n "$TARGET" ]] && echo "   🎯 배포 대상: $TARGET"
  echo ""
  echo "   전체 응답: $BODY"
else
  echo ""
  echo "❌ 배포 실패 (HTTP $HTTP_CODE)"
  echo "   $BODY"
  exit 1
fi
