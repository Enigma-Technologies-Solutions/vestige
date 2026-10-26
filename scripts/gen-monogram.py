#!/usr/bin/env python3
"""The Vestige "vt" monogram, drawn from the self-hosted Poppins 700 outlines.

The same construction as Sanctum's "st" and Sigil's "sg" (sanctum: scripts/gen-monogram.py,
sigil: apps/web/brand/gen-monogram.py): an ink tile, a volt frame, the two letters in paper
white and a sharp volt terminal square, at one type size and baseline across all three.
Writes web/assets/favicon.svg.

Requires: pip install fonttools brotli
"""
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
INK, VOLT, PAPER = "#0A0A0A", "#FBFF00", "#FFFFFF"
TRACKING = -20          # font units between the letters
DOT, DOT_GAP = 150, 70  # volt terminal square and its gap, font units
# One type size and one baseline for every ETS monogram (sg, st, vt), so the marks
# match side by side: the em is EM of the tile's body, sized so the widest, "sg",
# keeps clear of the frame. The x-height band is centred; ascenders and the g's
# descender fall where they fall. Keep in step with the other repos' copies.
EM, X_HEIGHT = 0.47, 558
LETTERS, TITLE = "vt", "Vestige"


def glyphs(text: str):
    font = TTFont(ROOT / "web/assets/fonts/Poppins-700.woff2")
    gs, cmap = font.getGlyphSet(), font.getBestCmap()
    x, parts, box = 0, [], [1e9, 1e9, -1e9, -1e9]
    for ch in text:
        g = gs[cmap[ord(ch)]]
        pen, bp = SVGPathPen(gs), BoundsPen(gs)
        g.draw(pen)
        g.draw(bp)
        b = bp.bounds
        parts.append((x, pen.getCommands()))
        box = [min(box[0], x + b[0]), min(box[1], b[1]), max(box[2], x + b[2]), max(box[3], b[3])]
        x += g.width + TRACKING
    return parts, box


def mark(size, pad, frame_inset, frame_w):
    parts, (xmin, _, xmax, _) = glyphs(LETTERS)
    body = size - 2 * pad
    s = EM * body / 1000
    w_units = (xmax - xmin) + DOT_GAP + DOT
    tx = pad + (body - w_units * s) / 2 - xmin * s
    baseline = pad + (body + X_HEIGHT * s) / 2
    fi = pad + frame_inset + frame_w / 2
    inner = body - 2 * frame_inset - frame_w
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">',
        f"  <title>{TITLE}</title>",
        f'  <rect x="{pad}" y="{pad}" width="{body}" height="{body}" fill="{INK}"/>',
        f'  <rect x="{fi:.2f}" y="{fi:.2f}" width="{inner:.2f}" height="{inner:.2f}" fill="none" stroke="{VOLT}" stroke-width="{frame_w}"/>',
        f'  <g fill="{PAPER}" transform="translate({tx:.2f} {baseline:.2f}) scale({s:.5f} {-s:.5f})">',
    ]
    out += [f'    <path transform="translate({x} 0)" d="{d}"/>' for x, d in parts]
    dx = tx + (xmax + DOT_GAP) * s
    out += [
        "  </g>",
        f'  <rect x="{dx:.2f}" y="{baseline - DOT * s:.2f}" width="{DOT * s:.2f}" height="{DOT * s:.2f}" fill="{VOLT}"/>',
        "</svg>",
    ]
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    (ROOT / "web/assets/favicon.svg").write_text(mark(64, 0, 5, 3))
    print("wrote web/assets/favicon.svg")
