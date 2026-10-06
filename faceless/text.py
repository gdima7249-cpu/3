"""Разбиение сценария на части нужной длины."""
from __future__ import annotations

import re

from .models import Part, Script

CHARS_PER_SECOND = 15.0  # средний темп нейроголоса с rate ≈ +10%; уточняется по факту озвучки

_SENTENCE = re.compile(r"(?<=[.!?…])\s+|\n+")


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE.split(text) if s and s.strip()]


def estimate_seconds(text: str, cps: float = CHARS_PER_SECOND) -> float:
    return len(text) / cps


def split_parts(script: Script, max_seconds: float, cps: float = CHARS_PER_SECOND) -> list[Part]:
    """Режет тело по предложениям так, чтобы каждая часть (с заголовком и подводкой) влезла в лимит.

    Части выходят примерно равными: лучше 2×45 с, чем 58 + 32.
    """
    sentences = split_sentences(script.body)
    overhead = estimate_seconds(script.title, cps) + 3.0  # заголовок + «Часть N…» / «Продолжение…»
    budget = max(max_seconds - overhead, 10.0)
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

    total_parts = len(chunks)
    parts = []
    for i, chunk in enumerate(chunks, 1):
        body = " ".join(chunk)
        title = script.title
        if total_parts > 1:
            title = f"{script.title} Часть {i}." if i == 1 else f"Часть {i}. {script.title}"
            if i < total_parts:
                body += f" Продолжение в части {i + 1}."
        parts.append(Part(index=i, total=total_parts, title=title, body=body))
    return parts
