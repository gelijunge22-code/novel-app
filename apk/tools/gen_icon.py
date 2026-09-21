#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the app launcher icons (deep-brown tile + white 文) with Pillow.

Run with an interpreter that has PIL, e.g.:
  /home/ubuntu/.hermes/hermes-agent/venv/bin/python3 tools/gen_icon.py
Idempotent: overwrites res/mipmap-*/ic_launcher*.png.
"""
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.stderr.write("Pillow not available; keeping existing PNG assets.\n")
    sys.exit(0)

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
RES = os.path.join(PROJ, "res")

BG = (43, 27, 18, 255)         # #2B1B12 deep brown
BG_EDGE = (61, 42, 28, 255)    # #3D2A1C
FG = (243, 234, 217, 255)      # #F3EAD9 warm white
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]

# density bucket -> (legacy launcher size, adaptive foreground size)
BUCKETS = {
    "mipmap-mdpi": (48, 108),
    "mipmap-hdpi": (72, 162),
    "mipmap-xhdpi": (96, 216),
    "mipmap-xxhdpi": (144, 324),
    "mipmap-xxxhdpi": (192, 432),
}
SS = 8  # supersampling factor


def pick_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def draw_glyph(d, S, box, fill):
    """Draw 文 centered inside the given box (fractions of S)."""
    x0, y0, x1, y1 = box
    side = (x1 - x0) * S
    font = pick_font(int(side * 0.92))
    text = "文"
    try:
        bb = d.textbbox((0, 0), text, font=font)
    except Exception:
        bb = (0, 0, side, side)
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    cx = (x0 + x1) / 2 * S
    cy = (y0 + y1) / 2 * S
    d.text((cx - w / 2 - bb[0], cy - h / 2 - bb[1]), text, font=font, fill=fill)


def make_legacy(size, rounded):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.ellipse([0, 0, S - 1, S - 1], fill=BG)
        d.ellipse([S * 0.055, S * 0.055, S * 0.945, S * 0.945], outline=BG_EDGE, width=max(1, int(S * 0.012)))
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=BG)
        d.rounded_rectangle([S * 0.045, S * 0.045, S * 0.955, S * 0.955],
                            radius=int(S * 0.19), outline=BG_EDGE, width=max(1, int(S * 0.012)))
    draw_glyph(d, S, (0.22, 0.20, 0.78, 0.80), FG)
    return img.resize((size, size), Image.LANCZOS)


def make_foreground(size):
    """Adaptive icon foreground: transparent canvas, 文 inside the 66% safe zone."""
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_glyph(d, S, (0.28, 0.27, 0.72, 0.73), FG)
    return img.resize((size, size), Image.LANCZOS)


def main():
    for bucket, (legacy, fg) in BUCKETS.items():
        outdir = os.path.join(RES, bucket)
        os.makedirs(outdir, exist_ok=True)
        make_legacy(legacy, False).save(os.path.join(outdir, "ic_launcher.png"))
        make_legacy(legacy, True).save(os.path.join(outdir, "ic_launcher_round.png"))
        make_foreground(fg).save(os.path.join(outdir, "ic_launcher_foreground.png"))
        print("wrote %s (%dpx launcher / %dpx foreground)" % (bucket, legacy, fg))


if __name__ == "__main__":
    main()
