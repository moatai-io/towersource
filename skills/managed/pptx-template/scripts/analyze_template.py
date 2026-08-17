#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "lxml>=4.9",
#   "python-pptx>=1.0",
# ]
# ///
"""
analyze_template.py — Extract a yaml theme from a user-provided brand .pptx.

Reads master + theme xml to recover:
  • color palette (dk1, lt1, accent1~6)
  • font scheme (latin / east-asian / 한글 폰트)
  • slide size (16:9 vs 4:3)
  • layout names + placeholder geometry (informational)

Outputs a yaml fragment that can be pasted into pptx-template data.yaml.

Usage:
    python3 analyze_template.py <brand.pptx> [--json] [--full]
"""

import argparse
import json
import sys
import re
from pathlib import Path
from collections import Counter

try:
    from pptx import Presentation
    from pptx.oxml.ns import qn
    from lxml import etree
    import zipfile
except ImportError:
    print("ERROR: python-pptx not installed.", file=sys.stderr)
    sys.exit(2)


def load_theme_xml(pptx_path):
    """Read ppt/theme/theme1.xml directly from the pptx zip — most reliable."""
    with zipfile.ZipFile(pptx_path, "r") as z:
        # PPTX 표준: theme1.xml — 또는 첫 master 의 theme
        candidates = [n for n in z.namelist()
                      if n.startswith("ppt/theme/") and n.endswith(".xml")]
        if not candidates:
            return None
        candidates.sort()  # theme1.xml 먼저
        with z.open(candidates[0]) as f:
            return etree.fromstring(f.read())


# ---------- Color extraction ----------

def _scheme_color_value(scheme_elem, child_tag):
    """Resolve a scheme color to a hex string."""
    el = scheme_elem.find(qn(f"a:{child_tag}"))
    if el is None:
        return None
    # Look for srgbClr (direct hex)
    srgb = el.find(qn("a:srgbClr"))
    if srgb is not None:
        return srgb.get("val", "").upper()
    # sysClr — system color (windowText / window)
    sys_clr = el.find(qn("a:sysClr"))
    if sys_clr is not None:
        last = sys_clr.get("lastClr")
        if last:
            return last.upper()
        # well-known
        v = sys_clr.get("val", "")
        return {"windowText": "000000", "window": "FFFFFF"}.get(v, None)
    return None


def extract_color_scheme(theme_root):
    """Return dict of scheme color name → hex from theme.xml root."""
    out = {}
    if theme_root is None:
        return out
    scheme = theme_root.find(".//" + qn("a:clrScheme"))
    if scheme is None:
        return out

    out["scheme_name"] = scheme.get("name", "")
    for tag in ("dk1", "lt1", "dk2", "lt2",
                "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
                "hlink", "folHlink"):
        v = _scheme_color_value(scheme, tag)
        if v:
            out[tag] = v
    return out


def extract_font_scheme(theme_root):
    """Return major/minor font info from theme.xml root."""
    out = {}
    if theme_root is None:
        return out
    scheme = theme_root.find(".//" + qn("a:fontScheme"))
    if scheme is None:
        return out

    out["scheme_name"] = scheme.get("name", "")
    for kind in ("majorFont", "minorFont"):
        f = scheme.find(qn(f"a:{kind}"))
        if f is None:
            continue
        latin = f.find(qn("a:latin"))
        ea = f.find(qn("a:ea"))
        cs = f.find(qn("a:cs"))
        out[f"{kind}_latin"] = latin.get("typeface", "") if latin is not None else ""
        out[f"{kind}_ea"]    = ea.get("typeface", "")    if ea is not None    else ""
        out[f"{kind}_cs"]    = cs.get("typeface", "")    if cs is not None    else ""

    return out


# ---------- Color usage analysis (heuristic) ----------

def collect_used_colors(prs, max_slides=20):
    """Walk shapes, collect direct srgbClr values (heuristic — used colors)."""
    used = Counter()
    for i, slide in enumerate(prs.slides):
        if i >= max_slides:
            break
        for shape in slide.shapes:
            try:
                # Look for any a:srgbClr inside this shape's xml
                el = shape._element
                for srgb in el.iter(qn("a:srgbClr")):
                    val = srgb.get("val", "").upper()
                    if val and re.fullmatch(r"[0-9A-F]{6}", val):
                        used[val] += 1
            except Exception:
                pass
    return used


# ---------- Layout / placeholder catalog ----------

def list_layouts(prs):
    """Return list of {name, placeholders: [...]}."""
    out = []
    if not prs.slide_masters:
        return out
    master = prs.slide_masters[0]
    for layout in master.slide_layouts:
        phs = []
        for ph in layout.placeholders:
            try:
                phs.append({
                    "idx": ph.placeholder_format.idx,
                    "type": str(ph.placeholder_format.type)
                            if ph.placeholder_format.type else None,
                    "name": ph.name,
                    "left_in":  round(ph.left.inches,  2) if ph.left  is not None else None,
                    "top_in":   round(ph.top.inches,   2) if ph.top   is not None else None,
                    "width_in": round(ph.width.inches, 2) if ph.width is not None else None,
                    "height_in":round(ph.height.inches,2) if ph.height is not None else None,
                })
            except Exception:
                pass
        out.append({"name": layout.name, "placeholders": phs})
    return out


