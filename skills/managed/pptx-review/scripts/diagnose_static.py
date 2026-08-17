#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "pyyaml>=6.0",
# ]
# ///
"""
diagnose_static.py — Algorithmic static analysis of pptx-template yaml.

Catches issues you don't need Vision for:
  • text length thresholds (overflow risk)
  • missing required fields per layout
  • chapter_idx vs meta.chapters consistency
  • source / confidential coverage

Usage:
    python3 diagnose_static.py path/to/data.yaml [--json]
"""

import argparse
import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("ERROR: pyyaml not installed.", file=sys.stderr)
    sys.exit(2)


# Heuristic thresholds (Korean-text-aware)
LIMITS = {
    "title":       40,   # slide title (대제목)
    "takeaway":    80,   # one-line takeaway (영문/한글 혼합 기준)
    "insight":     70,   # callout
    "bullet":      80,   # one bullet line
    "kpi_value":   5,    # big number — over 5 chars wraps
    "cover_short": 25,   # cover_short headline — over 25 chars (Korean) wraps
    "section_caption": 50,
}


def issues_for_slide(idx, sd, meta):
    """Return list of {severity, code, message, fix?}."""
    out = []
    layout = sd.get("layout", "")
    sn = idx + 1   # 1-based for human

    def flag(severity, code, msg, fix=None):
        out.append({
            "slide": sn, "layout": layout,
            "severity": severity, "code": code, "message": msg,
            "fix": fix,
        })

    # Common — title / takeaway / insight length
    title = sd.get("title", "") or ""
    if len(title) > LIMITS["title"]:
        flag("warn", "TITLE_LONG",
             f"Slide {sn}: title {len(title)}자 (>{LIMITS['title']}) — 한 줄 안 들어갈 수 있음",
             "title 단축 또는 두 부분으로 분리")

    takeaway = sd.get("takeaway", "") or ""
    if takeaway and len(takeaway) > LIMITS["takeaway"]:
        flag("warn", "TAKEAWAY_LONG",
             f"Slide {sn}: takeaway {len(takeaway)}자 (>{LIMITS['takeaway']}) — 두 줄 또는 잘림",
             "takeaway 단축. 'X = Y' 또는 'A → B' 형식 권장")

    insight = sd.get("insight", "") or ""
    if insight and len(insight) > LIMITS["insight"]:
        flag("warn", "INSIGHT_LONG",
             f"Slide {sn}: insight {len(insight)}자 (>{LIMITS['insight']}) — 콜아웃 두 줄",
             "insight 단축")

    # Layout-specific
    if layout == "bullets":
        bullets = sd.get("bullets", []) or []
        for i, b in enumerate(bullets):
            bs = str(b)
            if len(bs) > LIMITS["bullet"]:
                flag("warn", "BULLET_LONG",
                     f"Slide {sn} bullet {i+1}: {len(bs)}자 (>{LIMITS['bullet']})",
                     "불릿 단축 또는 분리")
        if len(bullets) == 0:
            flag("error", "BULLETS_EMPTY",
                 f"Slide {sn}: bullets layout 인데 항목 0개")

    elif layout == "kpi":
        items = sd.get("items", []) or []
        for i, it in enumerate(items):
            v = str(it.get("value", ""))
            if len(v) > LIMITS["kpi_value"]:
                flag("warn", "KPI_VALUE_LONG",
                     f"Slide {sn} KPI {i+1}: value '{v}' ({len(v)}자) — 카드에서 줄바꿈 위험",
                     "value 짧게 (예: '약 5권' → '5권')")
        if len(items) == 0:
            flag("error", "KPI_EMPTY", f"Slide {sn}: kpi layout 인데 items 0개")
        if len(items) > 4:
            flag("info", "KPI_MANY",
                 f"Slide {sn}: KPI 카드 {len(items)}개 — 4개로 제한 권장 (가독성)")

    elif layout == "comparison":
        cols = sd.get("columns", []) or []
        rows = sd.get("rows", []) or []
        if not cols or not rows:
            flag("error", "COMPARISON_EMPTY",
                 f"Slide {sn}: comparison 의 columns 또는 rows 누락")
        else:
            for i, r in enumerate(rows):
                if len(r) != len(cols):
                    flag("error", "COMPARISON_ROW_MISMATCH",
                         f"Slide {sn} row {i+1}: 컬럼 {len(cols)} 개인데 셀 {len(r)} 개")

    elif layout == "feature_grid":
        items = sd.get("items", []) or []
        if len(items) == 0:
            flag("error", "GRID_EMPTY",
                 f"Slide {sn}: feature_grid 인데 items 0개")

    elif layout == "timeline":
        items = sd.get("items", []) or []
        if len(items) == 0:
            flag("error", "TIMELINE_EMPTY", f"Slide {sn}: timeline 의 items 0개")

    elif layout == "section":
        chapters = meta.get("chapters", [])
        ci = sd.get("chapter_idx")
        if chapters and ci is None:
            flag("info", "CHAPTER_IDX_MISSING",
                 f"Slide {sn}: section 인데 chapter_idx 미지정 — 진행 트래커 안 그려짐",
                 f"chapter_idx 추가 (0-based, meta.chapters 인덱스)")
        if ci is not None and chapters:
            if not (0 <= ci < len(chapters)):
                flag("error", "CHAPTER_IDX_OOR",
                     f"Slide {sn}: chapter_idx={ci} 가 chapters 범위 [0, {len(chapters)-1}] 밖")

    elif layout == "cover_short":
        h = sd.get("headline", "") or ""
        if len(h) > LIMITS["cover_short"]:
            flag("warn", "COVER_SHORT_LONG",
                 f"Slide {sn}: cover_short headline {len(h)}자 (>{LIMITS['cover_short']}) — 두 줄",
                 "headline 단축 (한 메시지만)")

    elif layout == "split":
        if not sd.get("left") and not sd.get("center") and not sd.get("right"):
            flag("error", "SPLIT_EMPTY",
                 f"Slide {sn}: split 인데 left/center/right 모두 비어 있음")

    return out


