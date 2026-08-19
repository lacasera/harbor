"""
Generate the macOS menu-bar icon.

A template image: pure black with an alpha channel and no colour of its own, so
macOS tints it for a light or dark menu bar and for the highlighted state. The
app icon cannot be reused — its navy background and blue arcs would render as a
grey smudge once the system flattens it.

Only the anchor survives the shrink. The harbour arcs that read well at 512px
are two pixels apart at 16, so they are dropped rather than drawn as mud.
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "resources", "tray")
BLACK = (0, 0, 0)


def draw(size):
    ss = size * 8  # supersample; menu-bar glyphs live or die on their edges
    img = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = ss / 2

    def px(v):
        return ss * v

    # Inset from the canvas: macOS gives the icon no padding of its own, and a
    # glyph touching the edges sits badly against its neighbours.
    stem_w = px(0.075)
    ring_r = px(0.088)
    ring_cy = px(0.215)

    d.ellipse(
        [cx - ring_r, ring_cy - ring_r, cx + ring_r, ring_cy + ring_r],
        outline=BLACK + (255,),
        width=int(px(0.045)),
    )
    d.rounded_rectangle(
        [cx - stem_w / 2, ring_cy, cx + stem_w / 2, px(0.760)],
        radius=stem_w / 2,
        fill=BLACK + (255,),
    )
    bar_w = px(0.290)
    bar_y = px(0.330)
    d.rounded_rectangle(
        [cx - bar_w, bar_y, cx + bar_w, bar_y + px(0.070)],
        radius=px(0.035),
        fill=BLACK + (255,),
    )
    fr = px(0.270)
    fcy = px(0.560)
    d.arc(
        [cx - fr, fcy - fr, cx + fr, fcy + fr],
        start=25,
        end=155,
        fill=BLACK + (255,),
        width=int(px(0.080)),
    )
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    # 16pt, at 1x and 2x. The `Template` suffix is what tells macOS to tint it.
    draw(16).save(os.path.join(OUT, "trayTemplate.png"))
    draw(32).save(os.path.join(OUT, "trayTemplate@2x.png"))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
