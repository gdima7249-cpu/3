from __future__ import annotations

import argparse
import json
import logging
import random
import shutil
from pathlib import Path

from . import adapt, media, pipeline
from .config import load_config
from .models import Post
from .storage import Store

DEMO_POST_EN = Post(
    id="demo", subreddit="TrueOffMyChest", score=24100, url="",
    title="My neighbor stole my Wi-Fi for three years, so I got revenge",
    body=(
        "Three years ago I noticed my internet crawling every evening. I checked the router and saw a device "
        "I didn't recognize, called Dad's Laptop. My password was weak, I admit it. I didn't change it. "
        "Instead, I set things up so every image on his device loaded upside down. "
        "A week later my neighbor knocked and asked if my internet was acting weird. I said it was perfect. "
        "Another week later he bought a brand new laptop. The pictures were upside down again, of course. "
        "Yesterday he showed up with a cake and confessed everything. Now we split the internet bill. "
        "Would you have forgiven him?"
    ),
)

DEMO_POST_RU = Post(
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


def post_from_text(text: str, post_id: str = "", subreddit: str = "stories") -> Post:
    """Первая непустая строка — заголовок, остальное — текст истории."""
    import hashlib

    lines = [ln.rstrip() for ln in text.strip().splitlines()]
    while lines and not lines[0].strip():
        lines.pop(0)
    if not lines:
        raise ValueError("Пустой текст")
    title, body = lines[0].strip(), "\n".join(lines[1:]).strip()
    from .reddit import clean_text
    return Post(id=post_id or "txt-" + hashlib.sha1(text.encode()).hexdigest()[:8], subreddit=subreddit,
                title=clean_text(title), body=clean_text(body), score=0, url="")


def _demo_background(path: Path, seconds: int = 30) -> Path:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        media.run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"mandelbrot=s=720x1280:r=30",
                   "-t", str(seconds), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                   str(path)])
    return path


