"""Отправка готового ролика себе в Telegram — чтобы выложить вручную с телефона.

Нужен, пока Google не одобрил API-проект (до аудита все загрузки через API остаются приватными),
и вообще как самый простой путь: бот присылает видео + название + описание в момент слота.
"""
from __future__ import annotations

import json
import os
import time
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


def _alive_file(cfg: dict) -> Path:
    return Path(cfg["paths"]["db"]).with_name("bot_alive.json")


def _download_text(file_id: str, token: str) -> str:
    info = _call("getFile", token, data={"file_id": file_id})
    if info.get("file_size", 0) > 1_000_000:
        raise RuntimeError("файл больше 1 МБ")
    r = requests.get(f"https://api.telegram.org/file/bot{token}/{info['file_path']}", timeout=60)
    r.raise_for_status()
    return r.content.decode("utf-8", errors="replace")


HELP = ("Пришлите тексты роликов (сообщением или файлом .txt) — я сразу добавлю их в очередь.\n"
        "Формат: «TITLE: заголовок», затем 5 строк «факт | кадр на английском» (или текст истории). "
        "Несколько роликов подряд можно слать одним сообщением, делить их строкой --- не обязательно.\n\n"
        "/queue — что в очереди\n/status — всё ли в порядке\n/clear — очистить очередь текстов\n"
        "/cancelall — отменить все готовые ролики")


def _heartbeat(cfg: dict, error: str = "") -> None:
    try:
        f = _alive_file(cfg)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"ts": time.time(), "error": error[:300]}))
    except OSError:
        pass


def _handle_text(cfg: dict, text: str, notes: list[str], texts: list[str]) -> None:
    from . import inbox

    if not text.startswith("/"):
        texts.append(text)
        return
    cmd = text.split()[0].split("@")[0].lower()
    if cmd == "/cancelall":
        from .storage import Store

        rows = Store(cfg["paths"]["db"]).cancel_all()
        for r in rows:
            Path(r["path"]).unlink(missing_ok=True)
        notes.append(f"Отменено готовых роликов: {len(rows)}.")
    elif cmd == "/clear":
        notes.append(f"Очередь текстов очищена (было {inbox.clear(cfg['paths']['inbox'])}).")
    elif cmd == "/queue":
        notes.append(_queue_report(cfg))
    elif cmd == "/status":
        notes.append(_status_report(cfg))
    else:
        notes.append(HELP)


def process_updates(cfg: dict, updates: list[dict], token: str, owner: str) -> int:
    """Обрабатывает пачку сообщений: тексты → inbox, команды выполняет; отвечает владельцу. Возвращает число новых роликов."""
    from . import inbox, pipeline

    off_file = _offset_file(cfg)
    off_file.parent.mkdir(parents=True, exist_ok=True)
    off_file.write_text(str(updates[-1]["update_id"]))  # сразу: сбой в разборе не должен зациклить обработку

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
        elif doc:
            notes.append("Файл не .txt — пришлите текст сообщением или файлом .txt.")
            continue
        elif not text:
            notes.append("Это не текст. Пришлите текст ролика сообщением или файлом .txt (/help — формат).")
            continue
        try:
            _handle_text(cfg, text.strip(), notes, texts)
        except Exception as e:
            notes.append(f"Команда не выполнилась: {e}")

    added = 0
    if texts:
        text_all = build_text(texts)
        found = inbox.unique(inbox.parse(text_all))
        added = inbox.append(cfg["paths"]["inbox"], text_all)
        if added:
            dup = f" Повторов пропущено: {len(found) - added}." if len(found) > added else ""
            lines = "\n".join(inbox.describe(t, b) for t, b in found[:12])
            more = f"\n…и ещё {len(found) - 12}" if len(found) > 12 else ""
            notes.append(f"✅ Добавлено новых: {added}.{dup} В очереди ждут: {pipeline.inbox_left(cfg)}.\n{lines}{more}\n"
                         "Собираются ролики в фоне, готовое пришлю сюда.")
        elif found:
            notes.append(f"Все {len(found)} уже были в очереди, ничего не добавлено.")
        else:
            notes.append("Не нашёл ни одного ролика. Нужен формат: первая строка «TITLE: заголовок», дальше "
                         "5 строк «факт | кадр» или текст истории (от ~80 символов). Строка --- между роликами "
                         "желательна, но не обязательна.")
    for n in notes:
        notify(n)
    return added


def sync_inbox(cfg: dict, timeout: int = 0) -> int:
    """Забирает новые сообщения владельца (timeout > 0 — ждёт их, ответ мгновенный); возвращает, сколько роликов добавлено."""
    token, owner = os.environ.get("TELEGRAM_BOT_TOKEN"), str(os.environ.get("TELEGRAM_CHAT_ID", ""))
    if not (token and owner):
        return 0
    off_file = _offset_file(cfg)
    offset = int(off_file.read_text()) + 1 if off_file.exists() else None
    params = {"timeout": timeout, "allowed_updates": json.dumps(["message"])}
    if offset:
        params["offset"] = offset
    updates = _call("getUpdates", token, data=params)
    return process_updates(cfg, updates, token, owner) if updates else 0


def run_bot(config_path: str = "config.toml") -> None:
    """Бесконечный цикл: ждёт сообщений владельца и отвечает сразу. Работает как служба faceless-bot."""
    import logging

    from .config import load_config, load_dotenv

    log = logging.getLogger("faceless")
    delay = 5
    while True:
        load_dotenv(Path(config_path).parent / ".env", override=True)  # токен могли вписать, пока служба работает
        cfg = load_config(config_path)
        if not (os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID")):
            _heartbeat(cfg, "не задан токен бота или номер чата (faceless setup)")
            time.sleep(30)
            continue
        try:
            _heartbeat(cfg)
            sync_inbox(cfg, timeout=50)
            delay = 5
        except Exception as e:
            msg = str(e)
            if "Conflict" in msg:
                msg = ("этим же токеном бота уже пользуется другая программа (ваш старый бот?): Telegram позволяет "
                       "только одной. Создайте для faceless отдельного бота у @BotFather. " + msg)
            log.warning("bot: %s", msg)
            _heartbeat(cfg, msg)
            time.sleep(delay)
            delay = min(delay * 2, 120)


def _status_report(cfg: dict) -> str:
    from . import adapt, pipeline
    from .storage import Store

    store = Store(cfg["paths"]["db"])
    ai = "подключён" if adapt.llm_provider(cfg) else "нет (тексты берутся из очереди)"
    return ("Бот работает ✔\n"
            f"Готовых роликов: {len(store.queue())}\n"
            f"Текстов ждут: {pipeline.inbox_left(cfg)}\n"
            f"ИИ для текстов: {ai}\n"
            "Подробная проверка: faceless doctor")


def _queue_report(cfg: dict) -> str:
    from . import pipeline
    from .storage import Store

    store = Store(cfg["paths"]["db"])
    return (f"Готовых роликов в очереди: {len(store.queue())}\n"
            f"Текстов ждут своей очереди: {pipeline.inbox_left(cfg)}")
