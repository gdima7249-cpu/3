"""Отправка готового ролика себе в Telegram — чтобы выложить вручную с телефона.

Нужен, пока Google не одобрил API-проект (до аудита все загрузки через API остаются приватными),
и вообще как самый простой путь: бот присылает видео + название + описание в момент слота.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import requests

API = "https://api.telegram.org/bot{token}/{method}"
MAX_BYTES = 50 * 1024 * 1024  # лимит Bot API на отправку файла


def _call(method: str, token: str | None = None, **kwargs) -> dict:
    token = token or os.environ["TELEGRAM_BOT_TOKEN"]
    r = requests.post(API.format(token=token, method=method), timeout=120, **kwargs)
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"Telegram {method}: {data.get('description', r.text[:200])}")
    return data["result"]


def notify(text: str) -> None:
    """Короткое сообщение себе в Telegram (ошибки автопилота). Без настроенного бота ничего не делает."""
    if not (os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID")):
        return
    try:
        _call("sendMessage", data={"chat_id": os.environ["TELEGRAM_CHAT_ID"], "text": text[:3500]})
    except Exception:
        pass


def find_chat_id(token: str) -> int | None:
    """Последний чат, где боту написали /start."""
    updates = _call("getUpdates", token, data={"timeout": 0})
    for upd in reversed(updates):
        msg = upd.get("message") or upd.get("my_chat_member") or {}
        chat = msg.get("chat")
        if chat:
            return chat["id"]
    return None


def caption_text(row) -> str:
    tags = " ".join(f"#{t.replace(' ', '')}" for t in json.loads(row["tags"] or "[]")[:5])
    part = f" · часть {row['part']}/{row['parts']}" if row["parts"] > 1 else ""
    return f"🎬 Пора выкладывать{part}\n\nНазвание:\n{row['title']}\n\nОписание:\n{row['description']}\n\n{tags}"


def upload(row, cfg: dict) -> str:
    chat_id = os.environ["TELEGRAM_CHAT_ID"]
    path = Path(row["path"])
    if path.stat().st_size > MAX_BYTES:
        raise RuntimeError("файл больше 50 МБ — Telegram-бот не может его отправить")
    text = caption_text(row)
    with path.open("rb") as f:
        msg = _call("sendVideo", data={"chat_id": chat_id, "supports_streaming": "true",
                                       "width": cfg["video"]["width"], "height": cfg["video"]["height"]},
                    files={"video": (path.name, f, "video/mp4")})
    # Подпись к видео ограничена 1024 символами — текст для копирования шлём отдельным сообщением
    _call("sendMessage", data={"chat_id": chat_id, "text": text[:4000],
                               "reply_to_message_id": msg["message_id"]})
    return str(msg["message_id"])


# ---------------------------------------------------------------------------------------------
# Приём историй: владелец пересылает боту текст (или .txt-файл), бот кладёт его в inbox.txt.
# ---------------------------------------------------------------------------------------------
SPLIT_LIMIT = 3500  # Telegram режет длинные сообщения на куски ~4096 символов; если сообщение так длинно, дальше продолжение


def build_text(messages: list[str]) -> str:
    """Склеивает сообщения владельца в один текст для разбора на истории.

    Сообщение — продолжение предыдущего, только если предыдущее было почти предельной длины
    (так Telegram режет длинные вставки). Иначе это новая история: перед ней ставится разделитель."""
    out = ""
    prev_long = False
    for m in messages:
        m = m.strip()
        if not m:
            continue
        if out and not prev_long:
            out += "\n---\n"
        elif out:
            out += "\n"
        out += m
        prev_long = len(m) >= SPLIT_LIMIT
    return out


def _offset_file(cfg: dict) -> Path:
    return Path(cfg["paths"]["db"]).with_name("tg_offset.txt")


def _download_text(file_id: str, token: str) -> str:
    info = _call("getFile", token, data={"file_id": file_id})
    if info.get("file_size", 0) > 1_000_000:
        raise RuntimeError("файл больше 1 МБ")
    r = requests.get(f"https://api.telegram.org/file/bot{token}/{info['file_path']}", timeout=60)
    r.raise_for_status()
    return r.content.decode("utf-8", errors="replace")


def sync_inbox(cfg: dict) -> int:
    """Забирает новые сообщения владельца; возвращает, сколько историй добавлено. Чужих игнорирует."""
    from . import inbox, pipeline

    token, owner = os.environ.get("TELEGRAM_BOT_TOKEN"), str(os.environ.get("TELEGRAM_CHAT_ID", ""))
    if not (token and owner):
        return 0
    off_file = _offset_file(cfg)
    offset = int(off_file.read_text()) + 1 if off_file.exists() else None
    params = {"timeout": 0, "allowed_updates": json.dumps(["message"])}
    if offset:
        params["offset"] = offset
    updates = _call("getUpdates", token, data=params)
    if not updates:
        return 0

    texts: list[str] = []
    notes: list[str] = []
    for upd in updates:
        msg = upd.get("message") or {}
        if str(msg.get("chat", {}).get("id")) != owner:
            continue  # бот принимает команды только от вас
        text = msg.get("text") or msg.get("caption") or ""
        doc = msg.get("document")
        if doc and str(doc.get("file_name", "")).lower().endswith(".txt"):
            try:
                text = _download_text(doc["file_id"], token)
            except Exception as e:
                notes.append(f"Не смог прочитать файл {doc.get('file_name')}: {e}")
                continue
        if text.startswith("/"):
            cmd = text.split()[0].split("@")[0].lower()
            if cmd == "/cancelall":
                from .storage import Store

                store = Store(cfg["paths"]["db"])
                rows = store.cancel_all()
                for r in rows:
                    Path(r["path"]).unlink(missing_ok=True)
                notes.append(f"Отменено готовых роликов: {len(rows)}.")
            elif cmd == "/clear":
                notes.append(f"Очередь историй очищена (было {inbox.clear(cfg['paths']['inbox'])}).")
            elif cmd == "/queue":
                notes.append(_queue_report(cfg))
            else:
                notes.append("Просто пришлите тексты роликов или файл .txt. Формат: первая строка «TITLE: заголовок», затем "
                             "либо текст истории, либо 5 строк вида «факт | кадр»; ролики разделяйте строкой из трёх "
                             "дефисов (---). /queue — что в очереди, /clear — очистить очередь текстов, /cancelall — отменить все готовые ролики.")
            continue
        texts.append(text)
    off_file.parent.mkdir(parents=True, exist_ok=True)
    off_file.write_text(str(updates[-1]["update_id"]))

    added = 0
    if texts:
        text_all = build_text(texts)
        total = len(inbox.unique(inbox.parse(text_all)))
        added = inbox.append(cfg["paths"]["inbox"], text_all)
        if added:
            left = pipeline.inbox_left(cfg)
            dup = f" Повторов пропущено: {total - added}." if total > added else ""
            notes.append(f"✅ Добавлено новых: {added}.{dup} В очереди ждут: {left}.")
        elif total:
            notes.append(f"Все {total} уже были в очереди, ничего не добавлено.")
        else:
            notes.append("Не нашёл ни одного ролика. Нужен формат: первая строка «TITLE: заголовок», дальше текст "
                         "(не короче ~80 символов) или строки «факт | кадр»; ролики разделяйте строкой ---.")
    for n in notes:
        notify(n)
    return added


def _queue_report(cfg: dict) -> str:
    from . import pipeline
    from .storage import Store

    store = Store(cfg["paths"]["db"])
    return (f"Готовых роликов в очереди: {len(store.queue())}\n"
            f"Историй ждут своей очереди: {pipeline.inbox_left(cfg)}")
