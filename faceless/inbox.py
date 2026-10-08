"""Папка «входящих» историй: файл inbox.txt, куда вы раз в неделю вставляете пачку историй.

Формат: истории разделены строкой из трёх дефисов (---). Первая строка истории — заголовок
(можно с префиксом TITLE:), остальное — текст. Использованные истории программа запоминает и не повторяет.
Нужен, когда ИИ-сервис недоступен с сервера (например, Gemini режет по стране IP) или когда хочется своих историй.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

_SEP = re.compile(r"^\s*-{3,}\s*$", re.M)
_TITLE = re.compile(r"^\s*(?:\*\*|#+)?\s*(?:title|заголовок)\s*[:：]\s*", re.I)


def story_id(title: str) -> str:
    return "inb-" + hashlib.sha1(title.strip().lower().encode()).hexdigest()[:10]


def parse(text: str) -> list[tuple[str, str]]:
    """[(заголовок, текст), ...]; пустые и слишком короткие блоки пропускаются."""
    out = []
    for block in _SEP.split(text):
        lines = [ln.rstrip() for ln in block.strip().splitlines()]
        while lines and not lines[0].strip():
            lines.pop(0)
        if len(lines) < 2:
            continue
        title = re.sub(r"[*#_`]+", "", _TITLE.sub("", lines[0])).strip().strip('"')
        body = "\n".join(lines[1:]).strip()
        body = re.sub(r"^\s*(?:story|text|история|текст)\s*[:：]\s*", "", body, flags=re.I)
        body = re.sub(r"[*#_`]+", "", body).strip()
        if title and len(body) >= 80:
            out.append((title, body))
    return out


def load(path: str | Path) -> list[tuple[str, str]]:
    p = Path(path)
    return parse(p.read_text(encoding="utf-8")) if p.exists() else []


def append(path: str | Path, text: str) -> int:
    """Дописывает пачку историй в файл, возвращает, сколько историй распознано."""
    stories = parse(text)
    if stories:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(("\n---\n" if p.exists() and p.stat().st_size else "") + text.strip() + "\n")
    return len(stories)
