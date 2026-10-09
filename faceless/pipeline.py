"""Конвейер: Reddit → адаптация → части → озвучка → субтитры → рендер → очередь публикации."""
from __future__ import annotations

import logging
import random
import re
import shutil
from datetime import datetime
from pathlib import Path

from . import adapt, broll, card, reddit, render, subtitles, tts
from .models import Part, Post, Script
from .schedule import next_slots
from .storage import Store
from .text import narration, parse_segments, phrases, split_parts

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
            if any(code in str(e) for code in ("403", "401", "429")):
                log.warning("Reddit не отдаёт данные без одобренного ключа. Свои истории можно добавлять "
                            "командой: faceless story")
    posts.sort(key=lambda p: p.score, reverse=True)
    return posts


def produce(post: Post, script: Script, cfg: dict, store: Store, rng: random.Random) -> list[Path]:
    vc = cfg["video"]
    ph = phrases(cfg["text"]["language"])
    facts = bool(script.segments)
    parts = ([Part(index=1, total=1, title=script.title, body=script.body)] if facts  # ролик с фактами не режем
             else split_parts(script, vc["max_part_seconds"], language=cfg["text"]["language"]))
    slots = next_slots(len(parts), publish_times=cfg["schedule"]["publish_times"],
                       tz=cfg["schedule"]["timezone"], taken=store.taken_slots())
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = Path(cfg["paths"]["output_dir"]) / f"{stamp}-{post.id}-{slug(script.title)}"
    highlight = rng.choice(vc["highlight_colors"])
    voice_rng_seed = rng.random()  # один голос на все части истории

    outputs = []
    for part, slot in zip(parts, slots):
        work = base / f"part{part.index}"
        log.info("«%s», часть %d/%d: озвучиваю…", script.title[:50], part.index, part.total)
        speech = tts.synthesize(part.title, part.body, work, cfg, random.Random(voice_rng_seed),
                                pieces=[t for t, _ in script.segments] if facts else None)
        badges = ([(s, min(s + 1.7, e), f"FACT {i}") for i, (s, e) in enumerate(speech.pieces, 1)]
                  if facts and len(speech.pieces) > 1 else None)
        ass = work / "subs.ass"
        ass.write_text(subtitles.build_ass(
            speech.words, start_at=speech.title_end, end_at=speech.duration + 0.6,
            width=vc["width"], height=vc["height"], font=vc["font"], font_size=round(vc["font_size"] * vc["width"] / 1080),
            highlight=highlight, max_words=vc["words_per_caption"], badges=badges), encoding="utf-8")
        card_png = card.render_card(part.title, post.subreddit, work / "card.png", score=post.score or None,
                                    label="Did you know?" if facts else None, icon="?" if facts else None)
        out = base / f"part{part.index}.mp4"
        log.info("  голос готов (%.0f с), собираю видео…", speech.duration)
        bg_file, dim = None, 0.0
        if broll.enabled(cfg):
            try:
                log.info("  подбираю видео по теме: %s", ", ".join(script.visuals) or "общие планы")
                windows = None
                if facts and len(speech.pieces) == len(script.segments):
                    starts = [0.0] + [s for s, _ in speech.pieces[1:]]  # первый кадр идёт с самого начала, под заголовком
                    ends = starts[1:] + [speech.duration + 0.6]
                    windows = [(e - s, v) for s, e, (_, v) in zip(starts, ends, script.segments)]
                bg_file, dim = (broll.build_for(script.visuals, speech.duration, work, cfg, rng, windows),
                                cfg["broll"]["dim"])
            except Exception as e:
                log.warning("Видеофон Pexels недоступен (%s), беру обычный фон", e)
        render.render(background=bg_file, dim=dim, voice=speech.audio, subs=ass, card=card_png, title_end=speech.title_end,
                      duration=speech.duration, out=out, cfg=cfg, rng=rng)

        title = script.title if part.total == 1 else ph["meta_part"].format(
            title=script.title, i=part.index, n=part.total)
        footer = (ph["source"].format(sub=post.subreddit) if post.subreddit else ph["ai_voice"] if facts else ph["fiction"])
        desc = f"{script.description}\n\n{footer}"
        store.add_video(post_id=post.id, part=part.index, parts=part.total, path=out, title=title,
                        description=desc, tags=script.tags, publish_at=slot)
        if not cfg["paths"]["keep_work_files"]:
            shutil.rmtree(work, ignore_errors=True)  # голос, субтитры, карточка больше не нужны
        log.info("Готово: %s (%.1f с), слот %s", out, speech.duration, slot)
        outputs.append(out)
    return outputs


def _make_from_posts(cfg: dict, store: Store, rng: random.Random, count: int, subreddit: str | None) -> list[Path]:
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


def finalize(script: Script) -> Script:
    """Если текст в формате «фактов» (строки «текст | кадр»), раскладывает его на части и ставит теги."""
    segs = parse_segments(script.body)
    if segs:
        script.segments, script.body, script.kind = segs, narration(segs), "facts"
        script.tags = list(dict.fromkeys(["facts", "didyouknow", "funfacts"] + [t for t in script.tags
                                                                                 if t not in ("storytime", "fiction", "story")]))
        script.description = script.description.replace("#storytime #story", "#facts #didyouknow #shorts")
    return script


