"""Видеофон по теме истории/факта: короткие кадры, которые меняются каждые ~5 секунд (приём «смена кадра»).

Откуда берутся кадры (по порядку; что подключено, то и работает):
  1. Pexels API  (PEXELS_API_KEY)   — бесплатно, лицензия разрешает коммерческое использование без указания автора;
  2. Pixabay API (PIXABAY_API_KEY)  — то же самое, ключ выдаётся сразу после регистрации;
  3. своя библиотека — видео из assets/backgrounds (имя файла = тема: ocean.mp4, city_night.mp4; подбор по словам
     из ключевых слов, иначе случайные кадры).
Если ничего нет, остаётся обычный градиентный фон.
"""
from __future__ import annotations

import logging
import math
import os
import random
import re
from pathlib import Path

import requests

from . import media

log = logging.getLogger("faceless")

PEXELS_API = "https://api.pexels.com/videos/search"
PIXABAY_API = "https://pixabay.com/api/videos/"
GENERIC = [
    "city night lights", "rain on window", "ocean waves", "forest path", "slow motion water", "neon lights",
    "clouds timelapse", "candle flame", "coffee pouring", "street at night", "mountain mist", "paint swirl",
    "snow falling", "aerial city", "sunset sky", "highway night", "city rain", "smoke slow motion",
]
MAX_CLIP_MB = 30
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm"}


def api_keys() -> list[tuple[str, str]]:
    return [(n, os.environ[e]) for n, e in (("pexels", "PEXELS_API_KEY"), ("pixabay", "PIXABAY_API_KEY"))
            if os.environ.get(e)]


def library_clips(cfg: dict) -> list[Path]:
    """Свои клипы (без авто-градиентов) из папки фонов."""
    folder = Path(cfg["paths"]["backgrounds_dir"])
    if not folder.exists():
        return []
    return sorted(p for p in folder.iterdir()
                  if p.suffix.lower() in VIDEO_EXT and not p.name.startswith("auto_gradient_"))


def enabled(cfg: dict) -> bool:
    return bool(cfg.get("broll", {}).get("enabled") and (api_keys() or library_clips(cfg)))


# ---------------------------------------------------------------- Pexels
def search(query: str, key: str, per_page: int = 15) -> list[dict]:
    r = requests.get(PEXELS_API, headers={"Authorization": key}, timeout=20,
                     params={"query": query, "orientation": "portrait", "size": "medium", "per_page": per_page})
    r.raise_for_status()
    return r.json().get("videos", [])


def pick_file(video: dict, target_width: int = 720) -> str | None:
    """Ссылка на вертикальный mp4 шириной ближе всего к нужной (не 4K: тяжело и не нужно)."""
    files = [f for f in video.get("video_files", [])
             if f.get("file_type") == "video/mp4" and f.get("width") and f.get("height")
             and f["height"] > f["width"] and 480 <= f["width"] <= 1100 and f.get("link")]
    if not files:
        return None
    return min(files, key=lambda f: abs(f["width"] - target_width))["link"]


# ---------------------------------------------------------------- Pixabay
def search_pixabay(query: str, key: str, per_page: int = 20) -> list[dict]:
    r = requests.get(PIXABAY_API, timeout=20, params={"key": key, "q": query, "per_page": per_page,
                                                      "safesearch": "true", "video_type": "film"})
    r.raise_for_status()
    return r.json().get("hits", [])


def pick_pixabay(hit: dict) -> str | None:
    """Лучшее качество, которое не слишком тяжёлое. Кадры в основном горизонтальные: ниже обрезаются по центру."""
    for quality in ("large", "medium", "small"):
        v = (hit.get("videos") or {}).get(quality) or {}
        if v.get("url") and (v.get("size") or 0) <= MAX_CLIP_MB * 2**20:
            return v["url"]
    return None


def download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    with requests.get(url, stream=True, timeout=(10, 60)) as r:
        r.raise_for_status()
        total = 0
        with tmp.open("wb") as f:
            for chunk in r.iter_content(1 << 20):
                total += len(chunk)
                if total > MAX_CLIP_MB * 2**20:
                    tmp.unlink(missing_ok=True)
                    raise RuntimeError("клип слишком большой")
                f.write(chunk)
    tmp.replace(dest)
    return dest


def candidates(query: str) -> list[tuple[str, str]]:
    """[(уникальный id, ссылка), ...] из всех подключённых источников; сбой одного не ломает остальные."""
    out: list[tuple[str, str]] = []
    for name, key in api_keys():
        try:
            if name == "pexels":
                for v in search(query, key):
                    link = pick_file(v)
                    if link:
                        out.append((f"pexels-{v['id']}", link))
            else:
                for hit in search_pixabay(query, key):
                    link = pick_pixabay(hit)
                    if link:
                        out.append((f"pixabay-{hit['id']}", link))
        except Exception as e:
            log.warning("%s «%s»: %s", name, query, e)
    return out


