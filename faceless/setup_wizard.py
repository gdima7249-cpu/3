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
    print("=== Настройка faceless ===\n")

    cfg_file = root / "config.toml"
    if not cfg_file.exists() and (root / "config.example.toml").exists():
        shutil.copy(root / "config.example.toml", cfg_file)
        print("Создан config.toml с настройками по умолчанию.\n")

    env_path = root / ".env"
    env = _read_env(env_path)
    for key, hint in ENV_KEYS:
        current = env.get(key, "")
        shown = f" [сейчас: {current[:6]}…]" if current else ""
        value = input(f"{hint}{shown}\n> ").strip()
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

    bgs = [p for p in (root / cfg["paths"]["backgrounds_dir"]).glob("*") if p.suffix.lower() in {".mp4", ".mov", ".mkv", ".webm"}]
    print(f"\nФоновых видео: {len(bgs)}." + ("" if bgs else " Добавьте: faceless add-background ССЫЛКА"))
    print("\nГотово. Пробный ролик: faceless make -n 1")


def add_background(url: str, cfg: dict) -> Path:
    """Скачивает видео по прямой ссылке (Pexels, Pixabay, свой облачный диск…) в папку фонов."""
    folder = Path(cfg["paths"]["backgrounds_dir"])
    folder.mkdir(parents=True, exist_ok=True)
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
        r.raise_for_status()
        ctype = r.headers.get("content-type", "")
        if "text/html" in ctype:
            raise ValueError("По ссылке открывается страница, а не видео. Нужна прямая ссылка на файл "
                             "(на Pexels: кнопка «Бесплатное скачивание» → правой кнопкой «Копировать адрес ссылки»).")
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
    return out