def issues_global(meta, slides):
    """Doc-level checks."""
    out = []

    def flag(severity, code, msg, fix=None):
        out.append({
            "slide": None, "layout": "GLOBAL",
            "severity": severity, "code": code, "message": msg,
            "fix": fix,
        })

    n = len(slides)
    if n >= 10:
        layouts = [s.get("layout", "") for s in slides]
        if "toc" not in layouts:
            flag("info", "TOC_RECOMMENDED",
                 f"슬라이드 {n}장 인데 toc 없음 — 목차 권장",
                 "표지 다음 또는 두문 다음에 toc layout 추가")

    if not meta.get("company"):
        flag("info", "META_COMPANY_MISSING",
             "meta.company 미지정 — 헤더 좌측 빈칸",
             'meta.company: "MOAT AI" 추가')

    if not meta.get("project_short"):
        flag("info", "META_PROJECT_MISSING",
             "meta.project_short 미지정 — 헤더 가운데 빈칸",
             'meta.project_short: "<프로젝트 약어>" 추가')

    if not meta.get("source_default"):
        flag("info", "META_SOURCE_MISSING",
             "meta.source_default 미지정 — 출처 footer 빈칸 (슬라이드별 source 만 표시)",
             'meta.source_default: "<자료>" 추가')

    if not meta.get("confidential"):
        flag("info", "META_CONFIDENTIAL_MISSING",
             "meta.confidential 미지정 — B2B 외부 발표 시 '대외비' 권장",
             'meta.confidential: "대외비"')

    chapters = meta.get("chapters")
    section_count = sum(1 for s in slides if s.get("layout") == "section")
    if section_count > 0 and not chapters:
        flag("warn", "CHAPTERS_MISSING",
             f"section 슬라이드 {section_count}장 인데 meta.chapters 없음 — 진행 트래커 표시 불가",
             "meta.chapters 에 챕터 리스트 추가")

    return out


def main():
    ap = argparse.ArgumentParser(description="Static diagnostics for pptx-template yaml")
    ap.add_argument("yaml_path", help="Path to data.yaml")
    ap.add_argument("--json", action="store_true", help="Output JSON")
    args = ap.parse_args()

    p = Path(args.yaml_path)
    if not p.exists():
        print(f"ERROR: yaml not found: {p}", file=sys.stderr)
        sys.exit(1)

    with open(p, encoding="utf-8") as f:
        doc = yaml.safe_load(f)

    meta = doc.get("meta", {}) or {}
    slides = doc.get("slides", []) or []

    issues = []
    issues.extend(issues_global(meta, slides))
    for i, sd in enumerate(slides):
        issues.extend(issues_for_slide(i, sd, meta))

    summary = {
        "yaml": str(p),
        "slides_total": len(slides),
        "issues_total": len(issues),
        "by_severity": {
            "error": sum(1 for x in issues if x["severity"] == "error"),
            "warn":  sum(1 for x in issues if x["severity"] == "warn"),
            "info":  sum(1 for x in issues if x["severity"] == "info"),
        },
        "issues": issues,
    }

    if args.json:
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return

    # Human-friendly
    print(f"📄 {p.name}  —  슬라이드 {len(slides)}장,  이슈 {len(issues)}건")
    sv = summary["by_severity"]
    print(f"   ❌ error {sv['error']}  ⚠️  warn {sv['warn']}  ℹ️  info {sv['info']}")
    print()
    if not issues:
        print("✅ static 이슈 없음. Vision 평가만 진행.")
        return

    for sev_label, icon in [("error", "❌"), ("warn", "⚠️ "), ("info", "ℹ️ ")]:
        bucket = [x for x in issues if x["severity"] == sev_label]
        if not bucket:
            continue
        print(f"━━ {icon} {sev_label.upper()} ({len(bucket)})")
        for x in bucket:
            sn = f"S{x['slide']:02d}" if x["slide"] else "GLOBAL"
            print(f"  {sn} [{x['code']}]  {x['message']}")
            if x.get("fix"):
                print(f"           ↳ fix: {x['fix']}")
        print()


if __name__ == "__main__":
    main()
