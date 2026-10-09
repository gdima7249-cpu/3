"""Разбиение сценария на части нужной длины."""
from __future__ import annotations

import re

from .models import Part, Script

CHARS_PER_SECOND = 15.0  # средний темп нейроголоса с rate ≈ +10%; уточняется по факту озвучки

PHRASES = {
    "en": {"part_first": "{title} Part {i}.", "part_next": "Part {i}. {title}",
           "to_be_continued": " Part {n} is up next.", "meta_part": "{title} (part {i}/{n})",
           "source": "Story: r/{sub}", "fiction": "This is a work of fiction.", "ai_voice": "Narrated with an AI voice."},
    "ru": {"part_first": "{title} Часть {i}.", "part_next": "Часть {i}. {title}",
           "to_be_continued": " Продолжение в части {n}.", "meta_part": "{title} (часть {i}/{n})",
           "source": "История: r/{sub}", "fiction": "Это вымышленная история.", "ai_voice": "Озвучено ИИ-голосом."},
}


def phrases(language: str) -> dict:
    return PHRASES.get(language, PHRASES["en"])


_SENTENCE = re.compile(r"(?<=[.!?…])\s+|\n+")


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE.split(text) if s and s.strip()]


def estimate_seconds(text: str, cps: float = CHARS_PER_SECOND) -> float:
    return len(text) / cps


def split_parts(script: Script, max_seconds: float, cps: float = CHARS_PER_SECOND,
                language: str = "en") -> list[Part]:
    """Режет тело по предложениям так, чтобы каждая часть (с заголовком и подводкой) влезла в лимит.

    Части выходят примерно равными: лучше 2×45 с, чем 58 + 32.
    """
    sentences = split_sentences(script.body)
    overhead = estimate_seconds(script.title, cps) + 3.0  # заголовок + «Part N…» / «Part N+1 is up next»
    budget = max(max_seconds - overhead, 10.0) * 1.1  # допуск 10%: оценка длины грубая, а Shorts терпят до 3 минут
    total = estimate_seconds(script.body, cps)
    n = max(1, -(-int(total * 10) // int(budget * 10)))  # ceil без float-погрешностей
    target = total / n

    chunks: list[list[str]] = [[]]
    acc = 0.0
    for sentence in sentences:
        dur = estimate_seconds(sentence, cps)
        if chunks[-1] and (acc + dur > budget or (acc >= target and len(chunks) < n)):
            chunks.append([])
            acc = 0.0
        chunks[-1].append(sentence)
        acc += dur

    ph = phrases(language)
    total_parts = len(chunks)
    parts = []
    for i, chunk in enumerate(chunks, 1):
        body = " ".join(chunk)
        title = script.title
        if total_parts > 1:
            title = ph["part_first" if i == 1 else "part_next"].format(title=script.title, i=i)
            if i < total_parts:
                body += ph["to_be_continued"].format(n=i + 1)
        parts.append(Part(index=i, total=total_parts, title=title, body=body))
    return parts


_NUM = re.compile(r"^\s*(?:[-*•]+|\d+\s*[.)]|fact\s*\d+\s*[:.\-)])\s*", re.I)


_BAR = re.compile(r"\s*\|+\s*")
_TRAIL_VIS = re.compile(r"\s*(?:\[([^\]]{2,60})\]|\(\s*(?:visuals?|keywords?|кадр)\s*[:：]\s*([^)]{2,60})\))\s*$", re.I)


def parse_segments(body: str) -> list[tuple[str, str]]:
    """Формат «фактов»: по одному факту в строке, после « | » ключевые слова кадра.

    Терпимо к мелочам: «||», «[keywords]» или «(visual: …)» в конце вместо «|», нумерация, лишние строки-болтовня
    в начале и конце ответа ИИ. Возвращает [(текст, кадр), ...] или [], если это обычная история
    (нужно хотя бы 3 строки с кадром или большинство строк с кадром)."""
    segs: list[tuple[str, str]] = []
    for line in body.splitlines():
        line = line.strip()
        if not line:
            continue
        text, vis = line, ""
        if "|" in line:
            parts = _BAR.split(line, maxsplit=1)
            text, vis = parts[0], parts[1] if len(parts) > 1 else ""
        else:
            m = _TRAIL_VIS.search(line)
            if m:
                text, vis = line[:m.start()], m.group(1) or m.group(2)
        text = _NUM.sub("", text).strip()
        vis = vis.strip().strip("[]()*\"' .") if vis else ""
        if text:
            segs.append((text, vis))
    while segs and not segs[0][1]:  # болтовня до первого факта («Here are your facts:»)
        segs.pop(0)
    while segs and not segs[-1][1]:  # и после последнего («Let me know if…»)
        segs.pop()
    with_vis = sum(1 for _, v in segs if v)
    return segs if with_vis >= 3 or (with_vis >= 2 and with_vis * 10 >= len(segs) * 6) else []


def narration(segments: list[tuple[str, str]]) -> str:
    """Весь закадровый текст одной строкой (каждый факт заканчивается знаком препинания)."""
    return " ".join(t if t[-1] in ".!?…" else t + "." for t, _ in segments)
