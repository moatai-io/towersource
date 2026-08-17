#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "lxml>=4.9",
#   "python-pptx>=1.0",
#   "pyyaml>=6.0",
# ]
# ///
"""
build_from_yaml.py — Build a Korean-style B2B/consulting .pptx from YAML data.

v0.3 — 한국식 컨설팅 슬라이드 톤 (한투운용 / PwC 한국 / demo-org 패턴)
   • 헤더 바 (회사명 · 프로젝트 · 챕터)
   • One-line takeaway (제목 아래 결론 한 줄)
   • 하단 footer 바 (출처 · 페이지 · 대외비)
   • Insight 콜아웃 박스
   • 목차(toc) · 3단 분할(split) · 두문(cover_short) layout
   • Section 페이지 + 챕터 진행 트래커
   • Bullet 마커 선택 (▶ ● ◆ • 등)

Usage:
    python3 build_from_yaml.py --data data.yaml --out output.pptx [--template template.pptx]
"""

import argparse
import sys
import difflib
from pathlib import Path

try:
    import yaml
except ImportError:
    print("ERROR: pyyaml not installed.", file=sys.stderr)
    sys.exit(2)

try:
    from pptx import Presentation
    from pptx.util import Inches, Pt, Emu
    from pptx.dml.color import RGBColor
    from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.oxml.ns import qn
    from lxml import etree
except ImportError:
    print("ERROR: python-pptx not installed.", file=sys.stderr)
    sys.exit(2)


# ============================== Theme ==============================

DEFAULT_THEME = {
    # v0.4 — 한국 엘리트 컨설팅 톤 (한투운용·Bain Korea·PwC 한국)
    # Deep midnight navy + champagne gold + warm off-white
    "primary": "0F2748",   # Deep midnight navy — 더 깊고 무게감 있음 (이전 1F3A68 보다)
    "accent":  "C9A961",   # Champagne gold — fund management 톤 (이전 F5A623 오렌지보다 고급)
    "text":    "1A1A1A",   # Pure dark (이전 222222)
    "muted":   "6E6E73",   # Apple gray (이전 6B7280)
    "bg":      "FFFFFF",
    "panel":   "F5F3EE",   # Warm off-white (이전 cool F5F7FA)
    "border":  "D6D2C8",   # Warm gray (이전 D1D5DB)
    "subtle":  "B8945F",   # Muted gold for secondary accents
    "font":    "Noto Sans CJK KR",
    "bullet_char": "•",
}


def hex_to_rgb(s):
    s = s.lstrip("#")
    return RGBColor.from_string(s)


def hex_blend(hex_color, alpha):
    """Blend hex_color toward white. alpha=1.0=full color, 0.0=white."""
    s = hex_color.lstrip("#")
    r = int(s[0:2], 16); g = int(s[2:4], 16); b = int(s[4:6], 16)
    r = int(r * alpha + 255 * (1 - alpha))
    g = int(g * alpha + 255 * (1 - alpha))
    b = int(b * alpha + 255 * (1 - alpha))
    return f"{r:02X}{g:02X}{b:02X}"


def normalize_theme(t):
    out = dict(DEFAULT_THEME)
    if t:
        for k, v in t.items():
            out[k] = v
    return out


# ============================== Geometry ==============================

SLIDE_W = Inches(13.333)   # 16:9
SLIDE_H = Inches(7.5)

# Korean-style chrome: top header + bottom footer (thin)
HEADER_TOP    = 0.10
HEADER_LINE_Y = 0.40   # 헤더 가로선 위치
CONTENT_TOP   = 0.55   # 헤더 아래 콘텐츠 시작 가능 y
CONTENT_BOT   = 6.95   # 푸터 위 콘텐츠 끝 y
FOOTER_LINE_Y = 7.00   # 푸터 가로선 위치
FOOTER_TEXT_Y = 7.10


def set_slide_size(prs):
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H


def add_blank_slide(prs):
    blank = prs.slide_layouts[6]
    return prs.slides.add_slide(blank)


# ============================== Primitives ==============================

def fill_bg(slide, hex_color):
    bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, SLIDE_W, SLIDE_H)
    bg.fill.solid()
    bg.fill.fore_color.rgb = hex_to_rgb(hex_color)
    bg.line.fill.background()
    sp = bg._element
    sp.getparent().remove(sp)
    sp_tree = slide.shapes._spTree
    sp_tree.insert(2, sp)
    return bg


def add_text(slide, left, top, width, height, text, *,
             font_name="Noto Sans CJK KR", size=18, bold=False,
             color="222222", align=None, anchor=None):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    if anchor is not None:
        tf.vertical_anchor = anchor
    p = tf.paragraphs[0]
    if align is not None:
        p.alignment = align
    run = p.add_run()
    run.text = text
    run.font.name = font_name
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = hex_to_rgb(color)
    return box


