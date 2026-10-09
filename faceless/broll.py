"""Видеофон по теме истории: короткие кадры с Pexels (бесплатно, лицензия разрешает коммерческое использование).

Каждые ~5 секунд картинка меняется (приём «смена кадра»), кадры подбираются по ключевым словам истории
(visuals) вперемешку с красивыми общими планами (город ночью, дождь, океан…). Ключ API бесплатный: pexels.com/api.
"""
from __future__ import annotations

import logging
import math
import os
import random
from pathlib import Path

import requests

from . import media

log = logging.getLogger("faceless")

API = "https://api.pexels.com/videos/search"
GENERIC = [
    "city night lights", "rain on window", "ocean waves", "forest path", "slow motion water", "neon lights",
    "clouds timelapse", "candle flame", "coffee pouring", "street at night", "mountain mist", "paint swirl",
    "snow falling", "aerial city", "sunset sky", "highway night", "city rain", "smoke slow motion",
]
MAX_CLIP_MB = 30


def enabled(cfg: dict) -> bool:
    return bool(cfg.get("broll", {}).get("enabled") and os.environ.get("PEXELS_API_KEY"))


def search(query: str, key: str, per_page: int = 15) -> list[dict]:
    r = requests.get(API, headers={"Authorization": key}, timeout=20,
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


def _get_clip(query: str, key: str, cache: Path, rng: random.Random, used: set[int]) -> Path | None:
    videos = search(query, key)
    rng.shuffle(videos)
    for video in videos:
        if video["id"] in used:
            continue
        link = pick_file(video)
        if not link:
            continue
        dest = cache / f"{video['id']}.mp4"
        if not dest.exists():
            download(link, dest)
        used.add(video["id"])
        return dest
    return None


def prune_cache(cache: Path, max_mb: int) -> None:
    files = sorted(cache.glob("*.mp4"), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    while files and total > max_mb * 2**20:
        victim = files.pop(0)
        total -= victim.stat().st_size
        victim.unlink(missing_ok=True)


def build_background(clips: list[Path], duration: float, out: Path, w: int, h: int, fps: int,
                     seg: float, rng: random.Random) -> Path:
    """Нарезает клипы на куски по ~seg секунд одного формата и склеивает без перекодирования."""
    work = out.parent / "broll_seg"
    work.mkdir(parents=True, exist_ok=True)
    segs: list[tuple[Path, float]] = []
    for i, clip in enumerate(clips):
        length = media.duration(clip)
        start = rng.uniform(0, max(0.0, length - seg - 0.3)) if length > seg + 1 else 0.0
        part = work / f"s{i:02d}.mp4"
        media.run(["ffmpeg", "-y", "-ss", f"{start:.2f}", "-i", str(clip), "-t", f"{seg:.2f}", "-an",
                   "-vf", f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps={fps}",
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


def build_for(visuals: list[str], duration: float, workdir: Path, cfg: dict, rng: random.Random) -> Path:
    """Собирает фон нужной длины из клипов по теме. Бросает исключение, если ничего не нашлось."""
    key, bc, vc = os.environ["PEXELS_API_KEY"], cfg["broll"], cfg["video"]
    cache = Path(cfg["paths"]["backgrounds_dir"]).parent / "broll_cache"
    seg = float(bc["scene_seconds"])
    n = max(2, math.ceil((duration + 2.5) / seg))
    used: set[int] = set()
    clips: list[Path] = []
    for i in range(n):
        query = visuals[i % len(visuals)] if visuals and rng.random() < 0.7 else rng.choice(GENERIC)
        for attempt in (query, rng.choice(GENERIC)):  # не нашли по теме — берём красивый общий план
            try:
                clip = _get_clip(attempt, key, cache, rng, used)
            except Exception as e:
                log.warning("Pexels «%s»: %s", attempt, e)
                clip = None
            if clip:
                clips.append(clip)
                break
    if not clips:
        raise RuntimeError("не удалось получить ни одного видеоклипа")
    out = workdir / "broll_bg.mp4"
    build_background(clips, duration, out, vc["width"], vc["height"], vc["fps"], seg, rng)
    prune_cache(cache, int(bc["cache_mb"]))
    return out
