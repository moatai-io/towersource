#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# check-symlinks.sh — Publishing 하이브리드 구조 헬스체크
# version: 2026-04-26  (canonical: tower/templates/workspace/scripts/check-symlinks.sh)
#
# 사용법:
#   bash ~/workspace/scripts/check-symlinks.sh
#   bash ~/workspace/scripts/check-symlinks.sh --json    # 머신 친화적 출력
#   bash ~/workspace/scripts/check-symlinks.sh --fix     # 끊어진 symlink 자동 정리 (확인 후)
#
# 점검 항목:
#   1. published/sites/ 안의 모든 항목을 분류 (실폴더 / 살아있는 symlink / 끊어진 symlink)
#   2. 끊어진 symlink → 어느 project 를 가리키고 있었나 보고
#   3. 실폴더 중 manifest.project 가 있는데 아직 평면인 것 → 마이그레이션 후보 표시
#
# 결정: workspace/decisions/2026-04-26-publishing-storage-restructure.md
# ──────────────────────────────────────────────────────────
set -euo pipefail

WORKSPACE="${WORKSPACE_ROOT:-$HOME/workspace}"
SITES_DIR="$WORKSPACE/published/sites"
MANIFEST="$WORKSPACE/published/manifest.json"

JSON_MODE=false
FIX_MODE=false
for arg in "$@"; do
  case "$arg" in
    --json) JSON_MODE=true ;;
    --fix)  FIX_MODE=true ;;
    *) echo "알 수 없는 옵션: $arg"; exit 1 ;;
  esac
done

if [[ ! -d "$SITES_DIR" ]]; then
  echo "❌ $SITES_DIR 가 없습니다 (이 서버는 publishing 미설정?)"
  exit 1
fi

# ── 분류 ──
declare -a OK_REAL=()       # 평면 실폴더 (project 없음 — OK)
declare -a OK_HYBRID=()     # 살아있는 symlink (하이브리드 — OK)
declare -a BROKEN=()        # 끊어진 symlink — 수동/자동 정리 필요
declare -a CANDIDATES=()    # 평면이지만 manifest 에 project 있음 → 마이그레이션 후보

# Manifest 에서 project 매핑 읽기 (있으면)
get_project_for() {
  local name="$1"
  if [[ -f "$MANIFEST" ]] && command -v python3 >/dev/null 2>&1; then
    python3 -c "
import json, sys
try:
    with open('$MANIFEST') as f: m = json.load(f)
    for s in (m.get('sites') or []) + (m.get('apps') or []):
        if s.get('name') == '$name':
            print(s.get('project') or '', end='')
            sys.exit(0)
except Exception:
    pass
" 2>/dev/null
  fi
}

shopt -s nullglob
for entry in "$SITES_DIR"/*; do
  [[ -e "$entry" || -L "$entry" ]] || continue
  name=$(basename "$entry")
  # robots.txt 같은 단일 파일 무시
  if [[ -f "$entry" && ! -L "$entry" ]]; then
    continue
  fi
  if [[ -L "$entry" ]]; then
    target=$(readlink "$entry")
    if [[ -d "$entry" ]]; then
      # symlink 이고 따라간 곳도 살아 있음
      OK_HYBRID+=("$name → $target")
    else
      # 끊어진 symlink
      BROKEN+=("$name → $target")
    fi
  elif [[ -d "$entry" ]]; then
    # 실폴더
    proj=$(get_project_for "$name")
    if [[ -n "$proj" ]]; then
      CANDIDATES+=("$name (manifest.project=$proj)")
    else
      OK_REAL+=("$name")
    fi
  fi
done
shopt -u nullglob

# ── JSON 출력 모드 ──
if $JSON_MODE; then
  python3 - <<EOF
import json
print(json.dumps({
  "ok_real": $(printf '%s\n' "${OK_REAL[@]:-}" | python3 -c "import sys,json; print(json.dumps([l for l in sys.stdin.read().split('\n') if l.strip()]))"),
  "ok_hybrid": $(printf '%s\n' "${OK_HYBRID[@]:-}" | python3 -c "import sys,json; print(json.dumps([l for l in sys.stdin.read().split('\n') if l.strip()]))"),
  "broken": $(printf '%s\n' "${BROKEN[@]:-}" | python3 -c "import sys,json; print(json.dumps([l for l in sys.stdin.read().split('\n') if l.strip()]))"),
  "candidates": $(printf '%s\n' "${CANDIDATES[@]:-}" | python3 -c "import sys,json; print(json.dumps([l for l in sys.stdin.read().split('\n') if l.strip()]))"),
}, indent=2, ensure_ascii=False))
EOF
  exit 0
fi

# ── 사람용 출력 ──
echo "📊 Publishing 저장 구조 헬스체크"
echo "   sites dir: $SITES_DIR"
echo ""
echo "✅ 살아있는 symlink (하이브리드 — 권장 구조): ${#OK_HYBRID[@]}"
for s in "${OK_HYBRID[@]:-}"; do [[ -n "$s" ]] && echo "   • $s"; done
echo ""
echo "🟢 평면 실폴더 (legacy — 프로젝트 정보 없음): ${#OK_REAL[@]}"
for s in "${OK_REAL[@]:-}"; do [[ -n "$s" ]] && echo "   • $s"; done
echo ""
echo "🟡 마이그레이션 후보 (평면이지만 manifest 에 project 있음): ${#CANDIDATES[@]}"
for s in "${CANDIDATES[@]:-}"; do [[ -n "$s" ]] && echo "   • $s"; done
echo ""
echo "❌ 끊어진 symlink: ${#BROKEN[@]}"
for s in "${BROKEN[@]:-}"; do [[ -n "$s" ]] && echo "   • $s"; done
echo ""

if [[ ${#BROKEN[@]} -gt 0 ]]; then
  if $FIX_MODE; then
    echo "🔧 --fix 모드: 끊어진 symlink 제거 (manifest 는 그대로 — 별도 정리 필요)"
    for s in "${BROKEN[@]}"; do
      name="${s%% → *}"
      rm -f "$SITES_DIR/$name"
      echo "   removed: $name"
    done
  else
    echo "💡 자동 정리하려면: bash $0 --fix"
  fi
fi

# Exit code: 0 if all ok, 1 if broken symlinks present
exit ${#BROKEN[@]}