def add_rect(slide, left, top, width, height, fill_hex, line_hex=None):
    rect = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    rect.fill.solid()
    rect.fill.fore_color.rgb = hex_to_rgb(fill_hex)
    if line_hex is None:
        rect.line.fill.background()
    else:
        rect.line.color.rgb = hex_to_rgb(line_hex)
        rect.line.width = Pt(0.75)
    return rect


def add_hline(slide, x_in, y_in, w_in, color_hex, thickness_pt=0.5):
    """Thin horizontal line (rendered as a 1-pt-tall rectangle)."""
    line = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE,
        Inches(x_in), Inches(y_in),
        Inches(w_in), Pt(thickness_pt)
    )
    line.fill.solid()
    line.fill.fore_color.rgb = hex_to_rgb(color_hex)
    line.line.fill.background()
    return line


def _apply_native_bullet(paragraph, char="•", bullet_color_hex=None,
                          marL_pt=24, indent_pt=24):
    """Native PPTX bullet via <a:pPr> (alignment-stable across glyphs)."""
    p_elem = paragraph._p
    pPr = p_elem.find(qn("a:pPr"))
    if pPr is None:
        pPr = p_elem.makeelement(qn("a:pPr"), {})
        p_elem.insert(0, pPr)

    EMU_PER_PT = 12700
    pPr.set("marL", str(int(marL_pt * EMU_PER_PT)))
    pPr.set("indent", str(int(-indent_pt * EMU_PER_PT)))

    for tag in ("a:buNone", "a:buChar", "a:buAutoNum",
                "a:buFont", "a:buClr", "a:buSzPct", "a:buSzPts"):
        for el in pPr.findall(qn(tag)):
            pPr.remove(el)

    if bullet_color_hex:
        buClr = etree.SubElement(pPr, qn("a:buClr"))
        srgb = etree.SubElement(buClr, qn("a:srgbClr"))
        srgb.set("val", bullet_color_hex.lstrip("#").upper())
    buFont = etree.SubElement(pPr, qn("a:buFont"))
    buFont.set("typeface", "Arial")
    buChar = etree.SubElement(pPr, qn("a:buChar"))
    buChar.set("char", char)


def add_bullets_box(slide, left, top, width, height, bullets, *,
                    font_name="Noto Sans CJK KR", size=22, color="222222",
                    bullet_color=None, bullet_char="•"):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    for i, item in enumerate(bullets):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = PP_ALIGN.LEFT
        run = p.add_run()
        run.text = str(item)
        run.font.name = font_name
        run.font.size = Pt(size)
        run.font.color.rgb = hex_to_rgb(color)
        p.space_after = Pt(8)
        _apply_native_bullet(p, char=bullet_char, bullet_color_hex=bullet_color)
    return box


# ============================== Korean Chrome ==============================

def add_header_bar(slide, theme, meta, slide_data):
    """Top header: company (left) · project · chapter (center) · confidential (right)."""
    company = meta.get("company", "")
    project_short = meta.get("project_short", "")
    chapter = slide_data.get("chapter", "")
    confidential = meta.get("confidential", "")

    line_color = hex_blend(theme["muted"], 0.4)
    add_hline(slide, 0.5, HEADER_LINE_Y, 12.333, line_color, thickness_pt=0.5)

    if company:
        add_text(slide, Inches(0.5), Inches(HEADER_TOP), Inches(4.0), Inches(0.27),
                 company, font_name=theme["font"], size=10, bold=True,
                 color=theme["primary"], align=PP_ALIGN.LEFT,
                 anchor=MSO_ANCHOR.MIDDLE)

    parts = [p for p in [project_short, chapter] if p]
    if parts:
        center = "  ·  ".join(parts)
        add_text(slide, Inches(4.5), Inches(HEADER_TOP), Inches(4.333), Inches(0.27),
                 center, font_name=theme["font"], size=10,
                 color=theme["muted"], align=PP_ALIGN.CENTER,
                 anchor=MSO_ANCHOR.MIDDLE)

    if confidential:
        add_text(slide, Inches(9.0), Inches(HEADER_TOP), Inches(3.833), Inches(0.27),
                 confidential, font_name=theme["font"], size=9, bold=True,
                 color=theme["accent"], align=PP_ALIGN.RIGHT,
                 anchor=MSO_ANCHOR.MIDDLE)


def add_footer_bar(slide, theme, meta, slide_data, page_num, total):
    """Bottom footer: source (left) · page (right)."""
    source = slide_data.get("source", meta.get("source_default", ""))
    line_color = hex_blend(theme["muted"], 0.4)
    add_hline(slide, 0.5, FOOTER_LINE_Y, 12.333, line_color, thickness_pt=0.5)

    if source:
        add_text(slide, Inches(0.5), Inches(FOOTER_TEXT_Y), Inches(9.0), Inches(0.3),
                 f"* 자료: {source}", font_name=theme["font"], size=9,
                 color=theme["muted"], align=PP_ALIGN.LEFT)

    if page_num is not None and total is not None:
        add_text(slide, Inches(11.0), Inches(FOOTER_TEXT_Y), Inches(1.833), Inches(0.3),
                 f"{page_num:02d} / {total:02d}",
                 font_name=theme["font"], size=10,
                 color=theme["muted"], align=PP_ALIGN.RIGHT)


