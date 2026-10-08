"""Пошаговая настройка для новичка: `faceless setup` и `faceless add-background`."""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from urllib.parse import urlparse

import requests

ENV_KEYS = [
    ("ANTHROPIC_API_KEY", "Ключ Claude (Anthropic) — переписывает истории с цепляющим началом.\n"
                          "  Нет ключа — нажмите Enter, истории пойдут как есть."),
    ("REDDIT_CLIENT_ID", "Reddit client id — нужен, только если Reddit не отдаёт посты без ключа.\n"
                         "  Сначала попробуйте без него: нажмите Enter."),
    ("REDDIT_CLIENT_SECRET", "Reddit secret (Enter — пропустить)"),
]


def _read_env(path: Path) -> dict[str, str]:
    out = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


def _write_env(path: Path, values: dict[str, str]) -> None:
    lines = [f"{k}={v}" for k, v in values.items() if v]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    path.chmod(0o600)


def _check_value(key: str, value: str) -> str | None:
    """Ловит типичную ошибку: в поле ключа вставили не то (например, JSON-файл Google)."""
    if not value:
        return None
    if value.startswith("{") or '"' in value:
        return ("Это похоже на файл Google (JSON), а здесь нужен короткий ключ. "
                "Файл Google будет запрошен позже, на отдельном шаге. Сейчас нажмите Enter, чтобы пропустить.")
    if " " in value or len(value) > 200:
        return "Ключ не должен содержать пробелов и быть очень длинным. Скопируйте только сам ключ."
    if key == "ANTHROPIC_API_KEY" and not value.startswith("sk-ant"):
        return "Ключ Claude начинается с «sk-ant». Проверьте, что скопировали именно его."
    return None


def _paste_json() -> dict | None:
    print("Откройте скачанный файл client_secret_....json Блокнотом, выделите всё (Ctrl+A), скопируйте (Ctrl+C)")
    print("и вставьте сюда (правая кнопка мыши или Shift+Insert). Затем нажмите Enter.")
    print("Пустая строка — пропустить.\n")
    buf = ""
    while True:
        line = input()
        if not line.strip() and not buf:
            return None
        buf += line
        try:
            data = json.loads(buf)
        except json.JSONDecodeError:
            if buf.count("{") and buf.count("{") == buf.count("}"):
                print("Это не похоже на JSON-файл от Google. Попробуйте ещё раз.\n")
                buf = ""
            continue
        if "installed" not in data:
            print("Нужен клиент типа «Desktop app» (в файле должно быть \"installed\"). Создайте такой и вставьте его.\n")
            buf = ""
            continue
        return data


def run(cfg: dict, config_path: str) -> None:
    root = Path(config_path).resolve().parent
    print("=== Настройка faceless ===")
    print("Программа будет задавать вопросы по одному. После каждого ответа нажимайте Enter.")
    print("Если ответа пока нет, просто нажмите Enter: вопрос пропустится, к нему можно вернуться позже")
    print("повторным запуском `faceless setup`. Отменить всё: Ctrl+C.\n")

    cfg_file = root / "config.toml"
    if not cfg_file.exists() and (root / "config.example.toml").exists():
        shutil.copy(root / "config.example.toml", cfg_file)
        print("Создан config.toml с настройками по умолчанию.\n")

    env_path = root / ".env"
    env = _read_env(env_path)
    for n, (key, hint) in enumerate(ENV_KEYS, 1):
        current = env.get(key, "")
        shown = f" [сейчас: {current[:6]}…]" if current else ""
        value = input(f"Вопрос {n} из {len(ENV_KEYS)}. {hint}{shown}\n(пусто + Enter = пропустить) > ").strip()
        problem = _check_value(key, value)
        while problem:
            print(f"  ✖ {problem}")
            value = input("  Попробуйте ещё раз или нажмите Enter, чтобы пропустить > ").strip()
            problem = _check_value(key, value)
        if value:
            env[key] = value
        print()
    _write_env(env_path, env)
    print(f"Ключи сохранены в {env_path}\n")

    secrets = root / cfg["youtube"]["client_secrets"]
    if secrets.exists():
        print(f"Файл Google ({secrets.name}) уже есть.")
        replace = input("Заменить его? (y — да, Enter — нет) > ").strip().lower() == "y"
    else:
        print("Теперь файл от Google Cloud (шаг 4 инструкции).")
        replace = True
    if replace:
        data = _paste_json()
        if data:
            secrets.parent.mkdir(parents=True, exist_ok=True)
            secrets.write_text(json.dumps(data), encoding="utf-8")
            secrets.chmod(0o600)
            print("Сохранено.\n")

    if secrets.exists():
        token = root / cfg["youtube"]["token"]
        if token.exists() and input("YouTube уже подключён. Подключить заново? (y/Enter) > ").strip().lower() != "y":
            pass
        else:
            from . import youtube
            try:
                youtube.credentials(cfg, interactive=True)
                print("\nYouTube подключён ✔")
            except Exception as e:
                print(f"\nНе получилось подключить YouTube: {e}")
                print("Частые причины: скопирован не весь адрес; прошло больше 5 минут; ваш Gmail не добавлен")
                print("в Test users; файл не от «Desktop app». Запустите `faceless setup` ещё раз.")
    else:
        print("Без файла Google загрузка в YouTube работать не будет — вернитесь к шагу 4 и запустите setup снова.")

    _setup_telegram(root, env, env_path)

    bgs = [p for p in (root / cfg["paths"]["backgrounds_dir"]).glob("*") if p.suffix.lower() in {".mp4", ".mov", ".mkv", ".webm"}]
    print(f"\nФоновых видео: {len(bgs)}." + ("" if bgs else " Добавьте: faceless add-background ССЫЛКА"))
    print("\nГотово. Пробный ролик: faceless make -n 1")


