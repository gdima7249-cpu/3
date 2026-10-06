from __future__ import annotations

import argparse
import json
import logging
import random
from pathlib import Path

from . import adapt, media, pipeline
from .config import load_config
from .models import Post
from .storage import Store

DEMO_POST = Post(
    id="demo", subreddit="TrueOffMyChest", score=24100, url="",
    title="Сосед три года воровал мой Wi-Fi, и я решил ему отомстить",
    body=(
        "Три года назад я заметил, что интернет по вечерам еле ползёт. Зашёл в настройки роутера и увидел "
        "чужое устройство с именем «Папин ноутбук». Пароль у меня был простой, признаю. Я не стал его менять. "
        "Вместо этого я настроил так, чтобы все картинки на его устройстве переворачивались вверх ногами. "
        "Через неделю сосед постучал ко мне и спросил, не барахлит ли у меня интернет. Я сказал, что всё отлично. "
        "Ещё через неделю он купил себе новый ноутбук. Картинки, конечно, снова были перевёрнуты. "
        "Вчера он пришёл с тортом и признался во всём. Теперь мы делим счёт за интернет пополам. "
        "А вы бы простили такого соседа?"
    ),
)


def _demo_background(path: Path, seconds: int = 90) -> Path:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        media.run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"mandelbrot=s=720x1280:r=30",
                   "-t", str(seconds), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                   str(path)])
    return path


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="faceless", description="Фабрика faceless-роликов из историй Reddit")
    ap.add_argument("-c", "--config", default="config.toml")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)

    mk = sub.add_parser("make", help="собрать N роликов из свежих постов")
    mk.add_argument("-n", "--count", type=int, default=1)
    mk.add_argument("-s", "--subreddit")
    mk.add_argument("--seed", type=int)

    ff = sub.add_parser("make-file", help="собрать ролик из локального JSON (id, subreddit, title, body, comments)")
    ff.add_argument("path")

    sub.add_parser("candidates", help="показать подходящие посты, ничего не рендеря")

    pb = sub.add_parser("publish", help="загрузить очередь на YouTube/TikTok")
    pb.add_argument("--dry-run", action="store_true")

    sub.add_parser("auth-youtube", help="однократная авторизация YouTube (OAuth)")
    sub.add_parser("status", help="последние ролики и статус публикаций")

    dm = sub.add_parser("demo", help="офлайн-демо: тишина вместо голоса, сгенерированный фон")
    dm.add_argument("--tts", default="silent", choices=["silent", "edge", "elevenlabs"])

    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config(args.config)

    if args.cmd == "make":
        for p in pipeline.make(cfg, args.count, args.subreddit, args.seed):
            print(p)
    elif args.cmd == "make-file":
        data = json.loads(Path(args.path).read_text(encoding="utf-8"))
        post = Post(id=data.get("id", Path(args.path).stem), subreddit=data.get("subreddit", "stories"),
                    title=data["title"], body=data.get("body", ""), score=data.get("score", 0),
                    url=data.get("url", ""), comments=data.get("comments", []))
        store = Store(cfg["paths"]["db"])
        for p in pipeline.produce(post, adapt.adapt(post, cfg), cfg, store, random.Random()):
            print(p)
    elif args.cmd == "candidates":
        for post in pipeline.candidates(cfg, Store(cfg["paths"]["db"])):
            size = len(post.body) + sum(map(len, post.comments))
            print(f"{post.score:>7}  r/{post.subreddit:<20} {size:>5} симв.  {post.title[:80]}")
    elif args.cmd == "publish":
        pipeline.publish(cfg, dry_run=args.dry_run)
    elif args.cmd == "auth-youtube":
        from . import youtube
        youtube.credentials(cfg, interactive=True)
        print("Токен сохранён в", cfg["youtube"]["token"])
    elif args.cmd == "status":
        for r in Store(cfg["paths"]["db"]).videos():
            yt = r["youtube_id"] or (f"ошибка: {r['youtube_error'][:40]}" if r["youtube_error"] else "—")
            tt = r["tiktok_id"] or (f"ошибка: {r['tiktok_error'][:40]}" if r["tiktok_error"] else "—")
            print(f"#{r['id']:<4} {r['publish_at']}  YT:{yt:<14} TT:{tt:<14} {r['title'][:60]}")
    elif args.cmd == "demo":
        out = Path(cfg["paths"]["output_dir"]) / "demo"
        cfg["paths"]["db"] = str(out / "demo.sqlite3")
        cfg["paths"]["output_dir"] = str(out)
        if not any(Path(cfg["paths"]["backgrounds_dir"]).glob("*.mp4")):
            cfg["paths"]["backgrounds_dir"] = str(_demo_background(out / "bg" / "mandelbrot.mp4").parent)
        cfg["text"]["adapter"] = "none"
        cfg["tts"]["engine"] = args.tts
        for p in pipeline.produce(DEMO_POST, adapt.adapt(DEMO_POST, cfg), cfg, Store(cfg["paths"]["db"]),
                                  random.Random(7)):
            print(p)
