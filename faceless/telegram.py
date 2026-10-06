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
