#!/usr/bin/env python3
"""cad_workbench.py — license-free CAD/DXF inspection and QA workbench.

Owns: first CAD Workbench MVP for Runtime Box.
Public API: CLI subcommands inspect, render, qa, normalize, compare, apply-ops.

This MVP intentionally avoids QCAD/ODA-style proprietary renderers. It uses
`ezdxf` for DXF structure/editing, matplotlib for raster previews, and Pillow
for image metrics/diffs. Visual fidelity is preview-grade, not native CAD
sign-off quality.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import shutil
import sys
from copy import deepcopy
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

try:
    import ezdxf
    from ezdxf import recover
    from ezdxf.addons.drawing import RenderContext, Frontend
    from ezdxf.addons.drawing.config import BackgroundPolicy, ColorPolicy, Configuration
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
except Exception as exc:  # pragma: no cover - dependency guard
    ezdxf = None  # type: ignore
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except Exception as exc:  # pragma: no cover - dependency guard
    plt = None  # type: ignore
    _MPL_ERROR = exc
else:
    _MPL_ERROR = None

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFont
except Exception as exc:  # pragma: no cover - dependency guard
    Image = None  # type: ignore
    ImageChops = None  # type: ignore
    ImageDraw = None  # type: ignore
    ImageFont = None  # type: ignore
    _PIL_ERROR = exc
else:
    _PIL_ERROR = None

VERSION = "0.1.0"
BACKGROUND_RGB = (255, 255, 255)
CAD_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
]
CAD_FONT_FAMILIES = [
    "Noto Sans CJK KR",
    "NanumGothic",
    "Nanum Gothic",
    "DejaVu Sans",
]


def configure_cad_fonts() -> str | None:
    """Register Korean-capable fonts for matplotlib CAD text rendering."""
    selected: str | None = None
    if plt is None:
        return selected
    try:
        from matplotlib import font_manager
        for candidate in CAD_FONT_CANDIDATES:
            p = Path(candidate)
            if p.exists() and selected is None:
                selected = str(p)
            if p.exists():
                try:
                    font_manager.fontManager.addfont(str(p))
                except Exception:
                    pass
        # ezdxf has its own font manager; scan the CJK font folders so style.dxf.font
        # values like NanumGothic.ttf resolve to a real Unicode font instead of DejaVu.
        try:
            from ezdxf.fonts import fonts as ezdxf_fonts
            for folder in ("/usr/share/fonts/truetype/nanum", "/usr/share/fonts/opentype/noto"):
                if Path(folder).exists():
                    ezdxf_fonts.font_manager.scan_folder(Path(folder))
        except Exception:
            pass
        plt.rcParams["font.family"] = CAD_FONT_FAMILIES
        plt.rcParams["axes.unicode_minus"] = False
    except Exception:
        pass
    return selected


def force_render_font_styles(doc: Any, font_path: str | None) -> None:
    """Map DXF text styles to a Unicode TTF/TTC during preview rendering.

    Many Korean CAD files use SHX + bigfont pairs such as ghs.shx/whgtxt.shx.
    ezdxf's font resolver recognizes installed CJK fonts by filename such as
    `NotoSansCJK-Regular.ttc`, not by family name or absolute path. This preview
    only mapping does not mutate the source file because render callers load a
    fresh doc each time.
    """
    if not font_path:
        return
    font_name = Path(font_path).name
    for style in doc.styles:
        try:
            style.dxf.font = font_name
            if hasattr(style.dxf, "bigfont"):
                style.dxf.bigfont = ""
            # Extended ACAD font family data has priority over dxf.font in ezdxf;
            # existing values like "Arial" can force Latin-only fallback.
            try:
                if style.has_xdata("ACAD"):
                    style.discard_xdata("ACAD")
            except Exception:
                pass
        except Exception:
            continue


@dataclass
class Bounds:
    min_x: float
    min_y: float
    max_x: float
    max_y: float

    @property
    def width(self) -> float:
        return self.max_x - self.min_x

    @property
    def height(self) -> float:
        return self.max_y - self.min_y

    def as_list(self) -> list[float]:
        return [self.min_x, self.min_y, self.max_x, self.max_y]


def require_deps(render: bool = False, image: bool = False) -> None:
    if _IMPORT_ERROR:
        raise SystemExit(f"Missing dependency: ezdxf import failed: {_IMPORT_ERROR}")
    if render and _MPL_ERROR:
        raise SystemExit(f"Missing dependency: matplotlib import failed: {_MPL_ERROR}")
    if image and _PIL_ERROR:
        raise SystemExit(f"Missing dependency: Pillow import failed: {_PIL_ERROR}")


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def read_doc(path: Path):
    require_deps()
    try:
        doc, auditor = recover.readfile(str(path))
    except Exception as exc:
        raise SystemExit(f"Failed to read DXF: {path}: {exc}")
    return doc, auditor


def finite_bbox(entity: Any) -> Bounds | None:
    try:
        box = entity.bbox()
        if box.has_data:
            extmin = box.extmin
            extmax = box.extmax
            vals = [float(extmin.x), float(extmin.y), float(extmax.x), float(extmax.y)]
            if all(math.isfinite(v) for v in vals):
                return Bounds(vals[0], vals[1], vals[2], vals[3])
    except Exception:
        pass

    # Common lightweight fallbacks. These are intentionally conservative.
    try:
        t = entity.dxftype()
        dxf = entity.dxf
        if t == "LINE":
            xs = [float(dxf.start.x), float(dxf.end.x)]
            ys = [float(dxf.start.y), float(dxf.end.y)]
            return Bounds(min(xs), min(ys), max(xs), max(ys))
        if t in {"CIRCLE", "ARC"}:
            c = dxf.center
            r = float(dxf.radius)
            return Bounds(float(c.x) - r, float(c.y) - r, float(c.x) + r, float(c.y) + r)
        if t in {"TEXT", "MTEXT", "INSERT", "POINT"}:
            p = getattr(dxf, "insert", getattr(dxf, "location", None))
            if p is not None:
                x, y = float(p.x), float(p.y)
                return Bounds(x, y, x, y)
        if t in {"LWPOLYLINE", "POLYLINE"}:
            pts = []
            if t == "LWPOLYLINE":
                pts = [(float(p[0]), float(p[1])) for p in entity.get_points()]
            else:
                pts = [(float(v.dxf.location.x), float(v.dxf.location.y)) for v in entity.vertices]
            if pts:
                xs = [p[0] for p in pts]
                ys = [p[1] for p in pts]
                return Bounds(min(xs), min(ys), max(xs), max(ys))
    except Exception:
        return None
    return None


def union_bounds(bounds: Iterable[Bounds]) -> Bounds | None:
    items = list(bounds)
    if not items:
        return None
    return Bounds(
        min(b.min_x for b in items),
        min(b.min_y for b in items),
        max(b.max_x for b in items),
        max(b.max_y for b in items),
    )


def point_to_list(point: Any) -> list[float] | None:
    if point is None:
        return None
    try:
        return [round(float(point.x), 6), round(float(point.y), 6), round(float(getattr(point, "z", 0) or 0), 6)]
    except Exception:
        return None


def entity_insert_point(entity: Any) -> list[float] | None:
    dxf = getattr(entity, "dxf", None)
    if dxf is None:
        return None
    for attr in ("insert", "location", "center", "start"):
        try:
            if hasattr(dxf, attr):
                point = point_to_list(getattr(dxf, attr))
                if point:
                    return point
        except Exception:
            continue
    return None


def entity_text_value(entity: Any) -> str | None:
    try:
        if entity.dxftype() == "TEXT":
            return str(getattr(entity.dxf, "text", "") or "").strip()
        if entity.dxftype() == "MTEXT":
            if hasattr(entity, "plain_text"):
                return str(entity.plain_text() or "").strip()
            return str(getattr(entity, "text", "") or "").strip()
    except Exception:
        return None
    return None


def role_hints_for_layer(layer: str, counts: dict[str, int]) -> list[str]:
    key = layer.upper()
    hints: list[str] = []
    if "TEXT" in key or "DTEXT" in key:
        hints.append("annotation/text")
    if "DIM" in key:
        hints.append("dimension")
    if "TITLE" in key or "REV" in key:
        hints.append("title/revision")
    if "LINE" in key or "TRAY" in key or "DUCT" in key:
        hints.append("routing/linework")
    if "LIGHT" in key:
        hints.append("lighting")
    if counts.get("TEXT", 0) + counts.get("MTEXT", 0) > counts.get("LINE", 0) + counts.get("LWPOLYLINE", 0):
        hints.append("text-heavy")
    return sorted(set(hints))


def text_semantic_tags(text: str) -> list[str]:
    upper = text.upper()
    tags: list[str] = []
    if any(k in upper for k in ("RISK", "REVIEW", "APPROVAL", "NOT FINAL", "ISSUE")):
        tags.append("risk/review-note")
    if any(k in upper for k in ("REV", "REVISION")):
        tags.append("revision")
    if any(k in upper for k in ("LOCAL", "EQUIPMENT", "PANEL", "MCC", "LCP", "PLC", "LOB")):
        tags.append("equipment/panel")
    if any(k in upper for k in ("CABLE", "TUBE", "LENGTH", "ROUTE", "CONDUIT", "F-CV", "CVV")):
        tags.append("routing/cable")
    if re.search(r"\b[A-Z]+[-_/]?[A-Z]*\d{2,}(?:[-_]\d+)?\b", upper):
        tags.append("tag-like")
    if re.search(r"\b(?:AC|DC)?\d{2,4}V\b", upper) or "㎟" in text or "SQ" in upper:
        tags.append("electrical-spec")
    if len(text) >= 40:
        tags.append("long-note")
    return sorted(set(tags))


def extract_text_index(entities: list[Any], limit: int = 500) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for entity in entities:
        value = entity_text_value(entity)
        if not value:
            continue
        dxf = getattr(entity, "dxf", None)
        layer = str(getattr(dxf, "layer", "0")) if dxf is not None else "0"
        height = None
        try:
            height = float(getattr(dxf, "height", 0) or 0)
        except Exception:
            pass
        handle = str(getattr(dxf, "handle", "")) if dxf is not None else ""
        bbox = finite_bbox(entity)
        rows.append({
            "id": f"text:{handle}" if handle else f"text:{len(rows) + 1}",
            "handle": handle,
            "type": entity.dxftype(),
            "layer": layer,
            "text": value,
            "insert": entity_insert_point(entity),
            "bounds": bbox.as_list() if bbox else None,
            "height": height,
            "tags": text_semantic_tags(value),
        })
    rows.sort(key=lambda r: ((r.get("insert") or [0, 0, 0])[1], (r.get("insert") or [0, 0, 0])[0]), reverse=True)
    return rows[:limit]


def insert_attributes(entity: Any) -> dict[str, str]:
    attrs: dict[str, str] = {}
    try:
        for attrib in entity.attribs:
            dxf = getattr(attrib, "dxf", None)
            tag = str(getattr(dxf, "tag", "") or "").strip()
            text = str(getattr(dxf, "text", "") or "").strip()
            if tag:
                attrs[tag] = text
    except Exception:
        pass
    return attrs


def extract_insert_index(entities: list[Any], limit: int = 300) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for entity in entities:
        try:
            if entity.dxftype() != "INSERT":
                continue
            dxf = entity.dxf
            handle = str(getattr(dxf, "handle", ""))
            bbox = finite_bbox(entity)
            rows.append({
                "id": f"block:{handle}" if handle else f"block:{len(rows) + 1}",
                "handle": handle,
                "block": str(getattr(dxf, "name", "")),
                "layer": str(getattr(dxf, "layer", "0")),
                "insert": entity_insert_point(entity),
                "bounds": bbox.as_list() if bbox else None,
                "scale": [
                    float(getattr(dxf, "xscale", 1) or 1),
                    float(getattr(dxf, "yscale", 1) or 1),
                    float(getattr(dxf, "zscale", 1) or 1),
                ],
                "rotation": float(getattr(dxf, "rotation", 0) or 0),
                "attributes": insert_attributes(entity),
            })
        except Exception:
            continue
    return rows[:limit]


def block_index(input_path: Path, out_path: Path | None = None) -> dict[str, Any]:
    doc, _auditor = read_doc(input_path)
    entities = list(doc.modelspace())
    inserts = extract_insert_index(entities, limit=100_000)
    summary: dict[str, int] = {}
    attribute_keys: dict[str, list[str]] = {}
    for row in inserts:
        name = str(row.get("block") or "")
        summary[name] = summary.get(name, 0) + 1
        attrs = row.get("attributes") or {}
        if attrs:
            keys = attribute_keys.setdefault(name, [])
            for key in attrs.keys():
                if key not in keys:
                    keys.append(key)
    result = {
        "version": VERSION,
        "source": str(input_path),
        "blocks": inserts,
        "summary": dict(sorted(summary.items(), key=lambda item: (-item[1], item[0]))),
        "attribute_keys": {name: sorted(keys) for name, keys in sorted(attribute_keys.items())},
        "counts": {
            "insert_entities": len(inserts),
            "unique_block_names": len(summary),
            "blocks_with_attributes": sum(1 for row in inserts if row.get("attributes")),
        },
    }
    if out_path:
        save_json(result, out_path)
    return result


def candidate_score(value: str, keywords: tuple[str, ...]) -> int:
    upper = value.upper()
    return sum(1 for keyword in keywords if keyword in upper)


def write_candidate_report(result: dict[str, Any], path: Path) -> None:
    lines: list[str] = []
    lines.append("# CAD Candidate Report")
    lines.append("")
    lines.append(f"Source: `{result.get('source')}`")
    counts = result.get("counts", {})
    lines.append(f"Blocks: `{counts.get('insert_entities', 0)}` inserts / `{counts.get('unique_block_names', 0)}` unique names; texts: `{counts.get('texts', 0)}`")
    lines.append("")

    def section(title: str, rows: list[dict[str, Any]], columns: list[str]) -> None:
        lines.append(f"## {title}")
        if not rows:
            lines.append("- No candidates detected.")
            lines.append("")
            return
        lines.append("| " + " | ".join(columns) + " |")
        lines.append("|" + "---|" * len(columns))
        for row in rows[:30]:
            values = []
            for col in columns:
                value = row.get(col, "")
                if isinstance(value, (list, tuple)):
                    value = ", ".join(str(v) for v in value[:3])
                if isinstance(value, dict):
                    value = ", ".join(f"{k}={v}" for k, v in list(value.items())[:4])
                text = str(value).replace("|", "\\|").replace("\n", " ")[:180]
                values.append(text)
            lines.append("| " + " | ".join(values) + " |")
        if len(rows) > 30:
            lines.append(f"\n... {len(rows) - 30} more candidates omitted. See JSON for full list.")
        lines.append("")

    section("Equipment / named block candidates", result.get("equipment_candidates", []), ["kind", "name", "count", "layer", "handle", "insert", "attributes", "reason"])
    section("Repeated anonymous block candidates", result.get("repeated_block_candidates", []), ["kind", "name", "count", "layer", "handle", "insert", "reason"])
    section("Title block candidates", result.get("title_candidates", []), ["kind", "text", "block", "layer", "handle", "insert", "reason"])
    section("Revision candidates", result.get("revision_candidates", []), ["kind", "text", "block", "layer", "handle", "insert", "reason"])
    section("Risk / review note candidates", result.get("risk_note_candidates", []), ["kind", "text", "layer", "handle", "insert", "reason"])
    lines.append("## Next actions")
    lines.append("- Use equipment candidates to build or verify equipment/BOM lists.")
    lines.append("- Use title/revision candidates to check drawing number, issue status, and submission readiness.")
    lines.append("- Use risk/review notes to decide what must be removed, confirmed, or called out before client issue.")
    lines.append("- Treat this as a heuristic review; native CAD/human sign-off is still required for engineering-critical decisions.")
    ensure_parent(path)
    path.write_text("\n".join(lines) + "\n", "utf-8")


def candidate_report(input_path: Path, out_path: Path | None = None, markdown_path: Path | None = None) -> dict[str, Any]:
    report = inspect_dxf(input_path)
    blocks = block_index(input_path)
    text_rows = report.get("text_index", [])
    block_rows = blocks.get("blocks", [])
    summary = blocks.get("summary", {})

    title_keywords = ("TITLE", "DRAWING", "DWG", "도면", "PROJECT", "PROJ", "DATE", "SCALE", "SHEET", "DESCRIPTION", "MATERIAL", "WEIGHT")
    revision_keywords = ("REV", "REVISION", "ISSUE", "APPROVAL", "승인", "개정", "검토", "제출")
    equipment_keywords = ("MOTOR", "MTR", "PUMP", "PANEL", "MCC", "LCP", "PLC", "JB", "J/B", "VALVE", "SOL", "SENSOR", "LS", "CYL", "INV", "VFD", "TB", "BOX", "PROBE", "SAMPLER")

    equipment_candidates: list[dict[str, Any]] = []
    repeated_block_candidates: list[dict[str, Any]] = []
    for name, count in sorted(summary.items(), key=lambda item: (-item[1], item[0])):
        if not name:
            continue
        score = candidate_score(name, equipment_keywords)
        is_anonymous = name.upper().startswith("A$C") or name.startswith("*")
        rows = [row for row in block_rows if row.get("block") == name]
        sample = rows[0] if rows else {}
        attrs = sample.get("attributes") or {}
        candidate = {
            "kind": "block",
            "name": name,
            "count": count,
            "layer": sample.get("layer"),
            "handle": sample.get("handle"),
            "insert": sample.get("insert"),
            "attributes": attrs,
        }
        if score or attrs or (count >= 3 and not is_anonymous):
            equipment_candidates.append({**candidate, "reason": "name/attribute suggests equipment" if score or attrs else "named repeated block instance"})
        elif count >= 3:
            repeated_block_candidates.append({**candidate, "reason": "anonymous repeated block; inspect visually before treating as equipment"})

    title_candidates: list[dict[str, Any]] = []
    revision_candidates: list[dict[str, Any]] = []
    risk_note_candidates: list[dict[str, Any]] = []
    for row in text_rows:
        text = str(row.get("text") or "")
        layer = str(row.get("layer") or "")
        base = {
            "kind": "text",
            "text": text,
            "layer": layer,
            "handle": row.get("handle"),
            "insert": row.get("insert"),
            "bounds": row.get("bounds"),
        }
        if candidate_score(text + " " + layer, title_keywords):
            title_candidates.append({**base, "reason": "title/drawing metadata keyword"})
        if candidate_score(text + " " + layer, revision_keywords):
            revision_candidates.append({**base, "reason": "revision/issue keyword"})
        tags = row.get("tags") or []
        if "risk/review-note" in tags or any(k in text.upper() for k in ("RISK", "NOT FINAL", "FIELD CHECK", "APPROVAL", "NEED")):
            risk_note_candidates.append({**base, "reason": "risk/review note keyword"})

    for row in block_rows:
        name = str(row.get("block") or "")
        layer = str(row.get("layer") or "")
        attrs = row.get("attributes") or {}
        joined = " ".join([name, layer, *attrs.keys(), *attrs.values()])
        base = {
            "kind": "block",
            "block": name,
            "layer": layer,
            "handle": row.get("handle"),
            "insert": row.get("insert"),
            "bounds": row.get("bounds"),
            "attributes": attrs,
        }
        if candidate_score(joined, title_keywords):
            title_candidates.append({**base, "text": ", ".join(f"{k}={v}" for k, v in attrs.items()), "reason": "block/attribute title keyword"})
        if candidate_score(joined, revision_keywords):
            revision_candidates.append({**base, "text": ", ".join(f"{k}={v}" for k, v in attrs.items()), "reason": "block/attribute revision keyword"})

    result = {
        "version": VERSION,
        "source": str(input_path),
        "counts": {
            "texts": len(text_rows),
            **blocks.get("counts", {}),
            "equipment_candidates": len(equipment_candidates),
            "repeated_block_candidates": len(repeated_block_candidates),
            "title_candidates": len(title_candidates),
            "revision_candidates": len(revision_candidates),
            "risk_note_candidates": len(risk_note_candidates),
        },
        "equipment_candidates": equipment_candidates[:200],
        "repeated_block_candidates": repeated_block_candidates[:200],
        "title_candidates": title_candidates[:120],
        "revision_candidates": revision_candidates[:120],
        "risk_note_candidates": risk_note_candidates[:120],
        "artifacts": {},
    }
    if out_path:
        result["artifacts"]["json"] = str(out_path)
    if markdown_path:
        result["artifacts"]["markdown"] = str(markdown_path)
    if out_path:
        save_json(result, out_path)
    if markdown_path:
        write_candidate_report(result, markdown_path)
    return result


def cad_evidence_item(row: dict[str, Any], *, label: str, confidence: str = "read") -> dict[str, Any]:
    item: dict[str, Any] = {
        "label": label,
        "handle": row.get("handle"),
        "layer": row.get("layer"),
        "insert": row.get("insert"),
        "confidence": confidence,
    }
    if row.get("block") or row.get("name"):
        item["block"] = row.get("block") or row.get("name")
    if row.get("text"):
        item["text"] = row.get("text")
    if row.get("reason"):
        item["note"] = row.get("reason")
    return {k: v for k, v in item.items() if v not in (None, "", [])}


def write_rfq_intake_report(result: dict[str, Any], path: Path) -> None:
    counts = result.get("counts", {})
    equipment = result.get("equipment_candidates", [])
    anonymous = result.get("repeated_block_candidates", [])
    titles = result.get("title_candidates", [])
    revisions = result.get("revision_candidates", [])
    risks = result.get("risk_note_candidates", [])

    evidence_items: list[dict[str, Any]] = []
    for row in equipment[:8]:
        name = str(row.get("name") or row.get("block") or "equipment candidate")
        count = row.get("count")
        label = f"{name}" + (f" ({count}x)" if count else "")
        evidence_items.append(cad_evidence_item(row, label=label, confidence="read"))
    for row in titles[:6]:
        text = str(row.get("text") or row.get("block") or "title candidate")[:80]
        evidence_items.append(cad_evidence_item(row, label=f"Title/status: {text}", confidence="read"))
    for row in revisions[:4]:
        text = str(row.get("text") or row.get("block") or "revision candidate")[:80]
        evidence_items.append(cad_evidence_item(row, label=f"Revision/issue: {text}", confidence="read"))
    if not revisions:
        for row in titles:
            text = str(row.get("text") or "")
            if text.strip() in {"A", "B", "C", "0", "1"} or re.match(r"^'?\d{2}[./-]\d{2}[./-]\d{2,4}$", text.strip()):
                evidence_items.append(cad_evidence_item(row, label=f"Possible revision/date: {text}", confidence="needs_review"))
                if len(evidence_items) >= 18:
                    break

    lines: list[str] = []
    lines.append("# CAD RFQ Intake")
    lines.append("")
    lines.append(f"Source: `{result.get('source')}`")
    lines.append("")
    lines.append("## 업무 결론")
    lines.append("")
    lines.append("이 도면은 CAD harness가 견적/RFQ 전 검토를 시작할 수 있는 구조 정보를 포함합니다.")
    lines.append("")
    lines.append(f"- Text candidates: `{counts.get('texts', 0)}`")
    lines.append(f"- INSERT/block instances: `{counts.get('insert_entities', 0)}`")
    lines.append(f"- Unique block names: `{counts.get('unique_block_names', 0)}`")
    lines.append(f"- Blocks with ATTRIB: `{counts.get('blocks_with_attributes', 0)}`")
    lines.append(f"- Equipment/named block candidates: `{counts.get('equipment_candidates', 0)}`")
    lines.append(f"- Anonymous repeated block review candidates: `{counts.get('repeated_block_candidates', 0)}`")
    lines.append(f"- Title/status candidates: `{counts.get('title_candidates', 0)}`")
    lines.append(f"- Revision candidates: `{counts.get('revision_candidates', 0)}`")
    lines.append("")

    def table(title: str, rows: list[dict[str, Any]], cols: list[str], limit: int = 12) -> None:
        lines.append(f"## {title}")
        lines.append("")
        if not rows:
            lines.append("- No candidates detected.")
            lines.append("")
            return
        lines.append("| " + " | ".join(cols) + " |")
        lines.append("|" + "---|" * len(cols))
        for row in rows[:limit]:
            vals = []
            for col in cols:
                val = row.get(col, "")
                if isinstance(val, list):
                    val = ", ".join(str(v) for v in val[:3])
                if isinstance(val, dict):
                    val = ", ".join(f"{k}={v}" for k, v in list(val.items())[:3])
                vals.append(str(val).replace("|", "\\|").replace("\n", " ")[:140])
            lines.append("| " + " | ".join(vals) + " |")
        if len(rows) > limit:
            lines.append(f"\n... {len(rows) - limit} more candidates omitted. See candidate-report.json for full list.")
        lines.append("")

    table("장비/작업 항목 후보", equipment, ["name", "count", "layer", "handle", "insert", "reason"])
    table("시각 확인이 필요한 반복 anonymous block", anonymous, ["name", "count", "layer", "handle", "insert", "reason"], limit=10)
    table("Title/status 후보", titles, ["text", "block", "layer", "handle", "insert", "reason"], limit=14)
    table("Revision/risk 후보", revisions + risks, ["text", "block", "layer", "handle", "insert", "reason"], limit=10)

    lines.append("## 견적 전 확인 질문")
    lines.append("")
    lines.append("1. 이 도면이 견적 기준으로 사용할 최신 revision/status인지 확인해야 합니다.")
    lines.append("2. named/repeated block 후보를 실제 장비·부품·작업 항목으로 볼 수 있는지 시각 확인이 필요합니다.")
    lines.append("3. anonymous repeated block은 자동 견적 항목으로 확정하지 말고 preview에서 대표 위치를 검토해야 합니다.")
    if int(counts.get("blocks_with_attributes", 0) or 0) == 0:
        lines.append("4. 이 도면에서는 ATTRIB 기반 BOM 추출 근거가 없습니다. 별도 BOM/Excel/도면 표와 대조해야 합니다.")
    else:
        lines.append("4. ATTRIB 값이 있는 block은 BOM/title metadata 후보로 우선 검토해야 합니다.")
    lines.append("")

    lines.append("## CAD evidence block")
    lines.append("")
    lines.append("아래 block은 AI thread에서 `도면에서 보기` 버튼으로 렌더링될 수 있습니다.")
    lines.append("")
    lines.append("```cad-evidence")
    lines.append(json.dumps({"title": "RFQ intake evidence", "items": evidence_items[:20]}, ensure_ascii=False, indent=2))
    lines.append("```")
    lines.append("")
    lines.append("## 한계")
    lines.append("")
    lines.append("- 이 리포트는 heuristic 후보 추출입니다. 견적/시공/안전 판단은 원도면과 사람 검토가 필요합니다.")
    lines.append("- block name이 anonymous(`A$C...`)인 경우 의미를 자동 확정하지 않습니다.")
    lines.append("- preview 위치 연동은 `handle`, `insert`, `bounds`를 View harness가 해석해야 정밀해집니다.")
    ensure_parent(path)
    path.write_text("\n".join(lines) + "\n", "utf-8")


def rfq_intake(input_path: Path, out_path: Path) -> dict[str, Any]:
    result = candidate_report(input_path)
    write_rfq_intake_report(result, out_path)
    return {
        "version": VERSION,
        "source": str(input_path),
        "output": str(out_path),
        "counts": result.get("counts", {}),
    }


def inspect_dxf(path: Path) -> dict[str, Any]: 
    doc, auditor = read_doc(path)
    msp = doc.modelspace()
    entities = list(msp)
    entity_bounds = [b for e in entities if (b := finite_bbox(e)) is not None]
    bounds = union_bounds(entity_bounds)
    type_counts: dict[str, int] = {}
    layer_counts: dict[str, int] = {}
    layer_type_counts: dict[str, dict[str, int]] = {}
    for entity in entities:
        t = entity.dxftype()
        type_counts[t] = type_counts.get(t, 0) + 1
        layer = str(getattr(entity.dxf, "layer", "0"))
        layer_counts[layer] = layer_counts.get(layer, 0) + 1
        layer_type_counts.setdefault(layer, {})[t] = layer_type_counts.setdefault(layer, {}).get(t, 0) + 1

    text_index = extract_text_index(entities)
    insert_index = extract_insert_index(entities)
    text_count = sum(type_counts.get(t, 0) for t in ("TEXT", "MTEXT"))
    dimension_count = type_counts.get("DIMENSION", 0)
    block_names = [block.name for block in doc.blocks]
    layer_names = [layer.dxf.name for layer in doc.layers]
    layouts = [layout.name for layout in doc.layouts]

    warnings: list[dict[str, Any]] = []
    if bounds and (abs(bounds.min_x) > 100_000 or abs(bounds.min_y) > 100_000):
        warnings.append({
            "code": "FAR_FROM_ORIGIN",
            "severity": "medium",
            "message": "Drawing content is far from origin; previews and downstream consumers may show awkward extents.",
        })
    if not bounds:
        warnings.append({
            "code": "NO_BOUNDS_DETECTED",
            "severity": "high",
            "message": "Could not compute modelspace content bounds from supported entities.",
        })

    layer_summary = [
        {
            "name": layer,
            "entity_count": layer_counts[layer],
            "type_counts": dict(sorted(layer_type_counts.get(layer, {}).items())),
            "role_hints": role_hints_for_layer(layer, layer_type_counts.get(layer, {})),
        }
        for layer in sorted(layer_counts, key=lambda item: layer_counts[item], reverse=True)
    ]
    semantic_text = [row for row in text_index if row.get("tags")]

    return {
        "version": VERSION,
        "source": str(path),
        "document": {
            "dxf_version": doc.dxfversion,
            "layouts": layouts,
            "units": int(doc.header.get("$INSUNITS", 0) or 0),
            "auditor_has_errors": bool(getattr(auditor, "has_errors", False)),
            "auditor_error_count": len(getattr(auditor, "errors", []) or []),
        },
        "counts": {
            "entities": len(entities),
            "texts": text_count,
            "dimensions": dimension_count,
            "blocks": len(block_names),
            "layers": len(layer_names),
        },
        "type_counts": dict(sorted(type_counts.items())),
        "layer_counts": dict(sorted(layer_counts.items())),
        "layers": layer_names,
        "layer_summary": layer_summary,
        "blocks": block_names[:200],
        "insert_index": insert_index,
        "text_index": text_index,
        "semantic_text_candidates": semantic_text[:80],
        "bounds": {"modelspace": bounds.as_list() if bounds else None},
        "warnings": warnings,
    }


def entity_id(prefix: str, handle: str | None, fallback: int) -> str:
    handle = str(handle or "").strip()
    return f"{prefix}:{handle}" if handle else f"{prefix}:{fallback}"


def classify_text_semantic_object(text: str, layer: str, tags: list[str] | None = None) -> tuple[str, float, str] | None:
    value = text.strip()
    if not value:
        return None
    upper = value.upper()
    layer_upper = layer.upper()
    tags = tags or []
    if "risk/review-note" in tags:
        return "note", 0.65, "text semantic tag"
    if any(k in upper for k in ("REV", "REVISION", "ISSUE", "APPROVAL", "승인", "개정", "검토", "제출")):
        return "revision", 0.65, "revision/review keyword"
    if any(k in upper for k in ("TITLE", "DRAWING", "DWG", "PROJECT", "SCALE", "SHEET", "도면", "단위")):
        return "title-block", 0.55, "title/drawing metadata keyword"
    if re.search(r"(현관문|침실문|욕실문|문|창)\s*\d", value) or any(k in upper for k in ("DOOR", "WINDOW")):
        return "opening", 0.58, "door/window/opening label"
    if "ROOM" in layer_upper or "ROOM" in upper or any(k in value for k in ("거실", "주방", "침실", "욕실", "현관", "방", "실", "ROOM")):
        return "room", 0.58, "room label/layer"
    if "DIM" in layer_upper or "SIZE" in layer_upper or any(k in value for k in ("전체", "세로", "가로")) or " x " in value.lower() or "×" in value:
        return "dimension-note", 0.5, "dimension/size label"
    if "TEXT" in layer_upper and any(k in value for k in ("소파", "침대", "식탁", "테이블", "싱크대", "TV", "변기", "세면대", "샤워", "옷장", "신발장")):
        return "fixture", 0.5, "fixture/furniture label"
    return None


def build_minimal_cad_model(report: dict[str, Any], blocks: dict[str, Any], candidates: dict[str, Any], artifact_paths: dict[str, str] | None = None) -> dict[str, Any]:
    source = str(report.get("source") or blocks.get("source") or candidates.get("source") or "")
    layers = []
    for row in report.get("layer_summary", []) or []:
        name = str(row.get("name") or "0")
        layers.append({
            "id": f"layer:{name}",
            "name": name,
            "entityCount": row.get("entity_count", 0),
            "typeCounts": row.get("type_counts") or {},
            "roleHints": row.get("role_hints") or [],
        })

    texts = []
    for idx, row in enumerate(report.get("text_index", []) or [], start=1):
        handle = str(row.get("handle") or "")
        texts.append({
            "id": row.get("id") or entity_id("text", handle, idx),
            "entityId": entity_id("entity", handle, idx),
            "handle": handle,
            "type": str(row.get("type") or "TEXT").lower(),
            "layer": row.get("layer") or "0",
            "text": row.get("text") or "",
            "insert": row.get("insert"),
            "bounds": row.get("bounds"),
            "height": row.get("height"),
            "tags": row.get("tags") or [],
            "confidence": "read",
        })

    block_instances = []
    for idx, row in enumerate(blocks.get("blocks", []) or [], start=1):
        handle = str(row.get("handle") or "")
        block_instances.append({
            "id": row.get("id") or entity_id("block", handle, idx),
            "entityId": entity_id("entity", handle, idx),
            "handle": handle,
            "blockName": row.get("block") or "",
            "layer": row.get("layer") or "0",
            "insert": row.get("insert"),
            "bounds": row.get("bounds"),
            "scale": row.get("scale"),
            "rotation": row.get("rotation"),
            "attributes": row.get("attributes") or {},
        })

    view_candidates = []
    for idx, row in enumerate(candidates.get("view_candidates", []) or [], start=1):
        candidate_id = str(row.get("id") or f"candidate-{idx}")
        view_candidates.append({
            "id": f"view:{candidate_id}",
            "candidateId": candidate_id,
            "label": row.get("label") or candidate_id,
            "kind": row.get("kind") or "view",
            "bounds": row.get("bbox") or row.get("bounds"),
            "entityCount": row.get("entityCount") or row.get("entity_count"),
            "score": row.get("score"),
        })

    semantic_objects: list[dict[str, Any]] = []
    semantic_seen: set[str] = set()
    semantic_groups = [
        ("equipment", candidates.get("equipment_candidates", []) or []),
        ("repeated-block", candidates.get("repeated_block_candidates", []) or []),
        ("title-block", candidates.get("title_candidates", []) or []),
        ("revision", candidates.get("revision_candidates", []) or []),
        ("note", candidates.get("risk_note_candidates", []) or []),
    ]
    for kind, rows in semantic_groups:
        for idx, row in enumerate(rows[:200], start=1):
            handle = str(row.get("handle") or "")
            label = str(row.get("name") or row.get("text") or row.get("block") or f"{kind} candidate")
            semantic_id = f"semantic:{kind}:{handle or idx}"
            semantic_seen.add(semantic_id)
            semantic_objects.append({
                "id": semantic_id,
                "kind": kind,
                "label": label,
                "entityIds": [entity_id("entity", handle, idx)] if handle else [],
                "handle": handle,
                "layer": row.get("layer"),
                "blockName": row.get("name") or row.get("block"),
                "text": row.get("text"),
                "insert": row.get("insert"),
                "bounds": row.get("bounds"),
                "confidence": 0.65 if kind in {"equipment", "title-block", "revision"} else 0.5,
                "reason": row.get("reason"),
            })

    for idx, row in enumerate(texts[:400], start=1):
        semantic = classify_text_semantic_object(str(row.get("text") or ""), str(row.get("layer") or ""), row.get("tags") or [])
        if not semantic:
            continue
        kind, confidence, reason = semantic
        handle = str(row.get("handle") or "")
        semantic_id = f"semantic:{kind}:{handle or idx}"
        if semantic_id in semantic_seen:
            continue
        semantic_seen.add(semantic_id)
        semantic_objects.append({
            "id": semantic_id,
            "kind": kind,
            "label": row.get("text") or f"{kind} text",
            "entityIds": [row.get("entityId") or entity_id("entity", handle, idx)] if handle else [],
            "handle": handle,
            "layer": row.get("layer"),
            "text": row.get("text"),
            "insert": row.get("insert"),
            "bounds": row.get("bounds"),
            "confidence": confidence,
            "reason": reason,
        })

    return {
        "version": VERSION,
        "schema": "tower.cad-model.v1-minimal",
        "sourcePath": source,
        "sourceType": "dxf" if source.lower().endswith(".dxf") else "unknown",
        "document": report.get("document") or {},
        "bounds": (report.get("bounds") or {}).get("modelspace"),
        "counts": {
            **(report.get("counts") or {}),
            "blockInstances": len(block_instances),
            "textsIndexed": len(texts),
            "semanticObjects": len(semantic_objects),
            "viewCandidates": len(view_candidates),
        },
        "typeCounts": report.get("type_counts") or {},
        "layers": layers,
        "texts": texts,
        "blockInstances": block_instances,
        "viewCandidates": view_candidates,
        "semanticObjects": semantic_objects,
        "diagnostics": report.get("warnings") or [],
        "artifacts": artifact_paths or {},
        "provenance": {
            "parser": "ezdxf",
            "generator": "cad_workbench.py",
            "generatorVersion": VERSION,
        },
    }


def primitive_bbox(primitive: dict[str, Any]) -> list[float] | None:
    bbox = primitive.get("bbox")
    if isinstance(bbox, list) and len(bbox) >= 4:
        try:
            return [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])]
        except Exception:
            return None
    return None


def bounds_union_lists(rows: Iterable[list[float] | None]) -> list[float] | None:
    vals = [row for row in rows if row and len(row) >= 4]
    if not vals:
        return None
    return [
        min(float(v[0]) for v in vals),
        min(float(v[1]) for v in vals),
        max(float(v[2]) for v in vals),
        max(float(v[3]) for v in vals),
    ]


def geometry_primitive_from_entity(entity: Any, index: int) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    dxf = getattr(entity, "dxf", None)
    t = entity.dxftype()
    handle = str(getattr(dxf, "handle", "") or "") if dxf is not None else ""
    layer = str(getattr(dxf, "layer", "0") or "0") if dxf is not None else "0"
    entity_id = entity_id_from_handle(handle, index)
    base = {
        "id": f"primitive:{index}",
        "entityId": entity_id,
        "handle": handle or None,
        "layer": layer,
        "sourceType": t,
        "parentInsertId": None,
    }
    try:
        if t == "LINE":
            a = point_to_list(dxf.start)
            b = point_to_list(dxf.end)
            if not a or not b:
                raise ValueError("missing line endpoints")
            bbox = bounds_union_lists([[a[0], a[1], a[0], a[1]], [b[0], b[1], b[0], b[1]]])
            return ({**base, "kind": "line", "points": [a, b], "bbox": bbox}, None)
        if t in {"LWPOLYLINE", "POLYLINE"}:
            if t == "LWPOLYLINE":
                points = [[round(float(p[0]), 6), round(float(p[1]), 6), 0] for p in entity.get_points()]
            else:
                points = [point_to_list(v.dxf.location) for v in entity.vertices]
                points = [p for p in points if p]
            if len(points) < 2:
                raise ValueError("polyline has fewer than 2 points")
            bbox = bounds_union_lists([[p[0], p[1], p[0], p[1]] for p in points])
            return ({**base, "kind": "polyline", "points": points, "closed": bool(getattr(entity, "closed", False)), "bbox": bbox}, None)
        if t == "CIRCLE":
            c = point_to_list(dxf.center)
            r = float(dxf.radius)
            if not c or not math.isfinite(r):
                raise ValueError("missing circle center/radius")
            return ({**base, "kind": "circle", "center": c, "radius": r, "bbox": [c[0] - r, c[1] - r, c[0] + r, c[1] + r]}, None)
        if t == "ARC":
            c = point_to_list(dxf.center)
            r = float(dxf.radius)
            if not c or not math.isfinite(r):
                raise ValueError("missing arc center/radius")
            return ({**base, "kind": "arc", "center": c, "radius": r, "startAngle": float(dxf.start_angle), "endAngle": float(dxf.end_angle), "bbox": [c[0] - r, c[1] - r, c[0] + r, c[1] + r]}, None)
        if t in {"TEXT", "MTEXT"}:
            p = entity_insert_point(entity)
            text = getattr(entity, "plain_text", lambda: None)() if t == "MTEXT" else getattr(dxf, "text", "")
            if not p:
                raise ValueError("missing text position")
            return ({**base, "kind": "text", "position": p, "text": str(text or ""), "height": float(getattr(dxf, "height", 0) or 0), "bbox": [p[0], p[1], p[0], p[1]]}, None)
    except Exception as exc:
        return (None, {"entityId": entity_id, "handle": handle or None, "type": t, "layer": layer, "reason": str(exc)})
    return (None, {"entityId": entity_id, "handle": handle or None, "type": t, "layer": layer, "reason": "unsupported entity type in cad-geometry v0"})


def entity_id_from_handle(handle: str | None, fallback: int) -> str:
    handle = str(handle or "").strip()
    return f"entity:{handle}" if handle else f"entity:{fallback}"


def write_cad_geometry_package(input_path: Path, out_dir: Path, *, max_primitives: int = 3000) -> dict[str, Any]:
    """Write a small manifest-first CAD geometry package for the product Phase A path.

    This first product artifact intentionally covers top-level common primitives only.
    INSERT/block expansion, adaptive quadtree and heavy tiling are validated in project
    experiments and can be promoted later.
    """
    doc, _auditor = read_doc(input_path)
    entities = list(doc.modelspace())
    geometry_dir = out_dir / "cad-geometry"
    tiles_dir = geometry_dir / "tiles"
    tiles_dir.mkdir(parents=True, exist_ok=True)

    primitives: list[dict[str, Any]] = []
    unsupported: list[dict[str, Any]] = []
    type_counts: dict[str, int] = {}
    primitive_kind_counts: dict[str, int] = {}
    unsupported_type_counts: dict[str, int] = {}
    layer_counts: dict[str, int] = {}
    for index, entity in enumerate(entities, start=1):
        t = entity.dxftype()
        type_counts[t] = type_counts.get(t, 0) + 1
        primitive, problem = geometry_primitive_from_entity(entity, index)
        if primitive:
            primitives.append(primitive)
            primitive_kind_counts[primitive["kind"]] = primitive_kind_counts.get(primitive["kind"], 0) + 1
            layer = str(primitive.get("layer") or "0")
            layer_counts[layer] = layer_counts.get(layer, 0) + 1
        if problem:
            unsupported.append(problem)
            unsupported_type_counts[t] = unsupported_type_counts.get(t, 0) + 1

    bounds = bounds_union_lists(primitive_bbox(p) for p in primitives)
    overview = [p for p in primitives if p.get("kind") in {"line", "polyline", "circle", "arc"}][:2000]
    tile_file = "tiles/qtile-00000-r.json"
    tile_path = geometry_dir / tile_file
    tile_payload = {
        "schema": "tower.cad-geometry.quadtree-tile.v0-prototype",
        "version": VERSION,
        "sourcePath": str(input_path),
        "tile": {"index": 0, "key": "r", "depth": 0, "bounds": bounds, "reason": "phase-a-single-tile"},
        "primitiveCount": len(primitives),
        "primitiveKindCounts": primitive_kind_counts,
        "contentBounds": bounds,
        "primitives": primitives,
    }
    save_json(tile_payload, tile_path)
    overview_path = geometry_dir / "overview.json"
    save_json({"schema": "tower.cad-geometry.overview.v0-prototype", "sourcePath": str(input_path), "primitiveCount": len(overview), "primitives": overview}, overview_path)
    unsupported_path = geometry_dir / "unsupported-summary.json"
    save_json({"schema": "tower.cad-geometry.unsupported-summary.v0-prototype", "sourcePath": str(input_path), "unsupportedCount": len(unsupported), "unsupportedTypeCounts": unsupported_type_counts}, unsupported_path)
    tile_bytes = tile_path.stat().st_size
    manifest = {
        "schema": "tower.cad-geometry.quadtree-manifest.v0-prototype",
        "version": VERSION,
        "sourcePath": str(input_path),
        "sourceType": "dxf" if str(input_path).lower().endswith(".dxf") else "unknown",
        "bounds": bounds,
        "thresholds": {"maxPrimitives": max_primitives, "maxDepth": 0},
        "counts": {"topLevelEntities": len(entities), "primitives": len(primitives), "unsupported": len(unsupported), "layers": len(layer_counts), "tiles": 1, "overviewPrimitives": len(overview)},
        "typeCounts": type_counts,
        "primitiveKindCounts": primitive_kind_counts,
        "unsupportedTypeCounts": unsupported_type_counts,
        "overview": {"file": "overview.json", "primitiveCount": len(overview), "bytes": overview_path.stat().st_size},
        "unsupportedSummary": {"file": "unsupported-summary.json", "count": len(unsupported), "bytes": unsupported_path.stat().st_size},
        "tiles": [{"index": 0, "key": "r", "depth": 0, "file": tile_file, "bounds": bounds, "contentBounds": bounds, "primitiveCount": len(primitives), "primitiveKindCounts": primitive_kind_counts, "bytes": tile_bytes}],
        "tileStats": {"totalTileBytes": tile_bytes, "minTileBytes": tile_bytes, "maxTileBytes": tile_bytes, "avgTileBytes": tile_bytes, "maxPrimitiveCount": len(primitives), "depthCounts": {"0": 1}},
        "diagnostics": {"notes": ["Phase A product artifact uses one detail tile and top-level common primitives only.", "INSERT expansion/adaptive tiling are validated in cad-view experiments and will be promoted later."]},
    }
    manifest_path = geometry_dir / "manifest.json"
    save_json(manifest, manifest_path)
    return {
        "cad_geometry_manifest": str(manifest_path),
        "cad_geometry_overview": str(overview_path),
        "cad_geometry_unsupported_summary": str(unsupported_path),
        "cad_geometry_tile_dir": str(tiles_dir),
    }


def save_json(data: dict[str, Any], path: Path | None) -> None:
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if path:
        ensure_parent(path)
        path.write_text(text + "\n", "utf-8")
    else:
        print(text)


def center_rendered_png(raw_path: Path, output_path: Path, width: int, height: int) -> None:
    """Trim blank CAD margins and paste content centered on a stable canvas."""
    require_deps(image=True)
    img = Image.open(raw_path).convert("RGBA")
    rgb = img.convert("RGB")
    bg = Image.new("RGB", rgb.size, BACKGROUND_RGB)
    bbox = ImageChops.difference(rgb, bg).getbbox()
    if not bbox:
        img.resize((width, height)).save(output_path)
        return
    cropped = img.crop(bbox)
    max_w = max(1, int(width * 0.96))
    max_h = max(1, int(height * 0.96))
    scale = min(max_w / cropped.width, max_h / cropped.height)
    if scale != 1.0:
        cropped = cropped.resize((max(1, int(cropped.width * scale)), max(1, int(cropped.height * scale))), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (width, height), (*BACKGROUND_RGB, 255))
    canvas.alpha_composite(cropped, (max(0, (width - cropped.width) // 2), max(0, (height - cropped.height) // 2)))
    canvas.save(output_path)


def render_dxf(input_path: Path, output_path: Path, width: int, height: int, monochrome: bool, view: str) -> None:
    require_deps(render=True)
    font_path = configure_cad_fonts()
    doc, auditor = read_doc(input_path)
    force_render_font_styles(doc, font_path)
    if getattr(auditor, "has_errors", False):
        # Rendering may still work; leave this as a warning on stderr.
        print(f"WARN: DXF auditor reported {len(auditor.errors)} errors", file=sys.stderr)
    msp = doc.modelspace()
    fig = plt.figure(figsize=(width / 200, height / 200), dpi=200)
    ax = fig.add_axes([0, 0, 1, 1])
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    ax.set_aspect("equal")
    ax.axis("off")
    ctx = RenderContext(doc)
    backend = MatplotlibBackend(ax)
    config = Configuration(
        color_policy=ColorPolicy.BLACK if monochrome else ColorPolicy.COLOR,
        background_policy=BackgroundPolicy.WHITE,
    )
    Frontend(ctx, backend, config=config).draw_layout(msp, finalize=True)
    ax.autoscale()
    ax.margins(0.02)
    ensure_parent(output_path)
    raw_path = output_path.with_suffix(output_path.suffix + ".raw.png")
    fig.savefig(raw_path, dpi=200, facecolor=fig.get_facecolor())
    plt.close(fig)
    center_rendered_png(raw_path, output_path, width, height)
    try:
        raw_path.unlink()
    except OSError:
        pass


def recommended_ops(report: dict[str, Any], visual_metrics: dict[str, Any]) -> list[dict[str, Any]]:
    ops: list[dict[str, Any]] = []
    bounds = (report.get("bounds") or {}).get("modelspace")
    if bounds and (abs(float(bounds[0])) > 100_000 or abs(float(bounds[1])) > 100_000):
        ops.append({
            "op": "normalize_extents_copy",
            "target": "modelspace",
            "reason": "Modelspace bounds are far from origin; a copied normalized DXF can be easier for AI/tooling to preview and edit.",
            "safety": "copy-only; do not overwrite source; confirm with domain user before treating changed coordinates as engineering truth",
        })
    full = visual_metrics.get("full", {}) if visual_metrics else {}
    ratio = float(full.get("content_ratio", 0) or 0)
    margins = full.get("empty_margin", {}) or {}
    if ratio < 0.15 or max(float(margins.get(k, 0) or 0) for k in ("left", "top", "right", "bottom")) > 0.45:
        ops.append({
            "op": "create_centered_content_preview",
            "target": "preview",
            "reason": "Rendered drawing occupies a small central area or has large margins; content-fit preview improves review without changing DXF geometry.",
            "safety": "preview-only; source geometry unchanged",
        })
    if report.get("text_index"):
        ops.append({
            "op": "extract_text_index",
            "target": "TEXT/MTEXT entities",
            "reason": "Text entities are available for AI review, search, replacement, and translation workflows.",
            "safety": "read-only until an explicit replace_text/apply-ops step is requested",
        })
    if report.get("semantic_text_candidates"):
        ops.append({
            "op": "review_semantic_notes",
            "target": "risk/revision/long note text candidates",
            "reason": "The drawing contains note-like or review-like text that may drive estimate/revision decisions.",
            "safety": "read-only; human review recommended for engineering-critical notes",
        })
    return ops


def write_ai_brief(report: dict[str, Any], qa_result: dict[str, Any], path: Path) -> None:
    doc = report.get("document", {})
    counts = report.get("counts", {})
    bounds = (report.get("bounds") or {}).get("modelspace")
    layers = report.get("layer_summary", [])[:12]
    semantic = report.get("semantic_text_candidates", [])[:20]
    ops = qa_result.get("recommended_ops", [])
    warnings = qa_result.get("warnings", [])
    artifacts = qa_result.get("artifacts", {})

    lines: list[str] = []
    lines.append("# CAD Workbench AI Brief")
    lines.append("")
    lines.append(f"Source: `{report.get('source')}`")
    lines.append(f"Status: **{qa_result.get('status', 'unknown')}**")
    lines.append(f"Renderer: `{(qa_result.get('renderer') or {}).get('primary', 'unknown')}` ({(qa_result.get('renderer') or {}).get('fidelity', 'unknown')})")
    lines.append("")
    lines.append("## Drawing summary")
    lines.append(f"- DXF version: `{doc.get('dxf_version')}`")
    lines.append(f"- Units code: `{doc.get('units')}`")
    lines.append(f"- Layouts: {', '.join(doc.get('layouts', []))}")
    lines.append(f"- Entities: {counts.get('entities', 0)}; texts: {counts.get('texts', 0)}; dimensions: {counts.get('dimensions', 0)}; blocks: {counts.get('blocks', 0)}; layers: {counts.get('layers', 0)}")
    lines.append(f"- Modelspace bounds: `{bounds}`")
    lines.append("")
    lines.append("## Important layers")
    for layer in layers:
        hints = ", ".join(layer.get("role_hints") or []) or "unknown"
        lines.append(f"- `{layer.get('name')}` — {layer.get('entity_count')} entities; hints: {hints}; types: `{layer.get('type_counts')}`")
    if not layers:
        lines.append("- No layer summary available.")
    lines.append("")
    lines.append("## Text / note candidates")
    if semantic:
        for row in semantic:
            text = str(row.get("text", "")).replace("\n", " ")[:220]
            lines.append(f"- [{', '.join(row.get('tags') or [])}] layer `{row.get('layer')}` at `{row.get('insert')}`: {text}")
    else:
        lines.append("- No semantic text candidates detected.")
    lines.append("")
    lines.append("## QA warnings")
    if warnings:
        for warning in warnings:
            lines.append(f"- **{warning.get('severity', 'unknown')}** `{warning.get('code')}` — {warning.get('message')}")
    else:
        lines.append("- No QA warnings.")
    lines.append("")
    lines.append("## Recommended next operations")
    if ops:
        for op in ops:
            lines.append(f"- `{op.get('op')}` on `{op.get('target')}` — {op.get('reason')} Safety: {op.get('safety')}")
    else:
        lines.append("- No recommended operations.")
    lines.append("")
    lines.append("## Artifacts")
    for key, value in artifacts.items():
        lines.append(f"- {key}: `{value}`")
    lines.append("")
    lines.append("> CAD Workbench beta uses preview-grade open-stack rendering. Use native CAD/human review for construction-critical dimensions, tolerances, and sign-off.")
    ensure_parent(path)
    path.write_text("\n".join(lines) + "\n", "utf-8")


def image_metrics(path: Path) -> dict[str, Any]:
    require_deps(image=True)
    img = Image.open(path).convert("RGB")
    bg = Image.new("RGB", img.size, BACKGROUND_RGB)
    diff = ImageChops.difference(img, bg)
    bbox = diff.getbbox()
    width, height = img.size
    if not bbox:
        return {
            "image_size": [width, height],
            "content_bbox_px": None,
            "content_ratio": 0,
            "empty_margin": {"left": 1, "top": 1, "right": 1, "bottom": 1},
        }
    left, top, right, bottom = bbox
    content_area = max(0, right - left) * max(0, bottom - top)
    total_area = max(1, width * height)
    return {
        "image_size": [width, height],
        "content_bbox_px": [left, top, right, bottom],
        "content_ratio": round(content_area / total_area, 6),
        "empty_margin": {
            "left": round(left / width, 6),
            "top": round(top / height, 6),
            "right": round((width - right) / width, 6),
            "bottom": round((height - bottom) / height, 6),
        },
    }


def qa(input_path: Path, out_dir: Path, width: int, height: int) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    source_copy = out_dir / "source.dxf"
    if input_path.resolve() != source_copy.resolve():
        shutil.copyfile(input_path, source_copy)
    report = inspect_dxf(input_path)
    full_png = out_dir / "preview.full.png"
    content_png = out_dir / "preview.content.png"
    render_dxf(input_path, full_png, width, height, True, "full")
    render_dxf(input_path, content_png, width, height, True, "content")
    full_metrics = image_metrics(full_png)
    content_metrics = image_metrics(content_png)

    warnings = list(report.get("warnings", []))
    ratio = float(full_metrics.get("content_ratio", 0) or 0)
    margins = full_metrics.get("empty_margin", {}) or {}
    if ratio < 0.10:
        warnings.append({
            "code": "LOW_CONTENT_RATIO",
            "severity": "high",
            "message": f"Rendered content occupies only {ratio:.1%} of the preview image.",
        })
    if max(float(margins.get(k, 0) or 0) for k in ("left", "top", "right", "bottom")) > 0.55:
        warnings.append({
            "code": "UNBALANCED_EMPTY_MARGIN",
            "severity": "medium",
            "message": "Preview has a large empty margin on at least one side; content may appear shifted.",
        })

    text_index_path = out_dir / "text-index.json"
    layer_summary_path = out_dir / "layer-summary.json"
    block_index_path = out_dir / "block-index.json"
    candidate_report_path = out_dir / "candidate-report.json"
    cad_model_path = out_dir / "cad-model.json"
    candidate_report_md_path = out_dir / "candidate-report.md"
    rfq_intake_path = out_dir / "rfq-intake.md"
    ai_brief_path = out_dir / "ai-brief.md"
    cad_geometry_paths = write_cad_geometry_package(input_path, out_dir)
    visual_metrics = {
        "full": full_metrics,
        "content": content_metrics,
    }
    result = {
        **report,
        "renderer": {
            "primary": "ezdxf-matplotlib",
            "fidelity": "preview-grade",
            "license": "open-stack",
        },
        "artifacts": {
            "source": str(source_copy),
            "preview_full": str(full_png),
            "preview_content": str(content_png),
            "report": str(out_dir / "qa.json"),
            "ai_brief": str(ai_brief_path),
            "text_index": str(text_index_path),
            "layer_summary": str(layer_summary_path),
            "block_index": str(block_index_path),
            "candidate_report": str(candidate_report_path),
            "cad_model": str(cad_model_path),
            "candidate_report_md": str(candidate_report_md_path),
            "rfq_intake": str(rfq_intake_path),
            **cad_geometry_paths,
        },
        "visual_metrics": visual_metrics,
        "warnings": warnings,
        "status": "warning" if warnings else "passed",
    }
    result["recommended_ops"] = recommended_ops(report, visual_metrics)
    save_json(result, out_dir / "qa.json")
    save_json({"version": VERSION, "source": str(input_path), "texts": report.get("text_index", [])}, text_index_path)
    save_json({"version": VERSION, "source": str(input_path), "layers": report.get("layer_summary", [])}, layer_summary_path)
    block_result = block_index(input_path, block_index_path)
    candidate_result = candidate_report(input_path, candidate_report_path, candidate_report_md_path)
    save_json(build_minimal_cad_model(report, block_result, candidate_result, result["artifacts"]), cad_model_path)
    write_rfq_intake_report(candidate_result, rfq_intake_path)
    write_ai_brief(report, result, ai_brief_path)
    return result


def replace_text_entities(doc: Any, op: dict[str, Any], *, dry_run: bool = False) -> dict[str, Any]:
    kind = str(op.get("op") or "replace_text")
    handle = str(op.get("handle") or "").strip()
    handles = [str(h).strip().upper() for h in (op.get("handles") or []) if str(h).strip()]
    find = str(op.get("find") or "")
    replace = str(op.get("replace") or "")
    exact = bool(op.get("exact", True))
    layer = str(op.get("layer") or "").strip()
    max_matches_default = 1 if kind == "replace_text" and not handles else 10_000
    max_matches = int(op.get("max_matches", max_matches_default) or max_matches_default)
    if not handle and not handles and not find:
        raise SystemExit(f"{kind} requires handle, handles, or find")
    if replace == "":
        raise SystemExit(f"{kind} requires non-empty replace")

    changes: list[dict[str, Any]] = []
    for entity in doc.modelspace():
        if entity.dxftype() not in {"TEXT", "MTEXT"}:
            continue
        dxf = getattr(entity, "dxf", None)
        entity_handle = str(getattr(dxf, "handle", "")) if dxf is not None else ""
        entity_layer = str(getattr(dxf, "layer", "0")) if dxf is not None else "0"
        if handle and entity_handle.upper() != handle.upper():
            continue
        if handles and entity_handle.upper() not in handles:
            continue
        if layer and entity_layer != layer:
            continue
        before = entity_text_value(entity) or ""
        if find:
            if exact and before != find:
                continue
            if not exact and find not in before:
                continue
        after = replace if exact else before.replace(find, replace)
        if before == after:
            continue
        if not dry_run:
            if entity.dxftype() == "TEXT":
                entity.dxf.text = after
            else:
                entity.text = after
        changes.append({
            "handle": entity_handle,
            "layer": entity_layer,
            "type": entity.dxftype(),
            "before": before,
            "after": after,
            "insert": entity_insert_point(entity),
        })
        if len(changes) >= max_matches:
            break
    return {
        "op": kind,
        "dry_run": dry_run,
        "selector": {"handle": handle or None, "handles": handles or None, "find": find or None, "exact": exact, "layer": layer or None, "max_matches": max_matches},
        "changes": changes,
        "changed_count": len(changes),
        "risk": "medium" if len(changes) > 1 else "low",
    }


def write_change_report(log: dict[str, Any], path: Path) -> None:
    lines = ["# CAD Workbench Change Report", ""]
    lines.append(f"Source: `{log.get('source')}`")
    if log.get("output"):
        lines.append(f"Output: `{log.get('output')}`")
    lines.append(f"Mode: `{'dry-run' if log.get('dry_run') else 'apply'}`")
    lines.append("")
    for idx, result in enumerate(log.get("operations", []), 1):
        lines.append(f"## Operation {idx}: `{result.get('op')}`")
        lines.append(f"- Changed entities: `{result.get('changed_count', 0)}`")
        lines.append(f"- Risk: `{result.get('risk', 'unknown')}`")
        for change in result.get("changes", [])[:100]:
            before = str(change.get("before", "")).replace("\n", " ")
            after = str(change.get("after", "")).replace("\n", " ")
            lines.append(f"- `{change.get('handle')}` layer `{change.get('layer')}`: `{before}` → `{after}`")
        if result.get("changed_count", 0) > 100:
            lines.append(f"- ... {result.get('changed_count') - 100} more changes omitted")
        lines.append("")
    lines.append("> Original DXF is preserved. Apply operations only to an explicit output copy.")
    ensure_parent(path)
    path.write_text("\n".join(lines) + "\n", "utf-8")


def apply_ops(input_path: Path, ops_path: Path, output_path: Path | None, *, dry_run: bool = False) -> dict[str, Any]:
    if output_path is None and not dry_run:
        raise SystemExit("apply-ops requires --out unless --dry-run is set")
    doc, _auditor = read_doc(input_path)
    try:
        payload = json.loads(ops_path.read_text("utf-8"))
    except Exception as exc:
        raise SystemExit(f"Failed to read ops JSON: {ops_path}: {exc}")
    ops = payload.get("operations", payload if isinstance(payload, list) else [])
    if not isinstance(ops, list) or not ops:
        raise SystemExit("ops JSON must be a non-empty list or contain operations[]")

    before = inspect_dxf(input_path)
    results: list[dict[str, Any]] = []
    for op in ops:
        if not isinstance(op, dict):
            raise SystemExit("Each operation must be an object")
        kind = op.get("op")
        if kind in {"replace_text", "replace_text_many"}:
            results.append(replace_text_entities(doc, op, dry_run=dry_run))
        else:
            raise SystemExit(f"Unsupported operation: {kind}")

    if not any(result.get("changed_count", 0) for result in results):
        raise SystemExit("No entities changed; refusing to write output")
    log = {
        "version": VERSION,
        "source": str(input_path),
        "ops_file": str(ops_path),
        "output": str(output_path) if output_path else None,
        "dry_run": dry_run,
        "operations": results,
        "before_counts": before.get("counts"),
        "before_bounds": before.get("bounds"),
        "note": "Original DXF was preserved. Operations were applied only when dry_run is false.",
    }
    if dry_run:
        report_path = ops_path.with_suffix(ops_path.suffix + ".dry-run.md")
        log_path = ops_path.with_suffix(ops_path.suffix + ".dry-run.json")
        log["artifacts"] = {"dry_run_log": str(log_path), "change_report": str(report_path)}
        save_json(log, log_path)
        write_change_report(log, report_path)
        return log
    assert output_path is not None
    ensure_parent(output_path)
    doc.saveas(str(output_path))
    after = inspect_dxf(output_path)
    log["after_counts"] = after.get("counts")
    log["after_bounds"] = after.get("bounds")
    log_path = output_path.with_suffix(output_path.suffix + ".operation-log.json")
    report_path = output_path.with_suffix(output_path.suffix + ".change-report.md")
    log["artifacts"] = {"operation_log": str(log_path), "change_report": str(report_path)}
    save_json(log, log_path)
    write_change_report(log, report_path)
    return log


def normalize(input_path: Path, output_path: Path, margin: float) -> dict[str, Any]:
    doc, _auditor = read_doc(input_path)
    msp = doc.modelspace()
    entities = list(msp)
    bounds = union_bounds([b for e in entities if (b := finite_bbox(e)) is not None])
    if not bounds:
        raise SystemExit("Cannot normalize: no supported entity bounds detected")
    dx = margin - bounds.min_x
    dy = margin - bounds.min_y
    for entity in entities:
        try:
            entity.translate(dx, dy, 0)
        except Exception:
            # Some entities may not support translate; keep going but record partial.
            pass
    ensure_parent(output_path)
    doc.saveas(str(output_path))
    after = inspect_dxf(output_path).get("bounds", {}).get("modelspace")
    op = {
        "op": "normalize_extents",
        "source": str(input_path),
        "output": str(output_path),
        "dx": dx,
        "dy": dy,
        "margin": margin,
        "before_bounds": bounds.as_list(),
        "after_bounds": after,
        "note": "Entity translation is best-effort for supported DXF entities.",
    }
    log_path = output_path.with_suffix(output_path.suffix + ".operation-log.json")
    save_json({"version": VERSION, "operations": [op]}, log_path)
    return op


def text_table(input_path: Path, out_path: Path, fmt: str = "csv") -> dict[str, Any]:
    report = inspect_dxf(input_path)
    rows = report.get("text_index", [])
    ensure_parent(out_path)
    flat_rows: list[dict[str, Any]] = []
    for row in rows:
        insert = row.get("insert") or []
        flat_rows.append({
            "handle": row.get("handle", ""),
            "type": row.get("type", ""),
            "layer": row.get("layer", ""),
            "text": row.get("text", ""),
            "x": insert[0] if len(insert) > 0 else "",
            "y": insert[1] if len(insert) > 1 else "",
            "height": row.get("height", ""),
            "tags": ";".join(row.get("tags") or []),
        })
    if fmt == "json":
        save_json({"version": VERSION, "source": str(input_path), "texts": flat_rows}, out_path)
    else:
        with out_path.open("w", newline="", encoding="utf-8-sig") as fh:
            fieldnames = ["handle", "type", "layer", "text", "x", "y", "height", "tags"]
            writer = csv.DictWriter(fh, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(flat_rows)
    return {
        "version": VERSION,
        "source": str(input_path),
        "output": str(out_path),
        "format": fmt,
        "row_count": len(flat_rows),
        "columns": ["handle", "type", "layer", "text", "x", "y", "height", "tags"],
    }


def collect_changed_handles(log: dict[str, Any]) -> list[str]:
    handles: list[str] = []
    for result in log.get("operations", []) or []:
        for change in result.get("changes", []) or []:
            handle = str(change.get("handle") or "").strip().upper()
            if handle and handle not in handles:
                handles.append(handle)
    return handles


def entity_bounds_by_handle(input_path: Path, handles: list[str]) -> dict[str, Bounds]:
    doc, _auditor = read_doc(input_path)
    wanted = {h.upper() for h in handles}
    found: dict[str, Bounds] = {}
    for entity in doc.modelspace():
        dxf = getattr(entity, "dxf", None)
        handle = str(getattr(dxf, "handle", "") or "").upper() if dxf is not None else ""
        if handle not in wanted:
            continue
        bounds = finite_bbox(entity)
        if bounds is None:
            continue
        # TEXT fallback bboxes are often just insert points; add a conservative
        # label-sized box so highlights are visible and clickable in reports.
        if bounds.width == 0 and bounds.height == 0 and entity.dxftype() in {"TEXT", "MTEXT"}:
            text = entity_text_value(entity) or ""
            height_val = float(getattr(dxf, "height", 250) or 250) if dxf is not None else 250.0
            width_val = max(height_val * 3, height_val * 0.65 * max(1, len(text)))
            bounds = Bounds(bounds.min_x, bounds.min_y - height_val * 0.25, bounds.min_x + width_val, bounds.min_y + height_val * 1.1)
        found[handle] = bounds
    return found


def project_bounds_to_pixels(bounds: Bounds, content_bounds: Bounds, width: int, height: int) -> tuple[int, int, int, int]:
    if content_bounds.width <= 0 or content_bounds.height <= 0:
        return (0, 0, width, height)
    scale = min((width * 0.96) / content_bounds.width, (height * 0.96) / content_bounds.height)
    draw_w = content_bounds.width * scale
    draw_h = content_bounds.height * scale
    left_pad = (width - draw_w) / 2
    top_pad = (height - draw_h) / 2
    x1 = left_pad + (bounds.min_x - content_bounds.min_x) * scale
    x2 = left_pad + (bounds.max_x - content_bounds.min_x) * scale
    y1 = top_pad + (content_bounds.max_y - bounds.max_y) * scale
    y2 = top_pad + (content_bounds.max_y - bounds.min_y) * scale
    pad = max(8, int(min(width, height) * 0.006))
    return (
        max(0, int(min(x1, x2)) - pad),
        max(0, int(min(y1, y2)) - pad),
        min(width, int(max(x1, x2)) + pad),
        min(height, int(max(y1, y2)) + pad),
    )


def highlight_changes(input_path: Path, log_path: Path, out_path: Path, width: int, height: int) -> dict[str, Any]:
    require_deps(image=True)
    log = json.loads(log_path.read_text("utf-8"))
    handles = collect_changed_handles(log)
    if not handles:
        raise SystemExit("No changed handles found in log")
    base_path = Path(log.get("output") or input_path)
    render_dxf(base_path, out_path, width, height, True, "content")
    report = inspect_dxf(base_path)
    content_raw = (report.get("bounds") or {}).get("modelspace")
    if not content_raw:
        raise SystemExit("Cannot highlight: no modelspace bounds")
    content_bounds = Bounds(*[float(v) for v in content_raw])
    entity_bounds = entity_bounds_by_handle(base_path, handles)

    img = Image.open(out_path).convert("RGBA")
    overlay = Image.new("RGBA", img.size, (255, 255, 255, 0))
    draw = ImageDraw.Draw(overlay)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 24)
    except Exception:
        font = None
    highlights: list[dict[str, Any]] = []
    for idx, handle in enumerate(handles, 1):
        bounds = entity_bounds.get(handle)
        if bounds is None:
            continue
        rect = project_bounds_to_pixels(bounds, content_bounds, width, height)
        color = (239, 68, 68, 255)
        fill = (239, 68, 68, 34)
        draw.rectangle(rect, outline=color, width=max(3, width // 1000), fill=fill)
        label = f"{idx}:{handle}"
        tx, ty = rect[0], max(0, rect[1] - 28)
        draw.rectangle((tx, ty, tx + 12 * len(label) + 10, ty + 26), fill=(239, 68, 68, 220))
        draw.text((tx + 5, ty + 3), label, fill=(255, 255, 255, 255), font=font)
        highlights.append({"handle": handle, "bounds": bounds.as_list(), "rect_px": list(rect)})
    Image.alpha_composite(img, overlay).convert("RGB").save(out_path)
    result = {
        "version": VERSION,
        "source": str(input_path),
        "log": str(log_path),
        "base": str(base_path),
        "output": str(out_path),
        "handles": handles,
        "highlights": highlights,
    }
    save_json(result, out_path.with_suffix(out_path.suffix + ".json"))
    return result


def compare(before: Path, after: Path, out_dir: Path, width: int, height: int) -> dict[str, Any]:
    require_deps(image=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    before_png = out_dir / "before.png"
    after_png = out_dir / "after.png"
    diff_png = out_dir / "diff.png"
    render_dxf(before, before_png, width, height, True, "content")
    render_dxf(after, after_png, width, height, True, "content")
    a = Image.open(before_png).convert("RGB")
    b = Image.open(after_png).convert("RGB")
    if a.size != b.size:
        b = b.resize(a.size)
    diff = ImageChops.difference(a, b)
    diff.save(diff_png)
    summary = {
        "version": VERSION,
        "before": str(before),
        "after": str(after),
        "artifacts": {"before_png": str(before_png), "after_png": str(after_png), "diff_png": str(diff_png)},
        "before_metrics": image_metrics(before_png),
        "after_metrics": image_metrics(after_png),
        "diff_bbox_px": list(diff.getbbox()) if diff.getbbox() else None,
    }
    save_json(summary, out_dir / "summary.json")
    return summary


def make_fixture(path: Path) -> None:
    require_deps()
    doc = ezdxf.new("R2010")
    doc.units = 4  # mm
    msp = doc.modelspace()
    # Deliberately far from origin to exercise QA and normalize.
    x0, y0 = 120_000, -83_000
    msp.add_lwpolyline([(x0, y0), (x0 + 7000, y0), (x0 + 7000, y0 + 3200), (x0, y0 + 3200), (x0, y0)], dxfattribs={"layer": "EQUIPMENT"})
    for i in range(5):
        y = y0 + 500 + i * 450
        msp.add_line((x0 + 600, y), (x0 + 6200, y), dxfattribs={"layer": "DUCT"})
        msp.add_text(f"FEEDER-{i+1}", dxfattribs={"height": 180, "layer": "TEXT"}).set_placement((x0 + 700, y + 60))
    msp.add_text("CAD WORKBENCH FIXTURE", dxfattribs={"height": 260, "layer": "TITLE"}).set_placement((x0 + 300, y0 + 2850))
    ensure_parent(path)
    doc.saveas(str(path))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Tower CAD Workbench MVP")
    parser.add_argument("--version", action="version", version=VERSION)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("inspect", help="Inspect DXF structure and bounds")
    p.add_argument("input", type=Path)
    p.add_argument("--out", type=Path)

    p = sub.add_parser("render", help="Render DXF to PNG")
    p.add_argument("input", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--view", choices=["full", "content"], default="content")
    p.add_argument("--width", type=int, default=2400)
    p.add_argument("--height", type=int, default=1800)
    p.add_argument("--color", action="store_true")

    p = sub.add_parser("qa", help="Run inspect + preview render + image metrics")
    p.add_argument("input", type=Path)
    p.add_argument("--out-dir", type=Path, required=True)
    p.add_argument("--width", type=int, default=2400)
    p.add_argument("--height", type=int, default=1800)

    p = sub.add_parser("normalize", help="Translate modelspace content near origin")
    p.add_argument("input", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--margin", type=float, default=0.0)

    p = sub.add_parser("apply-ops", help="Apply or dry-run safe operation JSON to a copied DXF")
    p.add_argument("input", type=Path)
    p.add_argument("--ops", type=Path, required=True)
    p.add_argument("--out", type=Path)
    p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("text-table", help="Export TEXT/MTEXT index as CSV or JSON table")
    p.add_argument("input", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--format", choices=["csv", "json"], default="csv")

    p = sub.add_parser("block-index", help="Export INSERT/block references and ATTRIB values as JSON")
    p.add_argument("input", type=Path)
    p.add_argument("--out", type=Path, required=True)

    p = sub.add_parser("candidate-report", help="Detect equipment/title/revision/risk candidates from text and blocks")
    p.add_argument("input", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--markdown", type=Path)

    p = sub.add_parser("cad-model", help="Export a minimal Normalized CAD Model JSON artifact")
    p.add_argument("input", type=Path)
    p.add_argument("--out", type=Path, required=True)

    p = sub.add_parser("rfq-intake", help="Create an AI-thread-ready RFQ intake markdown with cad-evidence from candidate report")
    p.add_argument("input", type=Path)
    p.add_argument("--out", type=Path, required=True)

    p = sub.add_parser("compare", help="Render before/after and produce diff summary")
    p.add_argument("before", type=Path)
    p.add_argument("after", type=Path)
    p.add_argument("--out-dir", type=Path, required=True)
    p.add_argument("--width", type=int, default=2400)
    p.add_argument("--height", type=int, default=1800)

    p = sub.add_parser("highlight", help="Render a preview with changed handles highlighted")
    p.add_argument("input", type=Path)
    p.add_argument("--log", type=Path, required=True, help="operation-log.json or dry-run.json")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--width", type=int, default=2400)
    p.add_argument("--height", type=int, default=1800)

    p = sub.add_parser("make-fixture", help="Create a small far-origin DXF fixture")
    p.add_argument("--out", type=Path, required=True)

    args = parser.parse_args(argv)
    if args.cmd == "inspect":
        save_json(inspect_dxf(args.input), args.out)
    elif args.cmd == "render":
        render_dxf(args.input, args.out, args.width, args.height, not args.color, args.view)
    elif args.cmd == "qa":
        save_json(qa(args.input, args.out_dir, args.width, args.height), None)
    elif args.cmd == "normalize":
        save_json(normalize(args.input, args.out, args.margin), None)
    elif args.cmd == "apply-ops":
        save_json(apply_ops(args.input, args.ops, args.out, dry_run=args.dry_run), None)
    elif args.cmd == "text-table":
        save_json(text_table(args.input, args.out, args.format), None)
    elif args.cmd == "block-index":
        save_json(block_index(args.input, args.out), None)
    elif args.cmd == "candidate-report":
        save_json(candidate_report(args.input, args.out, args.markdown), None)
    elif args.cmd == "cad-model":
        report = inspect_dxf(args.input)
        blocks = block_index(args.input)
        candidates = candidate_report(args.input)
        save_json(build_minimal_cad_model(report, blocks, candidates), args.out)
    elif args.cmd == "rfq-intake":
        save_json(rfq_intake(args.input, args.out), None)
    elif args.cmd == "compare":
        save_json(compare(args.before, args.after, args.out_dir, args.width, args.height), None)
    elif args.cmd == "highlight":
        save_json(highlight_changes(args.input, args.log, args.out, args.width, args.height), None)
    elif args.cmd == "make-fixture":
        make_fixture(args.out)
        print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
