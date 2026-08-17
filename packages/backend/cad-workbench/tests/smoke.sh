#!/usr/bin/env bash
# Smoke test for license-free CAD Workbench MVP.
# Runs without Docker when ezdxf/matplotlib/Pillow are available on the host.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/cad_workbench.py"
OUT_DIR="${1:-$ROOT/tests/.out/smoke}"
FIXTURE="$OUT_DIR/fixture.dxf"
NORMALIZED="$OUT_DIR/normalized.dxf"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

python3 "$CLI" make-fixture --out "$FIXTURE" >/dev/null
python3 "$CLI" inspect "$FIXTURE" --out "$OUT_DIR/inspect.json"
python3 "$CLI" render "$FIXTURE" --view content --out "$OUT_DIR/render.content.png" --width 1200 --height 900
python3 "$CLI" qa "$FIXTURE" --out-dir "$OUT_DIR/qa" --width 1200 --height 900 >/dev/null
python3 "$CLI" normalize "$FIXTURE" --out "$NORMALIZED" >/dev/null
python3 "$CLI" compare "$FIXTURE" "$NORMALIZED" --out-dir "$OUT_DIR/compare" --width 1200 --height 900 >/dev/null

python3 - "$OUT_DIR" <<'PY'
import json, sys
from pathlib import Path
out = Path(sys.argv[1])
required = [
    out / 'fixture.dxf',
    out / 'inspect.json',
    out / 'render.content.png',
    out / 'qa' / 'qa.json',
    out / 'qa' / 'preview.full.png',
    out / 'qa' / 'preview.content.png',
    out / 'normalized.dxf',
    out / 'normalized.dxf.operation-log.json',
    out / 'compare' / 'summary.json',
    out / 'compare' / 'diff.png',
]
missing = [str(p) for p in required if not p.is_file() or p.stat().st_size == 0]
if missing:
    raise SystemExit('missing smoke artifacts: ' + ', '.join(missing))
qa = json.loads((out / 'qa' / 'qa.json').read_text())
if qa.get('renderer', {}).get('primary') != 'ezdxf-matplotlib':
    raise SystemExit('unexpected renderer in qa.json')
print('CAD workbench smoke OK:', out)
PY
