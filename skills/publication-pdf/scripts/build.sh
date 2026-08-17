#!/usr/bin/env bash
# Build publication-grade PDF artifacts from normalized Markdown inside Runtime Box.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: build.sh <input.md> <output.pdf> [work-dir]

Creates:
  <work-dir>/publication.md
  <work-dir>/publication.typ
  <work-dir>/assets/*
  <work-dir>/verification/{pdfinfo,pdffonts,pdftotext}.txt
  <output.pdf>
EOF
  exit 2
}

[[ $# -ge 2 && $# -le 3 ]] || usage

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INPUT="$(realpath "$1")"
OUTPUT="$(realpath -m "$2")"
WORK="$(realpath -m "${3:-$(dirname "$OUTPUT")/$(basename "${OUTPUT%.*}")-work}")"
TEMPLATE="$SKILL_DIR/templates/tower-report.typ"
FILTER="$SKILL_DIR/scripts/mermaid-filter.lua"
MERMAID_CONFIG="$SKILL_DIR/templates/mermaid-config.json"

[[ -f "$INPUT" ]] || { echo "Input Markdown not found: $INPUT" >&2; exit 2; }
for cmd in pandoc typst pdfinfo pdffonts pdftotext; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Required command missing: $cmd" >&2; exit 2; }
done

TYPST_VERSION="$(typst --version | awk '{print $2}')"
PANDOC_VERSION="$(pandoc --version | head -1 | awk '{print $2}')"
[[ "$TYPST_VERSION" == "0.15.0" ]] || { echo "Expected Typst 0.15.0, got $TYPST_VERSION" >&2; exit 2; }
[[ "$PANDOC_VERSION" == "3.10" ]] || { echo "Expected Pandoc 3.10, got $PANDOC_VERSION" >&2; exit 2; }

mkdir -p "$WORK/assets" "$WORK/verification" "$(dirname "$OUTPUT")"
cp "$INPUT" "$WORK/publication.md"

CHROMIUM="${PUPPETEER_EXECUTABLE_PATH:-}"
if [[ -z "$CHROMIUM" ]]; then
  CHROMIUM="$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)"
fi
if grep -Eq '^```\{?\.mermaid|^```mermaid' "$INPUT"; then
  command -v mmdc >/dev/null 2>&1 || { echo "Mermaid input found but mmdc is missing" >&2; exit 2; }
  [[ -n "$CHROMIUM" ]] || { echo "Mermaid input found but Chromium is missing" >&2; exit 2; }
fi

TMP_ROOT="$(mktemp -d /tmp/tower-publication-pdf.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
export TOWER_TYPST_ASSET_DIR="$WORK/assets"
export TOWER_MMDC="$(command -v mmdc || true)"
export TOWER_TYPST_ROOT="$WORK"
export TOWER_TYPST_DOCUMENT_ASSET_PREFIX="assets"
export TOWER_MERMAID_CONFIG="$MERMAID_CONFIG"
export PUPPETEER_EXECUTABLE_PATH="$CHROMIUM"
export TOWER_CHROME_TMP="$TMP_ROOT/chromium"
export TOWER_PUPPETEER_CONFIG="$TMP_ROOT/puppeteer.json"
export TMPDIR="$TMP_ROOT"
mkdir -p "$TOWER_CHROME_TMP"
if [[ -n "$CHROMIUM" ]]; then
  printf '{"executablePath":"%s","args":["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"]}\n' "$CHROMIUM" > "$TOWER_PUPPETEER_CONFIG"
fi

pandoc "$WORK/publication.md" \
  --from 'markdown+yaml_metadata_block+pipe_tables+table_captions+tex_math_dollars+fenced_code_attributes+footnotes' \
  --to typst \
  --standalone \
  --template "$TEMPLATE" \
  --lua-filter "$FILTER" \
  --resource-path "$(dirname "$INPUT"):$WORK" \
  -o "$WORK/publication.typ"

typst compile --root "$WORK" "$WORK/publication.typ" "$OUTPUT"

pdfinfo "$OUTPUT" > "$WORK/verification/pdfinfo.txt" 2> "$WORK/verification/pdfinfo.stderr.txt" || true
pdffonts "$OUTPUT" > "$WORK/verification/pdffonts.txt"
pdftotext "$OUTPUT" "$WORK/verification/pdftotext.txt"

META="$WORK/verification/pdfinfo.txt"
FONTS="$WORK/verification/pdffonts.txt"
TEXT="$WORK/verification/pdftotext.txt"

grep -Eq '^Tagged:[[:space:]]+yes' "$META" || { echo "Postflight failed: PDF is not tagged" >&2; exit 3; }
grep -Eq '^Page size:[[:space:]]+595\.276 x 841\.89 pts \(A4\)' "$META" || { echo "Postflight failed: PDF is not A4" >&2; exit 3; }
grep -Eq '^Pages:[[:space:]]+[1-9][0-9]*' "$META" || { echo "Postflight failed: PDF has no pages" >&2; exit 3; }
grep -Eiq 'Pretendard|NotoSansCJKkr|NotoSansKR' "$FONTS" || { echo "Postflight failed: Korean font was not embedded" >&2; exit 3; }
if grep -Eiq '```[[:space:]]*(mermaid|chart)|flowchart[[:space:]]+(LR|RL|TB|TD|BT)|sequenceDiagram|classDiagram|stateDiagram|erDiagram' "$TEXT"; then
  echo "Postflight failed: raw diagram source remains in PDF" >&2
  exit 3
fi

cat > "$WORK/verification.md" <<EOF
# Publication PDF verification

- Typst: $TYPST_VERSION
- Pandoc: $PANDOC_VERSION
- Template: tower-report.typ
- Output: $OUTPUT
- Tagged PDF: passed
- A4 page: passed
- Korean font embedded: passed
- Extractable text: passed
- Raw Mermaid residue: not detected

시각 검수는 별도로 pdf_view에서 수행해야 한다.
EOF

printf 'Built %s\n' "$OUTPUT"
printf 'Source %s\n' "$WORK/publication.typ"
printf 'Verification %s\n' "$WORK/verification.md"
