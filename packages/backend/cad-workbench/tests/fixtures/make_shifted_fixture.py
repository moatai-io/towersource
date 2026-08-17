#!/usr/bin/env python3
"""Create a small DXF fixture whose content is intentionally far from origin."""
from __future__ import annotations

from pathlib import Path

import ezdxf

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "shifted_block_diagram.dxf"


def main() -> None:
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4  # millimeters
    for name in ["EQUIPMENT", "DUCT", "TEXT", "TITLE"]:
        if name not in doc.layers:
            doc.layers.add(name)
    msp = doc.modelspace()

    ox = 120_000
    oy = -83_000

    # Main equipment blocks.
    for i, label in enumerate(["LF HOOD", "DUCT", "BAG FILTER", "FAN", "STACK"]):
        x = ox + i * 2200
        y = oy + (i % 2) * 450
        msp.add_lwpolyline(
            [(x, y), (x + 1500, y), (x + 1500, y + 700), (x, y + 700), (x, y)],
            dxfattribs={"layer": "EQUIPMENT"},
        )
        msp.add_text(label, dxfattribs={"height": 180, "layer": "TEXT"}).set_placement((x + 120, y + 300))
        if i > 0:
            px = ox + (i - 1) * 2200 + 1500
            py = oy + ((i - 1) % 2) * 450 + 350
            msp.add_line((px, py), (x, y + 350), dxfattribs={"layer": "DUCT"})

    # Title block near drawing content.
    tx = ox + 8800
    ty = oy - 1200
    msp.add_lwpolyline(
        [(tx, ty), (tx + 1800, ty), (tx + 1800, ty + 900), (tx, ty + 900), (tx, ty)],
        dxfattribs={"layer": "TITLE"},
    )
    msp.add_text("1ST STEEL LF DUST COLLECTOR", dxfattribs={"height": 120, "layer": "TITLE"}).set_placement((tx + 100, ty + 600))
    msp.add_text("SHIFTED FIXTURE", dxfattribs={"height": 120, "layer": "TITLE"}).set_placement((tx + 100, ty + 350))

    doc.saveas(OUT)
    print(OUT)


if __name__ == "__main__":
    main()