def _in(iso: str) -> str:
    """«через 3 ч 20 мин» / «пора отправлять» вместо времени в UTC."""
    from datetime import datetime, timezone

    left = (datetime.fromisoformat(iso) - datetime.now(timezone.utc)).total_seconds()
    if left <= 0:
        return "пора отправлять"
    h, m = divmod(int(left // 60), 60)
    return f"через {h} ч {m:02d} мин" if h else f"через {m} мин"


def _inbox_waiting(cfg: dict, store: Store) -> list[tuple[str, str]]:
    from . import inbox

    return [(t, b) for t, b in inbox.load(cfg["paths"]["inbox"]) if not store.seen(inbox.story_id(t))]


def _print_overview(cfg: dict) -> None:
    """Короткая сводка «что настроено, а что нет» — чтобы всегда было видно состояние."""
    from . import __version__

    def mark(ok: bool) -> str:
        return "✔" if ok else "✖"

    bgs = [p for p in Path(cfg["paths"]["backgrounds_dir"]).glob("*") if p.suffix.lower() in {".mp4", ".mov", ".mkv", ".webm"}]
    free_mb = shutil.disk_usage(".").free // 2**20
    secrets, token = Path(cfg["youtube"]["client_secrets"]), Path(cfg["youtube"]["token"])
    print(f"faceless {__version__}")
    print(f"  {mark(secrets.exists())} Файл Google (client_secret.json)")
    print(f"  {mark(token.exists())} Вход в YouTube")
    import os

    tg = bool(os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID"))
    print(f"  {mark(tg)} Telegram-бот подключён" + ("" if tg else "   (faceless setup: токен бота, затем напишите боту /start)"))
    left = pipeline.inbox_left(cfg)
    print(f"  {mark(left > 0 or adapt.llm_provider(cfg) is not None)} Источник историй: "
          f"ИИ {'подключён' if adapt.llm_provider(cfg) else 'не подключён'}, в inbox.txt ждут: {left}")
    pex = bool(os.environ.get("PEXELS_API_KEY"))
    print(f"  {mark(pex)} Видео по теме истории (Pexels)" + ("" if pex else "   (бесплатный ключ: pexels.com/api, затем faceless setup)"))
    print(f"  {mark(True)} Фоновые видео: {len(bgs)}" + ("" if bgs else "   (не обязательно: программа сама создаст фоны; свои: faceless add-background ССЫЛКА)"))
    print(f"  Свободно на диске: {free_mb} МБ")
    if not (secrets.exists() and token.exists()) and not cfg["telegram"]["enabled"]:
        print("  Дальше: faceless setup")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="faceless", description="Фабрика faceless-роликов из историй Reddit")
    ap.add_argument("-c", "--config", default="config.toml")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)

    mk = sub.add_parser("make", help="собрать N роликов из свежих постов")
    mk.add_argument("-n", "--count", type=int, default=1)
    mk.add_argument("-s", "--subreddit")
    mk.add_argument("--max", type=int, dest="limit", help="с --fill: собрать не больше N историй за этот запуск")
    mk.add_argument("--fill", action="store_true", help="пополнить очередь до autopilot.queue_target (для автопилота)")
    mk.add_argument("--seed", type=int)

    ff = sub.add_parser("make-file", help="собрать ролик из файла: .txt (1-я строка заголовок) или .json")
    ff.add_argument("path")

    sub.add_parser("candidates", help="показать подходящие посты, ничего не рендеря")
    sub.add_parser("telegram-sync", help="забрать из Telegram истории, которые вы прислали своему боту")
    sub.add_parser("queue", help="показать очередь: готовые ролики и истории в inbox, ожидающие своей очереди")
    sd = sub.add_parser("send", help="отправить готовый ролик в Telegram прямо сейчас, не дожидаясь расписания")
    sd.add_argument("id", type=int, nargs="?", help="номер ролика из `faceless queue` (без номера: ближайший)")
    cn = sub.add_parser("cancel", help="отменить готовый ролик (и все части его истории): faceless cancel НОМЕР")
    cn.add_argument("id", type=int, help="номер ролика из `faceless queue`")
    cn.add_argument("--only-this", action="store_true", help="отменить только эту часть, а не всю историю")
    sk = sub.add_parser("skip", help="выкинуть историю из inbox, пока она не использована: faceless skip НОМЕР")
    sk.add_argument("number", type=int, help="номер истории из `faceless queue`")
    ib = sub.add_parser("inbox", help="добавить пачку историй в очередь (вставкой или из файла)")
    ib.add_argument("file", nargs="?", help="файл с историями (необязательно; без него вставьте текст)")
    sub.add_parser("story", help="вставить историю вручную (заголовок и текст) и сделать из неё ролик")

    pb = sub.add_parser("publish", help="загрузить очередь на YouTube/TikTok")
    pb.add_argument("--dry-run", action="store_true")

    st = sub.add_parser("setup", help="пошаговая настройка: файл Google, вход в YouTube, Telegram")
    st.add_argument("--keys", action="store_true", help="спросить и необязательные ключи (Claude, Reddit)")
    bg = sub.add_parser("add-background", help="добавить фон: ссылка на видео или файл, залитый на сервер")
    bg.add_argument("source", help="прямая ссылка (Pexels, Google Диск, Dropbox) или путь к файлу, напр. /tmp/video.mp4")
    bg.add_argument("--keep-source", action="store_true", help="не удалять исходный файл с сервера")
    sub.add_parser("auth-youtube", help="однократная авторизация YouTube (OAuth)")
    sub.add_parser("status", help="последние ролики и статус публикаций")
    rd = sub.add_parser("ready", help="проверка готовности для автопилота (код 0 — готово)")
    rd.add_argument("--publish", action="store_true", help="проверить готовность к публикации, а не к сборке")

    dm = sub.add_parser("demo", help="офлайн-демо: тишина вместо голоса, сгенерированный фон")
    dm.add_argument("--tts", default="silent", choices=["silent", "edge", "elevenlabs"])
    dm.add_argument("--keep", action="store_true", help="не удалять тестовый ролик после проверки")

    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config(args.config)

    if args.cmd == "make":
        from . import telegram

        try:
            made = pipeline.make(cfg, args.count, args.subreddit, args.seed, args.fill, args.limit)
        except Exception as e:
            telegram.notify(f"⚠️ faceless: сборка роликов упала: {e}")
            raise
        for p in made:
            print(p)
        if not made and args.fill and Store(cfg["paths"]["db"]).undelivered() >= cfg["autopilot"]["queue_target"]:
            print("Очередь уже заполнена, новых роликов не нужно.")
        elif not made:
            msg = ("Не удалось собрать ни одного ролика. Причина в журнале: faceless autopilot log. "
                   "Если там «User location is not supported», Gemini недоступен с этого сервера: "
                   "добавляйте истории вручную командой faceless inbox.")
            telegram.notify("⚠️ faceless: " + msg)
            raise SystemExit(msg)
    elif args.cmd == "telegram-sync":
        from . import telegram

        import os

        if not (os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID")):
            raise SystemExit("Telegram не подключён: нет токена бота или номера чата. Запустите faceless setup, "
                             "вставьте токен бота и напишите боту /start.")
        n = telegram.sync_inbox(cfg)
        print(f"Добавлено историй из Telegram: {n}. (Ответ бота придёт вам в Telegram.)")
    elif args.cmd == "queue":
        store = Store(cfg["paths"]["db"])
        rows = store.queue()
        print("ГОТОВЫЕ РОЛИКИ (ещё не доставлены):" if rows else "Готовых роликов в очереди нет.")
        for r in rows:
            part = f", часть {r['part']}/{r['parts']}" if r["parts"] > 1 else ""
            print(f"  №{r['id']:<4} {_in(r['publish_at']):<16} {r['title'][:60]}{part}")
        waiting = _inbox_waiting(cfg, store)
        print("\nИСТОРИИ В inbox.txt (ещё не использованы):" if waiting else "\nИстории в inbox.txt закончились.")
        for n, (title, _) in enumerate(waiting, 1):
            print(f"  #{n:<3} {title[:80]}")
        if rows or waiting:
            print("\nОтправить ролик сейчас: faceless send НОМЕР (или просто faceless send: ближайший)")
            print("Отменить ролик: faceless cancel НОМЕР    Убрать историю: faceless skip НОМЕР")
    elif args.cmd == "send":
        import os

        from . import telegram

        if not (os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID")):
            raise SystemExit("Telegram не подключён. Запустите faceless setup, вставьте токен бота и напишите боту /start.")
        store = Store(cfg["paths"]["db"])
        rows = store.queue()
        if args.id is not None:
            rows = [r for r in rows if r["id"] == args.id]
        if not rows:
            raise SystemExit("Такого ролика в очереди нет. Список: faceless queue")
        row = rows[0]
        if not Path(row["path"]).exists():
            raise SystemExit(f"Файл ролика №{row['id']} не найден: {row['path']}")
        try:
            msg_id = telegram.upload(row, cfg)
        except Exception as e:
            store.set_result(row["id"], "telegram", None, str(e)[:500])
            raise SystemExit(f"Не получилось отправить: {e}")
        store.set_result(row["id"], "telegram", msg_id, None)
        print(f"Отправлено в Telegram: №{row['id']} «{row['title'][:60]}». Проверьте чат с ботом.")
    elif args.cmd == "cancel":
        store = Store(cfg["paths"]["db"])
        done = store.cancel(args.id, whole_story=not args.only_this)
        if not done:
            raise SystemExit("Такого ролика нет в очереди (возможно, он уже доставлен или отменён). Список: faceless queue")
        for r in done:
            Path(r["path"]).unlink(missing_ok=True)
        print(f"Отменено роликов: {len(done)} («{done[0]['title'][:60]}»). Файлы удалены, они не будут отправлены.")
    elif args.cmd == "skip":
        store = Store(cfg["paths"]["db"])
        waiting = _inbox_waiting(cfg, store)
        if not 1 <= args.number <= len(waiting):
            raise SystemExit("Нет истории с таким номером. Список: faceless queue")
        from . import inbox

        title = waiting[args.number - 1][0]
        store.mark_post(inbox.story_id(title), "", title, "skipped", "removed by user")
        print(f"Убрано из очереди: «{title[:70]}». Она больше не будет использована.")
    elif args.cmd == "inbox":
        from . import inbox

        if args.file:
            text = Path(args.file).read_text(encoding="utf-8")
        else:
            print("Вставьте истории (между историями строка из трёх дефисов ---, у каждой первая строка = заголовок).")
            print("Когда закончите, введите на отдельной строке слово КОНЕЦ и нажмите Enter. Отмена: Ctrl+C.\n")
            lines = []
            try:
                while True:
                    line = input("> " if not lines else "")
                    if line.strip().upper() in ("КОНЕЦ", "END"):
                        break
                    lines.append(line)
            except (KeyboardInterrupt, EOFError):
                raise SystemExit("\nОтменено.")
            text = "\n".join(lines)
        n = inbox.append(cfg["paths"]["inbox"], text)
        if not n:
            raise SystemExit("Не нашёл ни одной истории. Нужен формат: заголовок, текст, затем строка --- и следующая.")
        print(f"Добавлено историй: {n}. Всего ждут своей очереди: {pipeline.inbox_left(cfg)}.")
    elif args.cmd == "story":
        print("Вставьте историю: первая строка — заголовок, дальше текст. Когда закончите, введите на отдельной")
        print("строке слово КОНЕЦ и нажмите Enter. (Отмена: Ctrl+C)\n")
        lines = []
        try:
            while True:
                line = input("> " if not lines else "")
                if line.strip().upper() in ("КОНЕЦ", "END"):
                    break
                lines.append(line)
        except (KeyboardInterrupt, EOFError):
            raise SystemExit("\nОтменено.")
        try:
            post = post_from_text("\n".join(lines), subreddit=input("Название сабреддита/источника (Enter — stories) > ").strip() or "stories")
        except ValueError as e:
            raise SystemExit(str(e))
        store = Store(cfg["paths"]["db"])
        for p in pipeline.produce(post, adapt.adapt(post, cfg), cfg, store, random.Random()):
            print("Готово:", p)
    elif args.cmd == "make-file":
        path = Path(args.path)
        if path.suffix.lower() == ".txt":
            post = post_from_text(path.read_text(encoding="utf-8"), post_id=path.stem)
        else:
            data = json.loads(path.read_text(encoding="utf-8"))
            post = Post(id=data.get("id", path.stem), subreddit=data.get("subreddit", "stories"),
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
    elif args.cmd == "setup":
        from . import setup_wizard
        try:
            setup_wizard.run(cfg, args.config, args.keys)
        except (KeyboardInterrupt, EOFError):
            raise SystemExit("\nНастройка прервана. Всё, что вы успели ввести, сохранено. Запустите `faceless setup` снова, когда будете готовы.")
    elif args.cmd == "add-background":
        from . import setup_wizard
        try:
            print("Сохранено:", setup_wizard.add_background(args.source, cfg, args.keep_source))
        except Exception as e:
            raise SystemExit(f"Не получилось скачать: {e}")
    elif args.cmd == "auth-youtube":
        from . import youtube
        youtube.credentials(cfg, interactive=True)
        print("Токен сохранён в", cfg["youtube"]["token"])
    elif args.cmd == "ready":
        if args.publish:
            import os

            ok = (cfg["telegram"]["enabled"] or Path(cfg["youtube"]["token"]).exists()
                  or bool(os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID")))
        else:
            ok = (adapt.llm_provider(cfg) is not None or cfg["text"]["adapter"] == "none"
                  or pipeline.inbox_left(cfg) > 0)
        raise SystemExit(0 if ok else 1)
    elif args.cmd == "status":
        _print_overview(cfg)
        rows = Store(cfg["paths"]["db"]).videos()
        if not rows:
            print("\nРолики: пока нет. Соберите первый командой: faceless make -n 1")
        else:
            print("\nПоследние ролики (YT — YouTube, TG — Telegram):")
        for r in rows:
            yt = r["youtube_id"] or (f"ошибка: {r['youtube_error'][:40]}" if r["youtube_error"] else "—")
            tt = r["tiktok_id"] or (f"ошибка: {r['tiktok_error'][:40]}" if r["tiktok_error"] else "—")
            tg = "✔" if r["telegram_id"] else ("ошибка" if r["telegram_error"] else "—")
            print(f"#{r['id']:<4} {r['publish_at']}  YT:{yt:<14} TT:{tt:<14} TG:{tg:<6} {r['title'][:60]}")
    elif args.cmd == "demo":
        out = Path(cfg["paths"]["output_dir"]) / "demo"
        cfg["paths"]["db"] = str(out / "demo.sqlite3")
        cfg["paths"]["output_dir"] = str(out)
        if not any(Path(cfg["paths"]["backgrounds_dir"]).glob("*.mp4")):
            cfg["paths"]["backgrounds_dir"] = str(_demo_background(out / "bg" / "mandelbrot.mp4").parent)
        cfg["text"]["adapter"] = "none"
        cfg["tts"]["engine"] = args.tts
        post = DEMO_POST_RU if cfg["text"]["language"] == "ru" else DEMO_POST_EN
        for p in pipeline.produce(post, adapt.adapt(post, cfg), cfg, Store(cfg["paths"]["db"]),
                                  random.Random(7)):
            print(f"Тестовый ролик собран: {p.name}, {p.stat().st_size / 1e6:.0f} МБ, {media.duration(p):.0f} с")
        if args.keep:
            print("Сохранён в", out)
        else:
            shutil.rmtree(out, ignore_errors=True)
            print("Всё работает ✔ (тестовые файлы удалены; --keep оставит их для просмотра)")