def add_chrome(slide, theme, meta, slide_data, page_num, total):
    add_header_bar(slide, theme, meta, slide_data)
    add_footer_bar(slide, theme, meta, slide_data, page_num, total)


# ============================== Composition Helpers ==============================

def _draw_title_bar(slide, theme, title, top=CONTENT_TOP + 0.1):
    """Standard content slide title: orange tab + bold navy title."""
    add_rect(slide, Inches(0.8), Inches(top), Inches(0.15), Inches(0.7), theme["accent"])
    add_text(slide, Inches(1.1), Inches(top - 0.1), Inches(11.0), Inches(0.9),
             title, font_name=theme["font"], size=28, bold=True,
             color=theme["primary"], align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE)


def add_takeaway(slide, theme, takeaway, top_y):
    """One-line conclusion right under the title — the 'so what'."""
    add_text(slide, Inches(1.1), Inches(top_y), Inches(11.5), Inches(0.4),
             "▶  " + takeaway, font_name=theme["font"], size=14, bold=True,
             color=theme["accent"], align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE)


def add_insight(slide, theme, insight_text, label="결론"):
    """Bottom callout box ('Insight' / '결론' style)."""
    box_top = 6.10
    box_h = 0.65
    add_rect(slide, Inches(0.8), Inches(box_top), Inches(0.12), Inches(box_h), theme["accent"])
    add_rect(slide, Inches(0.92), Inches(box_top), Inches(11.41), Inches(box_h),
             theme["panel"])
    add_text(slide, Inches(1.10), Inches(box_top), Inches(1.2), Inches(box_h),
             label, font_name=theme["font"], size=13, bold=True,
             color=theme["accent"], align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE)
    add_text(slide, Inches(2.30), Inches(box_top), Inches(9.9), Inches(box_h),
             insight_text, font_name=theme["font"], size=13,
             color=theme["text"], align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE)


def _content_top(takeaway):
    """Y where main content starts (1.55 if no takeaway, 2.05 if takeaway)."""
    return 2.05 if takeaway else 1.55


def _content_bot(insight):
    """Y where main content ends (5.95 if insight, 6.85 if no insight)."""
    return 5.95 if insight else 6.85


# ============================== Layouts ==============================

# ---------- Cover layouts ----------

def render_title(slide, data, theme, meta):
    """Hero cover (dark navy)."""
    fill_bg(slide, theme["primary"])
    add_rect(slide, Inches(0), Inches(2.6), Inches(0.4), Inches(2.3), theme["accent"])

    title = data.get("title", meta.get("title", ""))
    subtitle = data.get("subtitle", meta.get("subtitle", ""))
    presenter = data.get("presenter", meta.get("presenter", ""))
    date = data.get("date", meta.get("date", ""))
    confidential = meta.get("confidential", "")

    add_text(slide, Inches(1.0), Inches(2.5), Inches(11.5), Inches(1.3),
             title, font_name=theme["font"], size=54, bold=True, color="FFFFFF",
             align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE)
    if subtitle:
        add_text(slide, Inches(1.0), Inches(3.8), Inches(11.5), Inches(0.7),
                 subtitle, font_name=theme["font"], size=24, color="D6CDB8",
                 align=PP_ALIGN.LEFT)
    foot = " · ".join(filter(None, [presenter, date]))
    if foot:
        add_text(slide, Inches(1.0), Inches(6.5), Inches(11.5), Inches(0.5),
                 foot, font_name=theme["font"], size=14, color="8A7E68",
                 align=PP_ALIGN.LEFT)
    if confidential:
        add_text(slide, Inches(10.5), Inches(0.4), Inches(2.5), Inches(0.4),
                 confidential, font_name=theme["font"], size=11, bold=True,
                 color=theme["accent"], align=PP_ALIGN.RIGHT)