# ---------- yaml mapping (heuristic) ----------

def to_yaml_theme(palette, font_scheme, used_colors):
    """Map extracted scheme + usage to pptx-template theme yaml."""
    # Default fallback (current v0.4)
    theme = {
        "primary": "0F2748",
        "accent":  "C9A961",
        "text":    "1A1A1A",
        "muted":   "6E6E73",
        "bg":      "FFFFFF",
        "panel":   "F5F3EE",
        "border":  "D6D2C8",
        "subtle":  "B8945F",
        "font":    "Noto Sans CJK KR",
        "bullet_char": "•",
    }

    # Map scheme colors
    if "dk1" in palette and palette["dk1"] not in ("000000",):
        theme["primary"] = palette["dk1"]
    elif "dk2" in palette:
        theme["primary"] = palette["dk2"]

    if "accent1" in palette:
        theme["accent"] = palette["accent1"]
    if "accent2" in palette:
        theme["subtle"] = palette["accent2"]

    if "lt1" in palette and palette["lt1"] != "FFFFFF":
        theme["bg"] = palette["lt1"]
    if "lt2" in palette:
        theme["panel"] = palette["lt2"]

    # Font: prefer East-Asian for Korean documents
    minor_ea = font_scheme.get("minorFont_ea", "")
    minor_latin = font_scheme.get("minorFont_latin", "")
    if minor_ea and minor_ea not in ("+mn-ea", ""):
        theme["font"] = minor_ea
    elif minor_latin and minor_latin not in ("+mn-lt", ""):
        # Fallback to latin if EA missing (English deck)
        theme["font"] = minor_latin

    return theme


# ---------- Main ----------

def main():
    ap = argparse.ArgumentParser(
        description="Analyze a brand .pptx → yaml theme for pptx-template")
    ap.add_argument("path", help="Path to brand .pptx")
    ap.add_argument("--json", action="store_true", help="Output full JSON (debug)")
    ap.add_argument("--full", action="store_true",
                    help="Include raw scheme + layouts in human output")
    args = ap.parse_args()

    p = Path(args.path)
    if not p.exists():
        print(f"ERROR: file not found: {p}", file=sys.stderr)
        sys.exit(1)

    prs = Presentation(p)
    theme_root = load_theme_xml(p)
    palette = extract_color_scheme(theme_root)
    fonts = extract_font_scheme(theme_root)
    used = collect_used_colors(prs)
    layouts = list_layouts(prs)

    theme = to_yaml_theme(palette, fonts, used)

    result = {
        "file": str(p),
        "slide_size_in": {
            "w": round(prs.slide_width.inches, 2),
            "h": round(prs.slide_height.inches, 2),
            "is_widescreen": abs(prs.slide_width.inches / prs.slide_height.inches - 16/9) < 0.05,
        },
        "slide_count": len(prs.slides),
        "scheme_palette": palette,
        "font_scheme": fonts,
        "top_used_colors": dict(used.most_common(10)),
        "layouts": layouts,
        "extracted_theme": theme,
    }

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    # Human-friendly
    print(f"📄 {p.name}")
    print(f"   Size: {result['slide_size_in']['w']}×{result['slide_size_in']['h']} in"
          f" ({'16:9' if result['slide_size_in']['is_widescreen'] else 'other'}) "
          f" |  Slides: {result['slide_count']}")
    print()

    print("━━ Theme palette (from theme.xml clrScheme)")
    if palette:
        for k, v in palette.items():
            if k == "scheme_name":
                print(f"   scheme_name: {v}")
            else:
                print(f"   {k:8s} = #{v}")
    else:
        print("   ⚠️  clrScheme 추출 실패 (master.xml 에서 못 찾음)")
    print()

    print("━━ Font scheme (theme.xml fontScheme)")
    if fonts:
        for k, v in fonts.items():
            if v:
                print(f"   {k:18s} = {v}")
    else:
        print("   ⚠️  fontScheme 추출 실패")
    print()

    print("━━ Top used colors (heuristic — 슬라이드에서 직접 사용된 색)")
    if used:
        for color, count in used.most_common(8):
            print(f"   #{color}  ({count}회)")
    else:
        print("   사용된 색상 없음 (master 만 사용 또는 빈 deck)")
    print()

    if args.full:
        print(f"━━ Layouts ({len(layouts)}개)")
        for lay in layouts:
            ph_count = len(lay["placeholders"])
            print(f"   {lay['name']:30s} ({ph_count} placeholders)")
        print()

    print("━━ ✨ 추출된 yaml theme (pptx-template data.yaml 의 theme: 섹션에 붙여넣기)")
    print()
    print("theme:")
    for k, v in theme.items():
        if isinstance(v, str):
            print(f'  {k}: "{v}"')
        else:
            print(f"  {k}: {v}")
    print()
    print("# 빌드:")
    print("#   uv run --script /workspace/.tower/skills/pptx-template/scripts/build_from_yaml.py \\")
    print("#     --data <your-data.yaml> --out <output.pptx>")


if __name__ == "__main__":
    main()
