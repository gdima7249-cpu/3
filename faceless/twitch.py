"""Нарезки Twitch: самые просматриваемые клипы по популярным играм → вертикальное видео с субтитрами.

Откуда клипы: официальный Twitch API (Helix), бесплатный ключ приложения с dev.twitch.tv
(TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET). Скачивание: yt-dlp. Субтитры: faster-whisper (если установлен).

Кадр 720x1280: сверху заголовок, в центре сам клип (чуть увеличенный), под ним субтитры, фон — тот же клип в размытии.
В описании всегда ссылка на канал стримера и на оригинальный клип.
"""
from __future__ import annotations

import json
import logging
import os
import random
import re
import shutil
import textwrap
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from . import media, subtitles
from .models import Word
from .schedule import next_slots
from .storage import Store

log = logging.getLogger("faceless")

TOKEN_URL = "https://id.twitch.tv/oauth2/token"
HELIX = "https://api.twitch.tv/helix/"


def configured() -> bool:
    return bool(os.environ.get("TWITCH_CLIENT_ID") and os.environ.get("TWITCH_CLIENT_SECRET"))


# ---------------------------------------------------------------- API
def _token_file(cfg: dict) -> Path:
    return Path(cfg["paths"]["db"]).with_name("twitch_token.json")


def app_token(cfg: dict, fresh: bool = False) -> str:
    """Токен приложения (client credentials) живёт ~2 месяца; держим его в data/ и обновляем при истечении."""
    f = _token_file(cfg)
    if not fresh and f.exists():
        try:
            data = json.loads(f.read_text())
            if data["expires"] > time.time() + 3600:
                return data["token"]
        except (ValueError, KeyError):
            pass
    r = requests.post(TOKEN_URL, timeout=20, data={
        "client_id": os.environ["TWITCH_CLIENT_ID"], "client_secret": os.environ["TWITCH_CLIENT_SECRET"],
        "grant_type": "client_credentials"})
    if r.status_code in (400, 401, 403):
        raise RuntimeError("Twitch не принял Client ID / Client Secret. Проверьте их на dev.twitch.tv и запустите faceless setup")
    r.raise_for_status()
    data = r.json()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"token": data["access_token"], "expires": time.time() + data.get("expires_in", 3600)}))
    f.chmod(0o600)
    return data["access_token"]


def helix(cfg: dict, path: str, params: dict | list) -> list[dict]:
    for attempt in (0, 1):
        r = requests.get(HELIX + path, params=params, timeout=20, headers={
            "Client-Id": os.environ["TWITCH_CLIENT_ID"], "Authorization": f"Bearer {app_token(cfg, fresh=bool(attempt))}"})
        if r.status_code == 401 and not attempt:
            continue  # токен отозван — берём новый и повторяем один раз
        r.raise_for_status()
        return r.json().get("data", [])
    return []


def games(cfg: dict) -> dict[str, str]:
    """{game_id: название}: игры из настроек или текущий топ Twitch (без музыки и прочих рискованных категорий)."""
    tc = cfg["twitch"]
    if tc["games"]:
        found = helix(cfg, "games", [("name", g) for g in tc["games"]])
        missing = {g.lower() for g in tc["games"]} - {g["name"].lower() for g in found}
        if missing:
            log.warning("Twitch не знает игры: %s (название должно совпадать с сайтом Twitch)", ", ".join(sorted(missing)))
    else:
        found = helix(cfg, "games/top", {"first": 40})
    skip = {g.lower() for g in tc["exclude_games"]}
    out = {g["id"]: g["name"] for g in found if g["name"].lower() not in skip}
    return dict(list(out.items())[: max(1, int(tc["top_games"]))]) if not tc["games"] else out


def clip_id(clip: dict) -> str:
    return "tw-" + clip["id"]


def candidates(cfg: dict, store: Store) -> list[dict]:
    """Свежие клипы по играм, лучшие сверху; уже использованные, слишком короткие/длинные и чужого языка — отсеяны."""
    tc = cfg["twitch"]
    since = (datetime.now(timezone.utc) - timedelta(hours=tc["hours"])).isoformat(timespec="seconds").replace("+00:00", "Z")
    allow = {s.lower() for s in tc["allow_streamers"]}
    block = {s.lower() for s in tc["block_streamers"]}
    out: list[dict] = []
    for gid, name in games(cfg).items():
        try:
            clips = helix(cfg, "clips", {"game_id": gid, "started_at": since, "first": 50})
        except Exception as e:
            log.warning("Twitch, клипы «%s»: %s", name, e)
            continue
        for c in clips:
            streamer = c.get("broadcaster_name", "").lower()
            if (c.get("language", "").split("-")[0] != tc["language"] or c.get("view_count", 0) < tc["min_views"]
                    or not (tc["min_seconds"] <= c.get("duration", 0) <= tc["max_seconds"])
                    or streamer in block or (allow and streamer not in allow) or store.seen(clip_id(c))):
                continue
            c["game_name"] = name
            out.append(c)
    out.sort(key=lambda c: c["view_count"], reverse=True)
    return out


