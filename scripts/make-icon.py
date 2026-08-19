"""
Generate the macOS app icon set from one vector-ish description.

Drawn with PIL rather than shipped as binary blobs so the icon is reviewable
in a diff and regenerable at any size. Colours are the design tokens' accent
and panel values, converted from oklch to sRGB once and pinned here.
"""
import math
import os
import subprocess
import sys
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "build")
ICONSET = os.path.join(OUT, "Harbor.iconset")

BG_TOP = (30, 41, 66)       # deep navy, matches --bg/--sb family
BG_BOTTOM = (17, 23, 39)
ACCENT = (76, 141, 255)     # --ac
LIGHT = (233, 238, 248)

def squircle_mask(size, radius_ratio=0.2237):
    """macOS uses a superellipse, not a plain rounded rect."""
    mask = Image.new("L", (size * 4, size * 4), 0)
    d = ImageDraw.Draw(mask)
    n = 5.0
    s = size * 4
    cx = cy = s / 2.0
    a = b = s / 2.0
    points = []
    steps = 720
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = cx + a * (abs(ct) ** (2.0 / n)) * (1 if ct >= 0 else -1)
        y = cy + b * (abs(st) ** (2.0 / n)) * (1 if st >= 0 else -1)
        points.append((x, y))
    d.polygon(points, fill=255)
    return mask.resize((size, size), Image.LANCZOS)

def draw_icon(size):
    ss = size * 4  # supersample, then downscale for clean edges
    img = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Vertical gradient background.
    for y in range(ss):
        t = y / max(1, ss - 1)
        c = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
        d.line([(0, y), (ss, y)], fill=c + (255,))

    cx = ss / 2

    # Proportions are tuned so the anchor's flukes clear the harbour arcs
    # entirely — overlapping strokes turn to mud at 16px.
    def px(v):
        return ss * v

    # Harbour basin: two arcs cradling the anchor, opening upward.
    for radius, width, alpha in ((0.35, 0.028, 110), (0.43, 0.024, 70)):
        r = px(radius)
        cy = px(0.47)
        d.arc(
            [cx - r, cy - r, cx + r, cy + r],
            start=25,
            end=155,
            fill=ACCENT + (alpha,),
            width=int(px(width)),
        )

    # Anchor: ring, stem, crossbar, flukes.
    stem_w = px(0.048)
    ring_r = px(0.052)
    ring_cy = px(0.185)

    d.ellipse(
        [cx - ring_r, ring_cy - ring_r, cx + ring_r, ring_cy + ring_r],
        outline=LIGHT + (255,),
        width=int(px(0.026)),
    )
    d.rounded_rectangle(
        [cx - stem_w / 2, ring_cy, cx + stem_w / 2, px(0.665)],
        radius=stem_w / 2,
        fill=LIGHT + (255,),
    )
    bar_w = px(0.185)
    bar_y = px(0.295)
    d.rounded_rectangle(
        [cx - bar_w, bar_y, cx + bar_w, bar_y + px(0.040)],
        radius=px(0.020),
        fill=LIGHT + (255,),
    )
    fr = px(0.170)
    fcy = px(0.530)
    d.arc(
        [cx - fr, fcy - fr, cx + fr, fcy + fr],
        start=25,
        end=155,
        fill=LIGHT + (255,),
        width=int(px(0.048)),
    )

    img = img.resize((size, size), Image.LANCZOS)
    img.putalpha(squircle_mask(size))
    return img

def main():
    os.makedirs(ICONSET, exist_ok=True)
    # The sizes iconutil expects for a complete set.
    for base in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = base * scale
            name = f"icon_{base}x{base}{'@2x' if scale == 2 else ''}.png"
            draw_icon(px).save(os.path.join(ICONSET, name))

    draw_icon(1024).save(os.path.join(OUT, "icon.png"))
    subprocess.run(
        ["iconutil", "-c", "icns", ICONSET, "-o", os.path.join(OUT, "icon.icns")], check=True
    )
    print("wrote build/icon.icns and build/icon.png")

if __name__ == "__main__":
    sys.exit(main())
