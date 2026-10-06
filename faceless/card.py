"""Карточка-заголовок в стиле поста: показывается, пока звучит хук."""
from __future__ import annotations

import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

_FONT_CANDIDATES = {
    "bold": ["/usr/share/fonts/opentype/inter/Inter-Bold.otf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
             "/Library/Fonts/Arial Bold.ttf", "C:/Windows/Fonts/arialbd.ttf"],
    "regular": ["/usr/share/fonts/opentype/inter/Inter-Medium.otf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                "/Library/Fonts/Arial.ttf", "C:/Windows/Fonts/arial.ttf"],
}


def _font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    for path in _FONT_CANDIDATES[kind]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def render_card(title: str, subreddit: str, out: Path, width: int = 940, accent: str = "#FF4500",
                score: int | None = None) -> Path:
    pad, radius = 48, 36
    title_font, meta_font = _font("bold", 58), _font("regular", 36)
    lines = textwrap.wrap(title, width=26)[:7]
    line_h = 72
    height = pad * 2 + 70 + 24 + line_h * len(lines) + 60

    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, width - 1, height - 1), radius=radius, fill="white")

    d.ellipse((pad, pad, pad + 70, pad + 70), fill=accent)
    d.text((pad + 35, pad + 35), "r/", font=_font("bold", 34), fill="white", anchor="mm")
    d.text((pad + 92, pad + 35), f"r/{subreddit}", font=meta_font, fill="#1A1A1B", anchor="lm")

    y = pad + 70 + 24
    for line in lines:
        d.text((pad, y), line, font=title_font, fill="#1A1A1B")
        y += line_h

    if score is not None:
        d.text((pad, y + 12), f"▲ {score:,}".replace(",", " "), font=meta_font, fill="#787C7E")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    return out