def _setup_telegram(root: Path, env: dict, env_path: Path) -> None:
    from . import telegram

    print("\n--- Telegram (по желанию) ---")
    print("Бот будет присылать вам готовые ролики с названием и описанием — выложить с телефона за 30 секунд.")
    if env.get("TELEGRAM_BOT_TOKEN") and env.get("TELEGRAM_CHAT_ID"):
        if input("Telegram уже настроен. Перенастроить? (y/Enter) > ").strip().lower() != "y":
            return
    token = input("Токен НОВОГО бота от @BotFather (Enter — пропустить)\n> ").strip()
    if not token:
        return
    input("Откройте этого бота в Telegram, нажмите «Запустить» (/start), потом вернитесь и нажмите Enter > ")
    try:
        chat_id = telegram.find_chat_id(token)
    except Exception as e:
        print(f"Не получилось: {e}. Проверьте токен и запустите setup ещё раз.")
        return
    if not chat_id:
        print("Бот не видит вашего /start. Напишите ему что-нибудь и запустите setup ещё раз.")
        return
    env.update(TELEGRAM_BOT_TOKEN=token, TELEGRAM_CHAT_ID=str(chat_id))
    _write_env(env_path, env)
    sent = True
    try:
        telegram._call("sendMessage", token, data={"chat_id": chat_id, "text": "✅ faceless подключён. Сюда будут приходить ролики."})
    except Exception:
        sent = False
    cfg_file = root / "config.toml"
    text = cfg_file.read_text(encoding="utf-8")
    if "[telegram]" in text:
        text = re.sub(r"(\[telegram\][^\[]*?enabled\s*=\s*)false", r"\1true", text, count=1)
    else:
        text += "\n[telegram]\nenabled = true\n"
    cfg_file.write_text(text, encoding="utf-8")
    print("Telegram подключён ✔" + ("" if sent else " (тестовое сообщение не ушло — проверьте позже)"))


def direct_link(url: str) -> str:
    """Превращает ссылки «поделиться» из Google Drive и Dropbox в прямые ссылки на файл."""
    m = re.search(r"drive\.google\.com/file/d/([\w-]+)", url) or re.search(r"drive\.google\.com/(?:open|uc)\?(?:[^#]*&)?id=([\w-]+)", url)
    if m:
        # usercontent-адрес сам обходит страницу «файл большой, проверить на вирусы?» (confirm=t)
        return f"https://drive.usercontent.google.com/download?id={m.group(1)}&export=download&confirm=t"
    if "dropbox.com" in url:
        url = re.sub(r"([?&])dl=0", r"\1dl=1", url)
        return url if "dl=1" in url else url + ("&" if "?" in url else "?") + "dl=1"
    return url


def _html_hint(url: str, text: str) -> str:
    low = text.lower()
    if "drive.google" in url or "drive.usercontent" in url:
        if "sign in" in low or "accounts.google" in low or "request access" in low or "access denied" in low or "доступ" in low:
            return ("Google Диск не дал скачать: у файла закрытый доступ. На Диске: правый клик по файлу → «Открыть доступ» → "
                    "в разделе «Общий доступ» выберите «Все, у кого есть ссылка» (роль «Читатель») и скопируйте ссылку заново.")
        if "quota" in low or "too many users" in low or "превышен" in low:
            return "Google Диск временно ограничил скачивание этого файла (много обращений). Подождите несколько часов или используйте scp."
        return ("Google Диск вернул страницу вместо видео. Проверьте, что доступ «Все, у кого есть ссылка», "
                "или залейте файл на сервер напрямую (scp / WinSCP), см. ИНСТРУКЦИЯ.md, способ Б.")
    return ("По ссылке открывается страница, а не видео. Нужна прямая ссылка на файл "
            "(на Pexels: «Бесплатное скачивание» → правой кнопкой «Копировать адрес ссылки»).")