# ---------------------------------------------------------------- скачивание и субтитры
def download(url: str, dest: Path) -> Path:
    import yt_dlp

    dest.parent.mkdir(parents=True, exist_ok=True)
    opts = {"outtmpl": str(dest), "format": "best[height<=1080][ext=mp4]/best[ext=mp4]/best", "quiet": True,
            "no_warnings": True, "noprogress": True, "overwrites": True, "max_filesize": 200 * 2**20}
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    if not dest.exists():
        raise RuntimeError("клип не скачался")
    return dest


_MODEL = None


def transcribe(path: Path, cfg: dict) -> list[Word]:
    """Слова с таймингами (faster-whisper). Нет библиотеки или ошибка — ролик просто без субтитров."""
    global _MODEL
    if not cfg["twitch"]["subtitles"]:
        return []
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        log.info("  субтитров не будет: не установлен faster-whisper (на диске мало места)")
        return []
    try:
        if _MODEL is None:
            models = Path(cfg["paths"]["db"]).parent / "models"
            _MODEL = WhisperModel(cfg["twitch"]["whisper_model"], device="cpu", compute_type="int8", cpu_threads=1,
                                  download_root=str(models))
        segments, _ = _MODEL.transcribe(str(path), language=cfg["twitch"]["language"], word_timestamps=True,
                                        vad_filter=True, beam_size=1)
        words = []
        for seg in segments:
            for w in seg.words or []:
                text = w.word.strip()
                if text:
                    words.append(Word(text=text, start=float(w.start), end=float(w.end)))
        return words
    except Exception as e:
        log.warning("  субтитры не получились: %s", e)
        return []


# ---------------------------------------------------------------- картинка с заголовком
def clean_title(title: str) -> str:
    t = re.sub(r"\s+", " ", title).strip(" -|")
    return t[:1].upper() + t[1:] if t else "Clip"