def render_cover_short(slide, data, theme, meta):
    """Pre-cover '두문' — single-line value proposition + presenter only."""
    fill_bg(slide, theme["bg"])
    headline = data.get("headline", "")
    subline = data.get("subline", "")
    presenter = data.get("presenter", meta.get("presenter", ""))
    date = data.get("date", meta.get("date", ""))

    add_rect(slide, Inches(0.8), Inches(3.25), Inches(0.2), Inches(1.0), theme["accent"])
    add_text(slide, Inches(1.2), Inches(3.0), Inches(11.0), Inches(0.6),
             "PROPOSAL", font_name=theme["font"], size=12, bold=True,
             color=theme["accent"], align=PP_ALIGN.LEFT)
    add_text(slide, Inches(1.2), Inches(3.4), Inches(11.0), Inches(1.0),
             headline, font_name=theme["font"], size=32, bold=True,
             color=theme["primary"], align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE)
    if subline:
        add_text(slide, Inches(1.2), Inches(4.4), Inches(11.0), Inches(0.5),
                 subline, font_name=theme["font"], size=18,
                 color=theme["muted"], align=PP_ALIGN.LEFT)
    foot = " · ".join(filter(None, [presenter, date]))
    if foot:
        add_text(slide, Inches(1.2), Inches(6.6), Inches(11.0), Inches(0.4),
                 foot, font_name=theme["font"], size=12,
                 color=theme["muted"], align=PP_ALIGN.LEFT)


def render_section(slide, data, theme, meta):
    """Chapter divider with big number + title + (optional) progress tracker."""
    fill_bg(slide, theme["bg"])
    number = data.get("number", "")
    title = data.get("title", "")
    caption = data.get("caption", "")
    chapters = meta.get("chapters", [])  # ["01. 왜", "02. 무엇", ...]
    current_idx = data.get("chapter_idx")  # 0-based; auto-derived below if absent

    if number:
        add_text(slide, Inches(0.8), Inches(1.0), Inches(6.0), Inches(3.5),
                 str(number), font_name=theme["font"], size=200, bold=True,
                 color=theme["accent"], align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE)
    add_text(slide, Inches(0.8), Inches(4.5), Inches(11.5), Inches(1.2),
             title, font_name=theme["font"], size=44, bold=True,
             color=theme["primary"], align=PP_ALIGN.LEFT)
    if caption:
        add_text(slide, Inches(0.8), Inches(5.7), Inches(11.5), Inches(0.7),
                 caption, font_name=theme["font"], size=20, color=theme["muted"],
                 align=PP_ALIGN.LEFT)

    # Progress tracker (each chapter as a small bar; current is accent, others muted)
    if chapters and current_idx is not None and 0 <= current_idx < len(chapters):
        n = len(chapters)
        bar_total_w = 11.7
        bar_gap = 0.15
        bar_w = (bar_total_w - bar_gap * (n - 1)) / n
        bar_y = 7.1
        for i, ch in enumerate(chapters):
            x = 0.8 + i * (bar_w + bar_gap)
            color = theme["accent"] if i == current_idx else hex_blend(theme["muted"], 0.3)
            add_rect(slide, Inches(x), Inches(bar_y), Inches(bar_w), Inches(0.06), color)
            label_color = theme["primary"] if i == current_idx else theme["muted"]
            add_text(slide, Inches(x), Inches(bar_y + 0.12), Inches(bar_w), Inches(0.25),
                     ch, font_name=theme["font"], size=9,
                     bold=(i == current_idx),
                     color=label_color, align=PP_ALIGN.LEFT)


def render_toc(slide, data, theme, meta):
    """Table of contents — auto-generated from meta.chapters or data.items."""
    fill_bg(slide, theme["bg"])
    title = data.get("title", "목차")
    items = data.get("items") or meta.get("chapters") or []

    _draw_title_bar(slide, theme, title)

    # Two-column or single column based on count
    if not items:
        return

    n = len(items)
    cols = 2 if n > 4 else 1
    rows_per_col = (n + cols - 1) // cols

    col_w = 5.5
    row_h = 0.85
    top0 = 1.7

    for i, item in enumerate(items):
        col = i // rows_per_col
        row = i % rows_per_col
        x = 1.1 + col * (col_w + 0.5)
        y = top0 + row * row_h

        # Number
        if isinstance(item, dict):
            num = item.get("number", f"{i+1:02d}")
            label = item.get("title", "")
            page = item.get("page", "")
        else:
            # Plain string like "01. 왜 지금"
            text = str(item)
            if "." in text and text.split(".")[0].strip().isdigit():
                num, label = text.split(".", 1)
                num = num.strip()
                label = label.strip()
            else:
                num, label = f"{i+1:02d}", text
            page = ""

        add_text(slide, Inches(x), Inches(y), Inches(0.7), Inches(0.6),
                 num, font_name=theme["font"], size=24, bold=True,
                 color=theme["accent"], align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE)
        add_text(slide, Inches(x + 0.8), Inches(y), Inches(col_w - 1.0), Inches(0.6),
                 label, font_name=theme["font"], size=18, bold=True,
                 color=theme["primary"], align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE)
        if page:
            add_text(slide, Inches(x + col_w - 0.8), Inches(y),
                     Inches(0.6), Inches(0.6),
                     str(page), font_name=theme["font"], size=14,
                     color=theme["muted"], align=PP_ALIGN.RIGHT, anchor=MSO_ANCHOR.MIDDLE)
        add_hline(slide, x, y + 0.7, col_w - 0.2,
                  hex_blend(theme["muted"], 0.3), thickness_pt=0.5)


