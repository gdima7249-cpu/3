"""Озвучка с таймингами слов (нужны для субтитров «слово в слово»).

* edge       — Microsoft Edge TTS (бесплатно), тайминги из событий WordBoundary.
* elevenlabs — ElevenLabs /with-timestamps, тайминги из посимвольного выравнивания.
* silent     — тишина с оценочными таймингами: для тестов и отладки рендера без сети.
"""
from __future__ import annotations

import asyncio
import base64
import os
import random
import re
from dataclasses import dataclass
from pathlib import Path

import requests

from . import media
from .models import Word
from .text import CHARS_PER_SECOND


@dataclass
class Speech:
    audio: Path
    words: list[Word]
    title_end: float  # когда закончился заголовок — до этого момента висит карточка
    duration: float


def _edge(text: str, out: Path, voice: str, rate: str) -> list[Word]:
    import edge_tts

    async def go() -> list[Word]:
        words: list[Word] = []
        comm = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
        with out.open("wb") as f:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    start = chunk["offset"] / 1e7
                    words.append(Word(chunk["text"], start, start + chunk["duration"] / 1e7))
        return words

    return asyncio.run(go())


def _elevenlabs(text: str, out: Path, voice_id: str, model: str) -> list[Word]:
    resp = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps",
        headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
        json={"text": text, "model_id": model},
        timeout=300,
    )
    resp.raise_for_status()
    data = resp.json()
    out.write_bytes(base64.b64decode(data["audio_base64"]))
    al = data["alignment"]
    return chars_to_words(al["characters"], al["character_start_times_seconds"],
                          al["character_end_times_seconds"])


def chars_to_words(chars: list[str], starts: list[float], ends: list[float]) -> list[Word]:
    words, buf, w_start, w_end = [], "", 0.0, 0.0
    for ch, s, e in zip(chars, starts, ends):
        if ch.isspace():
            if buf:
                words.append(Word(buf, w_start, w_end))
            buf = ""
            continue
        if not buf:
            w_start = s
        buf += ch
        w_end = e
    if buf:
        words.append(Word(buf, w_start, w_end))
    return words


def estimate_words(text: str, cps: float = CHARS_PER_SECOND) -> tuple[list[Word], float]:
    words, t = [], 0.0
    for token in text.split():
        d = max(len(token), 2) / cps
        words.append(Word(token, t, t + d))
        t += d + (0.25 if re.search(r"[.!?…]$", token) else 1 / cps)
    return words, t


def _silent(text: str, out: Path) -> list[Word]:
    words, total = estimate_words(text)
    media.silence(out, total)
    return words


def synthesize(title: str, body: str, workdir: Path, cfg: dict, rng: random.Random) -> Speech:
    """Озвучивает заголовок и тело отдельно (чтобы точно знать, где кончился заголовок) и склеивает."""
    tc = cfg["tts"]
    engine = tc["engine"]
    workdir.mkdir(parents=True, exist_ok=True)
    voice = rng.choice(tc["voices"]) if tc["voices"] else None
    el_voice = rng.choice(tc["elevenlabs_voice_ids"]) if tc["elevenlabs_voice_ids"] else None

    def say(text: str, name: str) -> tuple[Path, list[Word]]:
        path = workdir / f"{name}.mp3"
        if engine == "edge":
            words = _edge(text, path, voice, tc["rate"])
        elif engine == "elevenlabs":
            if not el_voice:
                raise ValueError("tts.elevenlabs_voice_ids пуст")
            words = _elevenlabs(text, path, el_voice, tc["elevenlabs_model"])
        elif engine == "silent":
            words = _silent(text, path)
        else:
            raise ValueError(f"Неизвестный tts.engine: {engine}")
        return path, words

    title_audio, title_words = say(title, "title")
    body_audio, body_words = say(body, "body")
    gap = media.silence(workdir / "gap.mp3", 0.35)

    title_end = media.duration(title_audio)
    offset = title_end + 0.35
    words = title_words + [Word(w.text, w.start + offset, w.end + offset) for w in body_words]
    audio = media.concat_audio([title_audio, gap, body_audio], workdir / "voice.wav")
    return Speech(audio=audio, words=words, title_end=title_end, duration=media.duration(audio))
