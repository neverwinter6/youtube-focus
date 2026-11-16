"""Makes docs/cover.png and docs/thumbnail.png from the screenshots in docs/."""

from __future__ import annotations

import math
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

PAPER = (245, 240, 230)
INK = (22, 20, 18)
SOFT = (92, 84, 73)
RED = (208, 36, 52)
GREEN = (28, 116, 70)

FONTS = Path("C:/Windows/Fonts")


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)


TITLE = lambda s: font("arialbd.ttf", s)  # noqa: E731
HAND = lambda s: font("Inkfree.ttf", s)  # noqa: E731
HAND2 = lambda s: font("segoepr.ttf", s)  # noqa: E731
MONO = lambda s: font("consolab.ttf", s)  # noqa: E731
SANS = lambda s: font("bahnschrift.ttf", s)  # noqa: E731

random.seed(11)
rng = np.random.default_rng(11)


def paper(w: int, h: int) -> Image.Image:
    base = np.full((h, w, 3), PAPER, dtype=np.int16)
    base = np.clip(base + rng.normal(0, 2.2, (h, w, 1)).repeat(3, axis=2), 0, 255)
    img = Image.fromarray(base.astype(np.uint8), "RGB").convert("RGBA")

    grid = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(grid)
    for y in range(22, h, 30):
        for x in range(22, w, 30):
            d.point((x, y), fill=(125, 112, 92, 30))
    return Image.alpha_composite(img, grid)


def framed(path: Path, width: int, border: int = 8, crop_h: int | None = None) -> Image.Image:
    shot = Image.open(path).convert("RGB")
    if crop_h:
        shot = shot.crop((0, 0, shot.width, crop_h))
    shot = shot.resize((width, round(shot.height * width / shot.width)), Image.LANCZOS)
    w, h = shot.size
    out = Image.new("RGB", (w + border * 2, h + border * 2), (252, 250, 246))
    out.paste(shot, (border, border))
    return out


def paste_rotated(canvas, img, center, angle):
    rotated = img.rotate(angle, resample=Image.BICUBIC, expand=True)
    alpha = Image.new("L", rotated.size, 255).rotate(angle, resample=Image.BICUBIC)

    shadow = Image.new("RGBA", rotated.size, (0, 0, 0, 0))
    shadow.paste((58, 48, 38, 110), (0, 0), alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(15))

    x = int(center[0] - rotated.width / 2)
    y = int(center[1] - rotated.height / 2)
    canvas.alpha_composite(shadow, (x + 5, y + 11))
    canvas.paste(rotated, (x, y), alpha)


def tape(canvas, center, size, angle):
    strip = Image.new("RGBA", size, (228, 213, 178, 150))
    d = ImageDraw.Draw(strip)
    d.rectangle((0, 0, size[0] - 1, size[1] - 1), outline=(202, 185, 147, 175), width=1)
    strip = strip.rotate(angle, resample=Image.BICUBIC, expand=True)
    canvas.alpha_composite(strip, (center[0] - strip.width // 2, center[1] - strip.height // 2))


def wobble(points, amount=1.3):
    return [(x + random.uniform(-amount, amount), y + random.uniform(-amount, amount)) for x, y in points]


def marker_line(draw, points, color=RED, width=5):
    pts = wobble(points)
    for a, b in zip(pts, pts[1:]):
        draw.line([a, b], fill=color, width=width)


def arrow(draw, start, end, color=RED, width=5, head=22):
    marker_line(draw, [start, end], color, width)
    ang = math.atan2(end[1] - start[1], end[0] - start[0])
    for side in (-0.5, 0.5):
        draw.line(
            [end, (end[0] - head * math.cos(ang + side), end[1] - head * math.sin(ang + side))],
            fill=color,
            width=width,
        )


def tilted_text(canvas, xy, text, fnt, fill, angle=-3.0):
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).text(xy, text, font=fnt, fill=fill)
    layer = layer.rotate(angle, center=xy, resample=Image.BICUBIC)
    canvas.alpha_composite(layer)


def build(w=1600, h=720):
    canvas = paper(w, h)
    d = ImageDraw.Draw(canvas)

    # ---- left column -------------------------------------------------------
    d.text((70, 34), "USERSCRIPT  ·  v1.0.0", font=MONO(15), fill=SOFT)
    d.text((68, 58), "YouTube Focus", font=TITLE(72), fill=INK)

    tw = d.textlength("YouTube Focus", font=TITLE(72))
    marker_line(d, [(72, 148), (72 + tw - 6, 144)], RED, 6)

    d.text((72, 176), "Shorts, the sidebar and autoplay: gone.", font=HAND2(25), fill=SOFT)
    d.text((72, 210), "Your playback speed stays put.", font=HAND2(25), fill=SOFT)

    items = ["no Shorts, anywhere", "no “up next” sidebar", "no autoplay", "your speed, remembered"]
    y = 268
    for label in items:
        d.ellipse((74, y + 8, 86, y + 20), fill=GREEN if label == items[-1] else RED)
        d.text((102, y), label, font=SANS(26), fill=INK)
        y += 46

    d.text((70, 572), "install", font=MONO(15), fill=SOFT)
    d.text((70, 594), "youtube-focus.user.js", font=MONO(23), fill=INK)
    d.text((70, 636), "github.com/neverwinter6/youtube-focus", font=MONO(17), fill=SOFT)

    # ---- screenshots -------------------------------------------------------
    after = framed(DOCS / "after-watch.png", 780, crop_h=720)
    paste_rotated(canvas, after, (1160, 300), -1.2)
    tape(canvas, (776, 92), (118, 30), -34)
    tape(canvas, (1522, 522), (116, 30), -38)

    before = framed(DOCS / "before-watch.png", 290, crop_h=720)
    paste_rotated(canvas, before, (742, 600), 5.0)
    tape(canvas, (716, 508), (94, 24), -82)

    # red X over the sidebar in the small "before" shot
    d.line([(806, 536), (874, 626)], fill=RED, width=5)
    d.line([(874, 536), (806, 626)], fill=RED, width=5)

    # ---- marker annotations ------------------------------------------------
    tilted_text(canvas, (960, 612), "what it removes", HAND(30), RED, -3)
    arrow(d, (946, 622), (884, 590), RED, 5, 20)

    # hand circle around the settings pill in the big shot
    d.ellipse((1394, 74, 1468, 112), outline=GREEN, width=4)

    return canvas.convert("RGB")


def main():
    cover = build(1600, 720)
    cover.save(DOCS / "cover.png", optimize=True)
    cover.resize((1280, 576), Image.LANCZOS).save(DOCS / "thumbnail.png", optimize=True)
    print("wrote docs/cover.png (1600x720) and docs/thumbnail.png (1280x576)")


if __name__ == "__main__":
    main()