def _make_from_inbox(cfg: dict, store: Store, rng: random.Random, count: int) -> list[Path]:
    """Истории из inbox.txt: пишутся вами (или вставляются из Gemini/ChatGPT в чате), переписывать их не нужно."""
    from . import inbox

    made: list[Path] = []
    for title, body in inbox.load(cfg["paths"]["inbox"]):
        if len(made) >= count:
            break
        pid = inbox.story_id(title)
        if store.seen(pid):
            continue
        body, visuals = inbox.split_visuals(body)
        script = finalize(Script(title=title, body=body, description=f"{title} #storytime #story",
                                 tags=["storytime", "story", "fiction"], quality=10, visuals=visuals))
        post = Post(id=pid, subreddit="", title=title, body=script.body, score=0, url="")
        try:
            made += produce(post, script, cfg, store, rng)
            store.mark_post(pid, "", title, "done")
        except Exception:
            log.exception("Сборка «%s» упала", title)
            store.mark_post(pid, "", title, "failed")
    return made


def inbox_left(cfg: dict) -> int:
    from . import inbox

    store = Store(cfg["paths"]["db"])
    return sum(1 for t, _ in inbox.load(cfg["paths"]["inbox"]) if not store.seen(inbox.story_id(t)))


def _make_generated(cfg: dict, store: Store, rng: random.Random, count: int) -> list[Path]:
    """Истории, придуманные ИИ: оригинальные, без привязки к чужим постам и без выдуманных «источников»."""
    import hashlib

    made: list[Path] = []
    errors = 0
    from .adapt import llm_provider

    if llm_provider(cfg) is None:
        log.info("Нет ключа Gemini/Claude: придумывать истории нечем (можно добавлять свои: faceless inbox)")
        return made
    for _ in range(count * 3):  # запас на истории с низкой оценкой
        if len(made) >= count or errors >= 2:
            break
        try:
            script = adapt.generate_story(cfg, store.recent_titles("gen-"), rng)
        except Exception as e:
            errors += 1
            log.warning("Не удалось придумать историю: %s", e)
            continue
        script = finalize(script)
        post = Post(id="gen-" + hashlib.sha1(script.title.encode()).hexdigest()[:10], subreddit="",
                    title=script.title, body=script.body, score=0, url="")
        if store.seen(post.id) or script.quality < cfg["text"]["min_quality"]:
            log.info("Пропуск придуманной истории «%s» (повтор или оценка %d)", script.title, script.quality)
            continue
        try:
            made += produce(post, script, cfg, store, rng)
            store.mark_post(post.id, "", script.title, "done")
        except Exception:
            log.exception("Сборка «%s» упала", script.title)
            store.mark_post(post.id, "", script.title, "failed")
    return made


def make(cfg: dict, count: int, subreddit: str | None = None, seed: int | None = None, fill: bool = False,
         limit: int | None = None) -> list[Path]:
    """fill=True: не больше, чем нужно, чтобы очередь готовых роликов дошла до autopilot.queue_target."""
    store = Store(cfg["paths"]["db"])
    if fill:
        made: list[Path] = []
        for _ in range(limit or 8):  # страховка от бесконечного цикла, если истории не получаются
            if store.undelivered() >= cfg["autopilot"]["queue_target"]:
                break
            new = _make(cfg, store, 1, subreddit, random.Random(seed))
            if not new:
                break
            made += new
        return made
    return _make(cfg, store, count, subreddit, random.Random(seed))


def _make(cfg: dict, store: Store, count: int, subreddit: str | None, rng: random.Random) -> list[Path]:
    import os

    source = cfg["stories"]["source"]
    made: list[Path] = []
    # Reddit с 2025 года отдаёт данные только по одобренному ключу; без ключей в режиме auto его не трогаем
    if source == "reddit" or (source == "auto" and os.environ.get("REDDIT_CLIENT_ID")):
        made += _make_from_posts(cfg, store, rng, count, subreddit)
    if len(made) < count and source in ("auto", "generate", "inbox"):
        made += _make_from_inbox(cfg, store, rng, count - len(made))
    if len(made) < count and source in ("auto", "generate"):
        made += _make_generated(cfg, store, rng, count - len(made))
    return made


def publish(cfg: dict, dry_run: bool = False) -> None:
    """YouTube: грузим всё из очереди заранее (publishAt). TikTok: только наступившие слоты."""
    from datetime import timezone

    store = Store(cfg["paths"]["db"])
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    targets = []
    if cfg["youtube"]["enabled"] and not Path(cfg["youtube"]["token"]).exists():
        log.warning("YouTube не подключён (нет %s) — пропускаю. Подключить: faceless setup", cfg["youtube"]["token"])
    elif cfg["youtube"]["enabled"]:
        from . import youtube
        targets.append(("youtube", youtube.upload, lambda r: True))
    if cfg["tiktok"]["enabled"]:
        from . import tiktok
        targets.append(("tiktok", tiktok.upload, lambda r: r["publish_at"] <= now))
    import os

    if cfg["telegram"]["enabled"] or (os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID")):
        from . import telegram
        targets.append(("telegram", telegram.upload, lambda r: r["publish_at"] <= now))

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

    if cfg["paths"]["delete_after_upload"] and targets and not dry_run:
        cleanup_uploaded(store, [name for name, _, _ in targets])


def cleanup_uploaded(store: Store, platforms: list[str]) -> None:
    """Удаляет mp4, которые уже загружены на все включённые площадки: на маленьком диске это важно."""
    for row in store.videos(limit=1000):
        path = Path(row["path"])
        if path.exists() and all(row[f"{p}_id"] for p in platforms):
            path.unlink()
            if path.parent.exists() and not any(path.parent.iterdir()):
                path.parent.rmdir()
            log.info("Удалён загруженный файл %s", path)
