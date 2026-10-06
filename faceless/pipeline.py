"""Конвейер: Reddit → адаптация → части → озвучка → субтитры → рендер → очередь публикации."""
from __future__ import annotations

import logging
import random
import re
from datetime import datetime
from pathlib import Path

from . import adapt, card, reddit, render, subtitles, tts
from .models import Post, Script
from .schedule import next_slots
from .storage import Store
from .text import phrases, split_parts

log = logging.getLogger("faceless")


def slug(text: str, n: int = 40) -> str:
    s = re.sub(r"[^\w]+", "-", text.lower(), flags=re.U).strip("-")
    return s[:n] or "video"


def candidates(cfg: dict, store: Store, subreddit: str | None = None) -> list[Post]:
    subs = [subreddit] if subreddit else cfg["reddit"]["subreddits"]
    posts: list[Post] = []
    for sub in subs:
        try:
            posts += [p for p in reddit.fetch_posts(sub, cfg) if not store.seen(p.id)]
        except Exception as e:  # один сабреддит не должен ронять весь прогон
            log.warning("r/%s: %s", sub, e)
    posts.sort(key=lambda p: p.score, reverse=True)
    return posts


def produce(post: Post, script: Script, cfg: dict, store: Store, rng: random.Random) -> list[Path]:
    vc = cfg["video"]
    ph = phrases(cfg["text"]["language"])
    parts = split_parts(script, vc["max_part_seconds"], language=cfg["text"]["language"])
    slots = next_slots(len(parts), publish_times=cfg["schedule"]["publish_times"],
                       tz=cfg["schedule"]["timezone"], taken=store.taken_slots())
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = Path(cfg["paths"]["output_dir"]) / f"{stamp}-{post.id}-{slug(script.title)}"
    highlight = rng.choice(vc["highlight_colors"])
    voice_rng_seed = rng.random()  # один голос на все части истории

    outputs = []
    for part, slot in zip(parts, slots):
        work = base / f"part{part.index}"
        speech = tts.synthesize(part.title, part.body, work, cfg, random.Random(voice_rng_seed))
        ass = work / "subs.ass"
        ass.write_text(subtitles.build_ass(
            speech.words, start_at=speech.title_end, end_at=speech.duration + 0.6,
            width=vc["width"], height=vc["height"], font=vc["font"], font_size=vc["font_size"],
            highlight=highlight, max_words=vc["words_per_caption"]), encoding="utf-8")
        card_png = card.render_card(part.title, post.subreddit, work / "card.png", score=post.score or None)
        out = base / f"part{part.index}.mp4"
        render.render(voice=speech.audio, subs=ass, card=card_png, title_end=speech.title_end,
                      duration=speech.duration, out=out, cfg=cfg, rng=rng)

        title = script.title if part.total == 1 else ph["meta_part"].format(
            title=script.title, i=part.index, n=part.total)
        desc = f"{script.description}\n\n" + ph["source"].format(sub=post.subreddit)
        store.add_video(post_id=post.id, part=part.index, parts=part.total, path=out, title=title,
                        description=desc, tags=script.tags, publish_at=slot)
        log.info("Готово: %s (%.1f с), слот %s", out, speech.duration, slot)
        outputs.append(out)
    return outputs


def make(cfg: dict, count: int, subreddit: str | None = None, seed: int | None = None) -> list[Path]:
    store = Store(cfg["paths"]["db"])
    rng = random.Random(seed)
    made: list[Path] = []
    for post in candidates(cfg, store, subreddit):
        if len(made) >= count:
            break
        try:
            script = adapt.adapt(post, cfg)
        except Exception as e:
            log.warning("Адаптация %s не удалась: %s", post.id, e)
            store.mark_post(post.id, post.subreddit, post.title, "skipped", f"adapt: {e}")
            continue
        if script.quality < cfg["text"]["min_quality"]:
            log.info("Пропуск %s: оценка %d", post.id, script.quality)
            store.mark_post(post.id, post.subreddit, post.title, "skipped", f"quality {script.quality}")
            continue
        try:
            made += produce(post, script, cfg, store, rng)
            store.mark_post(post.id, post.subreddit, post.title, "done")
        except Exception:
            log.exception("Сборка %s упала", post.id)
            store.mark_post(post.id, post.subreddit, post.title, "failed")
    return made


def publish(cfg: dict, dry_run: bool = False) -> None:
    """YouTube: грузим всё из очереди заранее (publishAt). TikTok: только наступившие слоты."""
    from datetime import timezone

    store = Store(cfg["paths"]["db"])
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    targets = []
    if cfg["youtube"]["enabled"]:
        from . import youtube
        targets.append(("youtube", youtube.upload, lambda r: True))
    if cfg["tiktok"]["enabled"]:
        from . import tiktok
        targets.append(("tiktok", tiktok.upload, lambda r: r["publish_at"] <= now))

    for platform, upload, due in targets:
        for row in store.pending(platform):
            if not due(row) or not Path(row["path"]).exists():
                continue
            if dry_run:
                log.info("[dry-run] %s ← %s (%s)", platform, row["path"], row["publish_at"])
                continue
            try:
                remote_id = upload(row, cfg)
                store.set_result(row["id"], platform, remote_id, None)
                log.info("%s: %s → %s", platform, row["path"], remote_id)
            except Exception as e:
                log.exception("%s: загрузка %s упала", platform, row["path"])
                store.set_result(row["id"], platform, None, str(e)[:500])