def add_background(source: str, cfg: dict, keep_source: bool = False) -> Path:
    """Добавляет фон: файл с сервера (залитый с вашего устройства) или прямая ссылка (Pexels, Диск, Dropbox)."""
    folder = Path(cfg["paths"]["backgrounds_dir"])
    folder.mkdir(parents=True, exist_ok=True)
    local = Path(source).expanduser()
    if not source.startswith(("http://", "https://")):
        if not local.is_file():
            raise ValueError(f"Файл не найден: {source}. Проверьте путь (после загрузки на сервер, например, /tmp/video.mp4).")
        from . import media
        try:
            media.duration(local)
        except Exception:
            raise ValueError("Это не видео (или файл повреждён).")
        name = re.sub(r"[^\w.-]+", "_", local.stem) + ".mp4"
        out = folder / name
        n = 1
        while out.exists():
            out = folder / f"{Path(name).stem}_{n}.mp4"
            n += 1
        # сразу сжимаем в папку фонов; оригинал с телефона/камеры может быть 4K и очень тяжёлым
        result = shrink_background(local, dest=out)
        if not keep_source and local.resolve().parent != folder.resolve():
            try:
                local.unlink()
                print(f"  Копия на сервере {local} удалена (на вашем устройстве файл остался).")
            except OSError:
                print(f"  Копию на сервере можно удалить вручную: rm {local}")
        return result

    url = direct_link(source)
    name = Path(urlparse(url).path).name or "background"
    name = re.sub(r"[^\w.-]+", "_", name)
    if not name.lower().endswith((".mp4", ".mov", ".mkv", ".webm")):
        name += ".mp4"
    out = folder / name
    n = 1
    while out.exists():
        out = folder / f"{Path(name).stem}_{n}{Path(name).suffix}"
        n += 1
    with requests.get(url, stream=True, timeout=60, headers={"User-Agent": "Mozilla/5.0"}) as r:
        if r.status_code >= 400:
            raise ValueError(_html_hint(url, r.text[:3000]) if r.status_code in (401, 403, 404) else f"сервер ответил {r.status_code}")
        ctype = r.headers.get("content-type", "")
        if "text/html" in ctype:
            raise ValueError(_html_hint(url, r.text[:20000]))
        total = 0
        with out.open("wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
                total += len(chunk)
                print(f"\r  скачано {total / 1e6:.0f} МБ", end="", flush=True)
    print()
    from . import media
    try:
        media.duration(out)
    except Exception:
        out.unlink(missing_ok=True)
        raise ValueError("Файл скачался, но это не видео.")
    return shrink_background(out)


def shrink_background(path: Path, max_side: int = 1280, dest: Path | None = None) -> Path:
    """Сжимает фон до 720p без звука: в 5–20 раз меньше места и быстрее рендер на слабом сервере.

    Телефонные видео бывают повёрнуты метаданными (rotate) — ffmpeg применяет поворот сам.
    Если указан dest, исходный файл не трогается, результат пишется в dest."""
    from . import media

    before = path.stat().st_size
    if dest is not None:
        print("  сжимаю под 720p без звука (на слабом сервере — примерно 1 минута на минуту видео)…")
        media.run(["ffmpeg", "-y", "-i", str(path), "-an", "-vf",
                   f"scale='if(gt(iw,ih),{max_side},-2)':'if(gt(iw,ih),-2,{max_side})'",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
                   "-threads", "1", "-movflags", "+faststart", str(dest)])
        print(f"  {before / 1e6:.0f} МБ → {dest.stat().st_size / 1e6:.0f} МБ")
        return dest
    tmp = path.with_suffix(".small.mp4")
    print("  сжимаю под 720p (на слабом сервере 1–3 минуты)…")
    media.run(["ffmpeg", "-y", "-i", str(path), "-an", "-vf",
               f"scale='if(gt(iw,ih),{max_side},-2)':'if(gt(iw,ih),-2,{max_side})'",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
               "-threads", "1", "-movflags", "+faststart", str(tmp)])
    if tmp.stat().st_size < before:
        tmp.replace(path.with_suffix(".mp4"))
        if path.suffix.lower() != ".mp4":
            path.unlink(missing_ok=True)
        path = path.with_suffix(".mp4")
    else:
        tmp.unlink()
    print(f"  {before / 1e6:.0f} МБ → {path.stat().st_size / 1e6:.0f} МБ")
    return path