def _get_clip(query: str, cache: Path, rng: random.Random, used: set[str]) -> Path | None:
    found = candidates(query)
    rng.shuffle(found)
    for cid, link in found:
        if cid in used:
            continue
        dest = cache / f"{cid}.mp4"
        if not dest.exists():
            download(link, dest)
        used.add(cid)
        return dest
    return None


def _library_clip(query: str, clips: list[Path], rng: random.Random, used: set[str]) -> Path | None:
    """Свой клип: сначала по слову из имени файла (ocean.mp4 для «ocean waves»), иначе случайный."""
    words = {w for w in re.findall(r"[a-zа-я0-9]+", query.lower()) if len(w) > 2}
    matched = [c for c in clips if words & set(re.findall(r"[a-zа-я0-9]+", c.stem.lower()))]
    pool = [c for c in (matched or clips) if c.name not in used] or (matched or clips)
    if not pool:
        return None
    pick = rng.choice(pool)
    used.add(pick.name)
    return pick


def prune_cache(cache: Path, max_mb: int) -> None:
    files = sorted(cache.glob("*.mp4"), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    while files and total > max_mb * 2**20:
        victim = files.pop(0)
        total -= victim.stat().st_size
        victim.unlink(missing_ok=True)


def build_background(scenes: list[tuple[Path, float]], duration: float, out: Path, w: int, h: int, fps: int,
                     rng: random.Random) -> Path:
    """Режет каждый клип на кусок нужной длины одного формата и склеивает без перекодирования."""
    work = out.parent / "broll_seg"
    work.mkdir(parents=True, exist_ok=True)
    segs: list[tuple[Path, float]] = []
    for i, (clip, length) in enumerate(scenes):
        src = media.duration(clip)
        start = rng.uniform(0, max(0.0, src - length - 0.3)) if src > length + 1 else 0.0
        part = work / f"s{i:02d}.mp4"
        media.run(["ffmpeg", "-y", "-ss", f"{start:.2f}", "-stream_loop", "-1", "-i", str(clip), "-t", f"{length:.2f}",
                   "-an", "-vf", f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps={fps}",
                   "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-pix_fmt", "yuv420p", "-threads", "1",
                   str(part)])
        segs.append((part, media.duration(part)))
    need = duration + 2.5
    listing, total, i = [], 0.0, 0
    while total < need:
        part, d = segs[i % len(segs)]
        listing.append(f"file '{part.resolve()}'")
        total += d
        i += 1
    lst = work / "list.txt"
    lst.write_text("\n".join(listing), encoding="utf-8")
    media.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-t", f"{need:.2f}", "-c", "copy", str(out)])
    for part, _ in segs:
        part.unlink(missing_ok=True)
    lst.unlink(missing_ok=True)
    return out


def build_for(visuals: list[str], duration: float, workdir: Path, cfg: dict, rng: random.Random,
              windows: list[tuple[float, str]] | None = None) -> Path:
    """Собирает фон нужной длины из клипов по теме. Бросает исключение, если ничего не нашлось.

    windows — [(длина, запрос), ...]: кадры под конкретные куски озвучки (по одному запросу на каждый факт)."""
    bc, vc = cfg["broll"], cfg["video"]
    cache = Path(cfg["paths"]["backgrounds_dir"]).parent / "broll_cache"
    library = library_clips(cfg)
    seg = float(bc["scene_seconds"])
    specs: list[tuple[str, float]] = []  # (запрос, длина кадра)
    if windows:
        for length, query in windows:
            k = max(1, round(length / seg))
            specs += [(query or (visuals[0] if visuals else rng.choice(GENERIC)), length / k)] * k
    else:
        for i in range(max(2, math.ceil((duration + 2.5) / seg))):
            specs.append((visuals[i % len(visuals)] if visuals and rng.random() < 0.7 else rng.choice(GENERIC), seg))
    used: set[str] = set()
    scenes: list[tuple[Path, float]] = []
    for query, length in specs:
        clip = None
        for attempt in (query, rng.choice(GENERIC)):  # не нашли по теме — берём красивый общий план
            if api_keys():
                try:
                    clip = _get_clip(attempt, cache, rng, used)
                except Exception as e:
                    log.warning("видео «%s»: %s", attempt, e)
            if clip:
                break
        if not clip and library:
            clip = _library_clip(query, library, rng, used)
        if clip:
            scenes.append((clip, length))
    if not scenes:
        raise RuntimeError("не удалось получить ни одного видеоклипа")
    out = workdir / "broll_bg.mp4"
    build_background(scenes, duration, out, vc["width"], vc["height"], vc["fps"], rng)
    prune_cache(cache, int(bc["cache_mb"]))
    return out