# ---------- Content layouts ----------

def render_bullets(slide, data, theme, meta):
    fill_bg(slide, theme["bg"])
    title = data.get("title", "")
    takeaway = data.get("takeaway", "")
    bullets = data.get("bullets", [])
    caption = data.get("caption", "")
    insight = data.get("insight", "")
    bullet_char = data.get("bullet_char", theme.get("bullet_char", "•"))

    _draw_title_bar(slide, theme, title)
    if takeaway:
        add_takeaway(slide, theme, takeaway, top_y=1.5)

    top_y = _content_top(takeaway)
    bot_y = _content_bot(insight)
    bsize = 22 if len(bullets) <= 6 else 18

    add_bullets_box(slide, Inches(1.1), Inches(top_y),
                    Inches(11.0), Inches(bot_y - top_y - 0.2),
                    bullets, font_name=theme["font"], size=bsize, color=theme["text"],
                    bullet_color=theme["accent"], bullet_char=bullet_char)
    if caption and not insight:
        add_text(slide, Inches(1.1), Inches(bot_y - 0.3), Inches(11.0), Inches(0.4),
                 caption, font_name=theme["font"], size=11, color=theme["muted"],
                 align=PP_ALIGN.LEFT)
    if insight:
        add_insight(slide, theme, insight)


def render_comparison(slide, data, theme, meta):
    fill_bg(slide, theme["bg"])
    title = data.get("title", "")
    takeaway = data.get("takeaway", "")
    columns = data.get("columns", [])
    rows = data.get("rows", [])
    insight = data.get("insight", "")

    _draw_title_bar(slide, theme, title)
    if takeaway:
        add_takeaway(slide, theme, takeaway, top_y=1.5)

    if not columns or not rows:
        return

    n_cols = len(columns)
    n_rows = len(rows) + 1
    top_y = _content_top(takeaway)
    bot_y = _content_bot(insight)
    table_left = Inches(0.8)
    table_top = Inches(top_y)
    table_width = Inches(11.7)
    table_height = Inches(bot_y - top_y - 0.1)

    shape = slide.shapes.add_table(n_rows, n_cols, table_left, table_top,
                                    table_width, table_height)
    tbl = shape.table

    if n_cols >= 2:
        tbl.columns[0].width = Inches(4.0)
        rest = (table_width.inches - 4.0) / (n_cols - 1)
        for j in range(1, n_cols):
            tbl.columns[j].width = Inches(rest)

    for j, h in enumerate(columns):
        cell = tbl.cell(0, j)
        cell.fill.solid()
        cell.fill.fore_color.rgb = hex_to_rgb(theme["primary"])
        tf = cell.text_frame
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.LEFT if j == 0 else PP_ALIGN.CENTER
        run = p.add_run()
        run.text = str(h)
        run.font.name = theme["font"]
        run.font.size = Pt(16)
        run.font.bold = True
        run.font.color.rgb = hex_to_rgb("FFFFFF")

    for i, row in enumerate(rows, start=1):
        for j, val in enumerate(row):
            cell = tbl.cell(i, j)
            cell.fill.solid()
            cell.fill.fore_color.rgb = hex_to_rgb(theme["panel"] if i % 2 == 1 else theme["bg"])
            tf = cell.text_frame
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.LEFT if j == 0 else PP_ALIGN.CENTER
            run = p.add_run()
            run.text = str(val)
            run.font.name = theme["font"]
            run.font.size = Pt(14)
            sval = str(val).strip()
            if j > 0 and sval in ("O", "○", "✓"):
                run.font.bold = True
                run.font.color.rgb = hex_to_rgb(theme["accent"])
            elif j > 0 and sval in ("X", "×", "✗"):
                run.font.color.rgb = hex_to_rgb(theme["muted"])
            else:
                run.font.color.rgb = hex_to_rgb(theme["text"])

    if insight:
        add_insight(slide, theme, insight)