def overlay_png(title: str, streamer: str, out: Path, w: int, h: int, video_top: int, video_bottom: int) -> Path:
    """Прозрачный слой во весь кадр: заголовок над видео, «twitch.tv/имя» под ним."""
    from PIL import Image, ImageDraw

    from .card import _font

    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    size = round(w * 0.068)
    font = _font("bold", size)
    title = re.sub(r"\s+", " ", re.sub(r"[^\w\s.,!?'\"&%$#@:;()+/-]", "", title)).strip() or "CLIP"  # эмодзи шрифт не рисует
    lines = textwrap.wrap(title.upper(), width=20)[:3]
    line_h = round(size * 1.2)
    y = max(round(h * 0.06), video_top - round(w * 0.05) - line_h * len(lines))
    for line in lines:
        d.text((w // 2, y), line, font=font, fill="white", anchor="ma", stroke_width=max(3, size // 10), stroke_fill="black")
        y += line_h
    small = _font("bold", round(w * 0.036))
    d.text((w // 2, video_bottom + round(w * 0.025)), f"twitch.tv/{streamer}", font=small, fill=(220, 200, 255, 255),
           anchor="ma", stroke_width=3, stroke_fill="black")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    return out


def layout(cfg: dict) -> tuple[int, int, int, int]:
    """(ширина, высота, верх видео, высота видео)."""
    w, h = cfg["video"]["width"], cfg["video"]["height"]
    fg_h = int(w * 9 / 16 * float(cfg["twitch"]["zoom"])) // 2 * 2
    top = (h - fg_h) // 2 - round(h * 0.03)
    return w, h, top, fg_h


def render_clip(src: Path, words: list[Word], title: str, streamer: str, out: Path, cfg: dict,
                rng: random.Random) -> float:
    vc = cfg["video"]
    w, h, top, fg_h = layout(cfg)
    dur = media.duration(src)
    work = out.parent / (out.stem + "_work")
    work.mkdir(parents=True, exist_ok=True)
    png = overlay_png(title, streamer, work / "overlay.png", w, h, top, top + fg_h)
    subs = work / "subs.ass"
    font_size = round(vc["font_size"] * w / 1080)
    sub_y = min(h - round(h * 0.1), top + fg_h + round(h * 0.11))
    subs.write_text(subtitles.build_ass(
        words, start_at=0, end_at=dur, width=w, height=h, font=vc["font"], font_size=font_size,
        highlight=rng.choice(vc["highlight_colors"]), max_words=vc["words_per_caption"], pos_y=sub_y), encoding="utf-8")
    fps = vc["fps"]
    vf = (f"[0:v]scale={w // 4}:{h // 4}:force_original_aspect_ratio=increase,crop={w // 4}:{h // 4},boxblur=8:2,"
          f"scale={w}:{h},eq=brightness=-0.12:saturation=1.2,setsar=1,fps={fps}[bg];"
          f"[0:v]scale={w}:{fg_h}:force_original_aspect_ratio=increase,crop={w}:{fg_h},setsar=1,fps={fps}[fg];"
          f"[bg][fg]overlay=0:{top}[v1];[v1][1:v]overlay=0:0[v2];[v2]ass={subs.name}[v]")
    cmd = ["ffmpeg", "-y", "-i", str(src.resolve()), "-loop", "1", "-i", str(png.resolve()),
           "-filter_complex", vf + ";[0:a]aresample=44100,loudnorm=I=-14:TP=-1.5:LRA=11[a]",
           "-map", "[v]", "-map", "[a]", "-t", f"{dur:.2f}",
           "-c:v", "libx264", "-preset", vc["preset"], "-crf", str(vc.get("crf", 23)), "-threads", str(vc["threads"]),
           "-pix_fmt", "yuv420p", "-r", str(fps), "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
           "-movflags", "+faststart", str(out.resolve())]
    out.parent.mkdir(parents=True, exist_ok=True)
    media.run(cmd, cwd=work)
    if not cfg["paths"]["keep_work_files"]:
        shutil.rmtree(work, ignore_errors=True)
    return dur


# ---------------------------------------------------------------- метаданные и сборка
def _tag(s: str) -> str:
    return re.sub(r"[^\w]", "", s)


def metadata(clip: dict) -> tuple[str, str, list[str]]:
    title, streamer, game = clean_title(clip["title"]), clip["broadcaster_name"], clip["game_name"]
    yt_title = f"{title} | {streamer}"
    if len(yt_title) > 90:
        yt_title = yt_title[:87].rstrip() + "…"
    desc = (f"{title} — {streamer} playing {game} on Twitch.\n\n"
            f"🎮 Streamer: https://twitch.tv/{streamer.lower()} (go give them a follow!)\n"
            f"🎬 Original clip: {clip['url']}\n\n"
            f"#shorts #twitch #{_tag(game)} #{_tag(streamer)}")
    tags = list(dict.fromkeys(["twitch", "twitch clips", "streamer", "gaming", streamer, game, "funny moments"]))
    return yt_title, desc, tags


def make(cfg: dict, store: Store, count: int, rng: random.Random) -> list[Path]:
    if not configured():
        log.info("Нет ключа Twitch (TWITCH_CLIENT_ID/SECRET): faceless setup")
        return []
    made: list[Path] = []
    per_streamer: dict[str, int] = {}
    for clip in candidates(cfg, store):
        if len(made) >= count:
            break
        streamer = clip["broadcaster_name"]
        if per_streamer.get(streamer.lower(), 0) >= 1:
            continue  # разнообразие: не больше одного клипа одного стримера за запуск
        cid = clip_id(clip)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        base = Path(cfg["paths"]["output_dir"]) / f"{stamp}-{cid}"
        src = base / "source.mp4"
        log.info("«%s» (%s, %s, %d просмотров): скачиваю…", clip["title"][:50], streamer, clip["game_name"],
                 clip["view_count"])
        try:
            download(clip["url"], src)
            log.info("  распознаю речь для субтитров…")
            words = transcribe(src, cfg)
            log.info("  собираю вертикальное видео…")
            out = base / "clip.mp4"
            dur = render_clip(src, words, clean_title(clip["title"]), streamer, out, cfg, rng)
        except Exception as e:
            log.warning("Клип %s пропущен: %s", clip["url"], str(e)[-500:])
            store.mark_post(cid, streamer, clip["title"], "failed", str(e)[:300])
            shutil.rmtree(base, ignore_errors=True)
            continue
        src.unlink(missing_ok=True)
        title, desc, tags = metadata(clip)
        slot = next_slots(1, publish_times=cfg["schedule"]["publish_times"], tz=cfg["schedule"]["timezone"],
                          taken=store.taken_slots())[0]
        store.add_video(post_id=cid, part=1, parts=1, path=out, title=title, description=desc, tags=tags, publish_at=slot)
        store.mark_post(cid, streamer, clip["title"], "done")
        per_streamer[streamer.lower()] = per_streamer.get(streamer.lower(), 0) + 1
        log.info("Готово: %s (%.1f с), слот %s", out, dur, slot)
        made.append(out)
    if not made:
        log.info("Подходящих новых клипов не нашлось (фильтры: язык %s, от %d просмотров, %d–%d с)",
                 cfg["twitch"]["language"], cfg["twitch"]["min_views"], cfg["twitch"]["min_seconds"],
                 cfg["twitch"]["max_seconds"])
    return made
