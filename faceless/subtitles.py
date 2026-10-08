"""Субтитры в формате ASS: крупные слова по 1–3, текущее слово подсвечено, «поп» при появлении."""
from __future__ import annotations

import re

from .models import Word

_END_PUNCT = re.compile(r"[.!?…,;:—]$")


def chunk_words(words: list[Word], max_words: int = 3, max_chars: int = 15,
                max_gap: float = 0.35) -> list[list[Word]]:
    chunks: list[list[Word]] = []
    cur: list[Word] = []
    for w in words:
        if cur:
            chars = sum(len(x.text) + 1 for x in cur) + len(w.text)
            if (len(cur) >= max_words or chars > max_chars or _END_PUNCT.search(cur[-1].text)
                    or w.start - cur[-1].end > max_gap):
                chunks.append(cur)
                cur = []
        cur.append(w)
    if cur:
        chunks.append(cur)
    return chunks


def ass_time(t: float) -> str:
    cs = max(0, round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _escape(text: str) -> str:
    return text.replace("\\", "").replace("{", "(").replace("}", ")")


def build_ass(words: list[Word], *, start_at: float, end_at: float, width: int, height: int,
              font: str, font_size: int, highlight: str, max_words: int = 3) -> str:
    """start_at — с какого момента показывать субтитры (после карточки-заголовка)."""
    k = font_size / 92  # во сколько раз кадр меньше базового (1080 px)
    outline, shadow, margin = max(3, round(7 * k)), max(1, round(3 * k)), round(80 * k)
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,{font},{font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,{outline},{shadow},5,{margin},{margin},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    visible = [w for w in words if w.start >= start_at - 0.05]
    chunks = chunk_words(visible, max_words=max_words)
    lines = []
    for ci, chunk in enumerate(chunks):
        next_start = chunks[ci + 1][0].start if ci + 1 < len(chunks) else end_at
        chunk_end = next_start if next_start - chunk[-1].end < 0.4 else chunk[-1].end + 0.15
        tokens = [_escape(w.text.upper()) for w in chunk]
        for wi, w in enumerate(chunk):
            start = w.start
            end = chunk[wi + 1].start if wi + 1 < len(chunk) else chunk_end
            if end <= start:
                continue
            styled = [
                f"{{\\c{highlight}&\\fscx108\\fscy108}}{t}{{\\c&H00FFFFFF&\\fscx100\\fscy100}}" if i == wi else t
                for i, t in enumerate(tokens)
            ]
            pop = "{\\fscx70\\fscy70\\t(0,90,\\fscx100\\fscy100)}" if wi == 0 else ""
            lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Main,,0,0,0,,{pop}{' '.join(styled)}")
    return header + "\n".join(lines) + "\n"