def render_kpi(slide, data, theme, meta):
    fill_bg(slide, theme["bg"])
    title = data.get("title", "")
    takeaway = data.get("takeaway", "")
    items = data.get("items", []) or []
    caption = data.get("caption", "")
    insight = data.get("insight", "")

    _draw_title_bar(slide, theme, title)
    if takeaway:
        add_takeaway(slide, theme, takeaway, top_y=1.5)

    if not items:
        return

    n = min(len(items), 4)
    items = items[:4]
    gap = 0.3
    total_w = 11.7
    card_w = (total_w - gap * (n - 1)) / n
    top = _content_top(takeaway) + 0.3
    bot = _content_bot(insight)
    height = bot - top - 0.3

    for i, it in enumerate(items):
        x = 0.8 + i * (card_w + gap)
        add_rect(slide, Inches(x), Inches(top), Inches(card_w), Inches(height),
                 theme["panel"])
        add_rect(slide, Inches(x), Inches(top), Inches(card_w), Inches(0.12),
                 theme["accent"])
        # Big value — auto font scale for length
        value = str(it.get("value", ""))
        v_size = 64 if len(value) <= 5 else (48 if len(value) <= 8 else 36)
        add_text(slide, Inches(x), Inches(top + 0.4),
                 Inches(card_w), Inches(1.5),
                 value, font_name=theme["font"],
                 size=v_size, bold=True, color=theme["primary"],
                 align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        add_text(slide, Inches(x), Inches(top + 1.85),
                 Inches(card_w), Inches(0.45),
                 str(it.get("label", "")), font_name=theme["font"],
                 size=16, bold=True, color=theme["text"],
                 align=PP_ALIGN.CENTER)
        desc = it.get("desc", "")
        if desc:
            add_text(slide, Inches(x + 0.15), Inches(top + 2.35),
                     Inches(card_w - 0.3), Inches(height - 2.5),
                     str(desc), font_name=theme["font"],
                     size=12, color=theme["muted"],
                     align=PP_ALIGN.CENTER)

    if caption and not insight:
        cap_y = bot - 0.3
        add_text(slide, Inches(0.8), Inches(cap_y), Inches(11.7), Inches(0.4),
                 caption, font_name=theme["font"], size=11,
                 color=theme["muted"], align=PP_ALIGN.LEFT)
    if insight:
        add_insight(slide, theme, insight)


def render_feature_grid(slide, data, theme, meta):
    fill_bg(slide, theme["bg"])
    title = data.get("title", "")
    takeaway = data.get("takeaway", "")
    items = data.get("items", []) or []
    insight = data.get("insight", "")

    _draw_title_bar(slide, theme, title)
    if takeaway:
        add_takeaway(slide, theme, takeaway, top_y=1.5)

    if not items:
        return

    n = min(len(items), 6)
    items = items[:n]
    cols = 2 if n <= 4 else 3
    rows = (n + cols - 1) // cols

    gap_x, gap_y = 0.3, 0.25
    total_w = 11.7
    top = _content_top(takeaway)
    bot = _content_bot(insight)
    total_h = bot - top - 0.1
    card_w = (total_w - gap_x * (cols - 1)) / cols
    card_h = (total_h - gap_y * (rows - 1)) / rows

    for i, it in enumerate(items):
        r, c = i // cols, i % cols
        x = 0.8 + c * (card_w + gap_x)
        y = top + r * (card_h + gap_y)

        add_rect(slide, Inches(x), Inches(y), Inches(card_w), Inches(card_h),
                 theme["panel"])
        add_rect(slide, Inches(x), Inches(y), Inches(0.1), Inches(card_h),
                 theme["accent"])

        num = it.get("num", str(i + 1))
        icon = it.get("icon")
        badge = icon if icon else num
        add_text(slide, Inches(x + 0.4), Inches(y + 0.3),
                 Inches(0.8), Inches(0.8),
                 badge, font_name=theme["font"], size=26, bold=True,
                 color=theme["accent"], align=PP_ALIGN.LEFT,
                 anchor=MSO_ANCHOR.MIDDLE)
        add_text(slide, Inches(x + 1.3), Inches(y + 0.3),
                 Inches(card_w - 1.5), Inches(0.8),
                 str(it.get("title", "")), font_name=theme["font"],
                 size=18, bold=True, color=theme["primary"],
                 align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE)
        desc = it.get("desc", "")
        if desc:
            add_text(slide, Inches(x + 0.4), Inches(y + 1.15),
                     Inches(card_w - 0.6), Inches(card_h - 1.3),
                     str(desc), font_name=theme["font"],
                     size=13, color=theme["text"],
                     align=PP_ALIGN.LEFT)

    if insight:
        add_insight(slide, theme, insight)


def render_timeline(slide, data, theme, meta):
    fill_bg(slide, theme["bg"])
    title = data.get("title", "")
    takeaway = data.get("takeaway", "")
    items = data.get("items", []) or []
    insight = data.get("insight", "")

    _draw_title_bar(slide, theme, title)
    if takeaway:
        add_takeaway(slide, theme, takeaway, top_y=1.5)

    if not items:
        return

    n = min(len(items), 5)
    items = items[:n]

    gap = 0.25
    total_w = 11.7
    card_w = (total_w - gap * (n - 1)) / n
    top = _content_top(takeaway) + 0.5
    bot = _content_bot(insight)
    card_h = bot - top - 0.5

    line_y = top - 0.3
    add_rect(slide, Inches(0.8), Inches(line_y), Inches(total_w), Inches(0.04),
             theme["accent"])

    for i, it in enumerate(items):
        x = 0.8 + i * (card_w + gap)
        dot_size = 0.3
        dot_x = x + card_w / 2 - dot_size / 2
        add_rect(slide, Inches(dot_x), Inches(line_y - dot_size / 2 + 0.02),
                 Inches(dot_size), Inches(dot_size), theme["accent"])

        add_rect(slide, Inches(x), Inches(top),
                 Inches(card_w), Inches(card_h), theme["panel"])

        add_text(slide, Inches(x), Inches(top + 0.2),
                 Inches(card_w), Inches(0.5),
                 str(it.get("phase", "")), font_name=theme["font"],
                 size=14, bold=True, color=theme["accent"],
                 align=PP_ALIGN.CENTER)
        add_text(slide, Inches(x + 0.2), Inches(top + 0.7),
                 Inches(card_w - 0.4), Inches(0.7),
                 str(it.get("title", "")), font_name=theme["font"],
                 size=16, bold=True, color=theme["primary"],
                 align=PP_ALIGN.CENTER)
        desc = it.get("desc", "")
        if desc:
            add_text(slide, Inches(x + 0.25), Inches(top + 1.5),
                     Inches(card_w - 0.5), Inches(card_h - 1.7),
                     str(desc), font_name=theme["font"],
                     size=12, color=theme["text"],
                     align=PP_ALIGN.CENTER)

    if insight:
        add_insight(slide, theme, insight)


def render_split(slide, data, theme, meta):
    """3-column split — left KPI / center main (bullets) / right insight column."""
    fill_bg(slide, theme["bg"])
    title = data.get("title", "")
    takeaway = data.get("takeaway", "")
    left = data.get("left", {}) or {}        # { kpi_value, kpi_label }
    center = data.get("center", {}) or {}    # { bullets: [...] }
    right = data.get("right", {}) or {}      # { title, body }

    _draw_title_bar(slide, theme, title)
    if takeaway:
        add_takeaway(slide, theme, takeaway, top_y=1.5)

    top = _content_top(takeaway)
    bot = _content_bot(False)  # split rarely uses bottom insight
    height = bot - top - 0.1

    # Three columns: left 2.8" / center 6.0" / right 2.9" — total ~11.7
    gap = 0.2
    left_w = 2.8
    right_w = 2.9
    center_w = 11.7 - left_w - right_w - gap * 2
    x_left = 0.8
    x_center = x_left + left_w + gap
    x_right = x_center + center_w + gap

    # Left column — big KPI
    add_rect(slide, Inches(x_left), Inches(top), Inches(left_w), Inches(height),
             theme["primary"])
    add_text(slide, Inches(x_left), Inches(top + 0.3), Inches(left_w), Inches(0.4),
             str(left.get("label", "")), font_name=theme["font"],
             size=12, bold=True, color="D6CDB8", align=PP_ALIGN.CENTER)
    val = str(left.get("value", ""))
    v_size = 60 if len(val) <= 5 else 44
    add_text(slide, Inches(x_left), Inches(top + 0.8), Inches(left_w), Inches(2.0),
             val, font_name=theme["font"], size=v_size, bold=True,
             color=theme["accent"], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    sub = left.get("desc", "")
    if sub:
        add_text(slide, Inches(x_left + 0.2), Inches(top + 3.0),
                 Inches(left_w - 0.4), Inches(height - 3.2),
                 sub, font_name=theme["font"], size=12, color="D6CDB8",
                 align=PP_ALIGN.CENTER)

    # Center column — bullets
    center_bullets = center.get("bullets", [])
    if center_bullets:
        add_bullets_box(slide, Inches(x_center), Inches(top + 0.1),
                        Inches(center_w), Inches(height - 0.2),
                        center_bullets, font_name=theme["font"], size=15,
                        color=theme["text"], bullet_color=theme["accent"],
                        bullet_char=theme.get("bullet_char", "•"))

    # Right column — insight panel
    add_rect(slide, Inches(x_right), Inches(top), Inches(right_w), Inches(height),
             theme["panel"])
    add_rect(slide, Inches(x_right), Inches(top), Inches(0.08), Inches(height),
             theme["accent"])
    r_title = right.get("title", "Insight")
    add_text(slide, Inches(x_right + 0.2), Inches(top + 0.2),
             Inches(right_w - 0.3), Inches(0.4),
             r_title, font_name=theme["font"], size=12, bold=True,
             color=theme["accent"], align=PP_ALIGN.LEFT)
    r_body = right.get("body", "")
    if r_body:
        add_text(slide, Inches(x_right + 0.2), Inches(top + 0.7),
                 Inches(right_w - 0.3), Inches(height - 0.9),
                 r_body, font_name=theme["font"], size=13,
                 color=theme["text"], align=PP_ALIGN.LEFT)


def render_closing(slide, data, theme, meta):
    """Closing slide (dark navy CTA)."""
    fill_bg(slide, theme["primary"])
    add_rect(slide, Inches(0), Inches(2.6), Inches(0.4), Inches(2.3), theme["accent"])

    title = data.get("title", "감사합니다")
    bullets = data.get("bullets", [])
    contact = data.get("contact", {}) or {}
    bullet_char = data.get("bullet_char", theme.get("bullet_char", "•"))

    add_text(slide, Inches(1.0), Inches(0.7), Inches(11.5), Inches(1.0),
             title, font_name=theme["font"], size=44, bold=True, color="FFFFFF",
             align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE)
    if bullets:
        add_bullets_box(slide, Inches(1.0), Inches(2.0), Inches(11.5), Inches(3.0),
                        bullets, font_name=theme["font"], size=22, color="EDE7DA",
                        bullet_color=theme["accent"], bullet_char=bullet_char)

    if contact:
        cw, ch = Inches(8.0), Inches(1.4)
        cx, cy = Inches(1.0), Inches(5.5)
        add_rect(slide, cx, cy, cw, ch, "FFFFFF")
        lines = []
        if contact.get("name"): lines.append(contact["name"])
        if contact.get("email"): lines.append(contact["email"])
        if contact.get("phone"): lines.append(contact["phone"])
        box = slide.shapes.add_textbox(cx + Inches(0.3), cy + Inches(0.15),
                                       cw - Inches(0.6), ch - Inches(0.3))
        tf = box.text_frame
        tf.word_wrap = True
        for i, line in enumerate(lines):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            run = p.add_run()
            run.text = line
            run.font.name = theme["font"]
            run.font.size = Pt(20) if i == 0 else Pt(16)
            run.font.bold = (i == 0)
            run.font.color.rgb = hex_to_rgb(theme["primary"] if i == 0 else theme["text"])


# ============================== Dispatch ==============================

LAYOUTS = {
    "title":        render_title,
    "cover_short":  render_cover_short,
    "section":      render_section,
    "toc":          render_toc,
    "bullets":      render_bullets,
    "comparison":   render_comparison,
    "kpi":          render_kpi,
    "feature_grid": render_feature_grid,
    "timeline":     render_timeline,
    "split":        render_split,
    "closing":      render_closing,
}

# Layouts that get the Korean chrome (header bar + footer bar + page).
CHROME_LAYOUTS = {"toc", "bullets", "comparison", "kpi",
                  "feature_grid", "timeline", "split"}

# Layouts that should not show chrome (full-bleed dark slides etc.).
# title/cover_short/section/closing handle their own composition.


def render_slide(prs, slide_data, theme, meta, page_num=None, total=None):
    layout = slide_data.get("layout")
    if layout not in LAYOUTS:
        best = difflib.get_close_matches(str(layout), LAYOUTS.keys(), n=1)
        hint = f" (did you mean '{best[0]}'?)" if best else ""
        raise ValueError(
            f"Unknown layout '{layout}'{hint}. Available: {', '.join(LAYOUTS.keys())}"
        )
    slide = add_blank_slide(prs)
    LAYOUTS[layout](slide, slide_data, theme, meta)
    if layout in CHROME_LAYOUTS and page_num is not None:
        add_chrome(slide, theme, meta, slide_data, page_num, total)
    return slide


# ============================== Main ==============================

def main():
    ap = argparse.ArgumentParser(description="Build Korean-style .pptx from YAML data")
    ap.add_argument("--data", required=True, help="Path to YAML data")
    ap.add_argument("--out", required=True, help="Output .pptx path")
    ap.add_argument("--template", help="(v0.4) brand template .pptx — ignored")
    args = ap.parse_args()

    data_path = Path(args.data)
    out_path = Path(args.out)
    if not data_path.exists():
        print(f"ERROR: data file not found: {data_path}", file=sys.stderr)
        sys.exit(1)

    with open(data_path, encoding="utf-8") as f:
        doc = yaml.safe_load(f)

    if args.template:
        print(f"WARNING: --template ignored in v0.3 (pure code rendering).",
              file=sys.stderr)

    meta = doc.get("meta", {}) or {}
    theme = normalize_theme(doc.get("theme"))
    slides_data = doc.get("slides", [])
    if not slides_data:
        print("ERROR: no slides defined in yaml", file=sys.stderr)
        sys.exit(1)

    prs = Presentation()
    set_slide_size(prs)

    total = len(slides_data)
    layout_counts = {}
    for i, sd in enumerate(slides_data):
        try:
            render_slide(prs, sd, theme, meta, page_num=i + 1, total=total)
        except Exception as e:
            print(f"ERROR on slide {i+1}: {e}", file=sys.stderr)
            sys.exit(1)
        layout_counts[sd.get("layout")] = layout_counts.get(sd.get("layout"), 0) + 1

    out_path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(out_path)

    print(f"✅ Built {len(slides_data)} slide(s) → {out_path}")
    for layout, n in sorted(layout_counts.items()):
        print(f"   {layout}: {n}")


if __name__ == "__main__":
    main()
