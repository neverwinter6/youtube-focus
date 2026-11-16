"""Builds docs/side-by-side.png from the four screenshots in docs/."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

PAIRS = [
    ("watch", "Watching a video", "before-watch.png", "after-watch.png"),
    ("search", "Search results", "before-search.png", "after-search.png"),
]

WIDTH = 900
LABEL_H = 46
PAD = 24
GAP = 16
BG = (250, 248, 244)
INK = (24, 22, 20)
MUTED = (110, 104, 96)
ACCENT = (255, 0, 51)


def font(size, bold=False):
    name = "arialbd.ttf" if bold else "arial.ttf"
    for path in (Path("C:/Windows/Fonts") / name, Path("C:/Windows/Fonts/segoeui.ttf")):
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def load(name):
    img = Image.open(DOCS / name).convert("RGB")
    height = round(img.height * WIDTH / img.width)
    return img.resize((WIDTH, height), Image.LANCZOS)


def main():
    shots = {}
    for key, _title, before, after in PAIRS:
        shots[key] = (load(before), load(after))

    row_h = shots["watch"][0].height + LABEL_H
    total_w = PAD * 2 + WIDTH * 2 + GAP
    total_h = PAD + (row_h + GAP) * len(PAIRS) + 64

    canvas = Image.new("RGB", (total_w, total_h), BG)
    draw = ImageDraw.Draw(canvas)

    title_font = font(30, bold=True)
    section_font = font(20, bold=True)
    tag_font = font(15, bold=True)
    hint_font = font(14)

    draw.text((PAD, PAD - 8), "YouTube Focus", font=title_font, fill=INK)
    draw.text(
        (PAD + 240, PAD + 4),
        "before  /  after",
        font=hint_font,
        fill=MUTED,
    )

    y = PAD + 52
    for key, title, _b, _a in PAIRS:
        before, after = shots[key]
        draw.text((PAD, y), title, font=section_font, fill=INK)
        y += LABEL_H

        for image, tag, color in ((before, "BEFORE", MUTED), (after, "AFTER", ACCENT)):
            x = PAD if tag == "BEFORE" else PAD + WIDTH + GAP
            canvas.paste(image, (x, y + 26))

        # tags sit just above each screenshot
        draw.text((PAD, y + 6), "BEFORE", font=tag_font, fill=MUTED)
        draw.text((PAD + WIDTH + GAP, y + 6), "AFTER", font=tag_font, fill=ACCENT)

        y += row_h + GAP

    out = DOCS / "side-by-side.png"
    canvas.save(out, optimize=True)
    print(f"wrote {out} ({canvas.width}x{canvas.height})")


if __name__ == "__main__":
    main()
