"""faceless doctor: самопроверка. Находит, где именно разрыв между «написал боту» и «получил ролик»."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from . import telegram
from .storage import Store


def _systemctl(*args: str) -> str:
    try:
        r = subprocess.run(["systemctl", *args], capture_output=True, text=True, timeout=10)
        return (r.stdout or r.stderr).strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def run(cfg: dict, fix: bool = False) -> int:
    """Печатает проверки; возвращает число найденных проблем."""
    problems = 0

    def ok(msg: str) -> None:
        print(f"  ✔ {msg}")

    def bad(msg: str, hint: str = "") -> None:
        nonlocal problems
        problems += 1
        print(f"  ✖ {msg}")
        if hint:
            print(f"      → {hint}")

    print("TELEGRAM")
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN", ""), os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token:
        bad("нет токена бота", "faceless setup (шаг Telegram): токен берётся у @BotFather")
    if token and not chat:
        bad("нет номера чата", "напишите своему боту /start и снова запустите faceless setup")
    bot_active = _systemctl("is-active", "faceless-bot.service") == "active"
    if token:
        try:
            me = telegram._call("getMe", token)
            ok(f"токен рабочий, бот @{me.get('username')}")
        except Exception as e:
            bad(f"токен не принят: {e}", "создайте/перевыпустите токен у @BotFather и вставьте через faceless setup")
            token = ""
    if token:
        try:
            wh = telegram._call("getWebhookInfo", token)
            if wh.get("url"):
                if fix:
                    telegram._call("deleteWebhook", token)
                    ok("у бота был webhook (он блокирует приём сообщений), я его удалил")
                else:
                    bad("у бота включён webhook — он забирает сообщения себе",
                        "запустите faceless doctor --fix, это его отключит")
            else:
                ok("webhook не мешает")
        except Exception as e:
            bad(f"getWebhookInfo: {e}")
    if token and not bot_active:
        # при работающей службе getUpdates не трогаем: два запроса сразу дают ложный конфликт
        try:
            telegram._call("getUpdates", token, data={"timeout": 0, "limit": 1})
            ok("токен свободен: другая программа его не перехватывает")
        except Exception as e:
            if "Conflict" in str(e):
                bad("этим токеном уже пользуется другая программа (скорее всего ваш старый Telegram-бот на этом сервере)",
                    "Telegram отдаёт сообщения только одному. Создайте у @BotFather нового бота для faceless и вставьте его токен: faceless setup")
            else:
                bad(f"getUpdates: {e}")
    if token and chat:
        try:
            telegram._call("sendMessage", token, data={"chat_id": chat, "text": "✅ faceless doctor: бот может писать вам."})
            ok("тестовое сообщение отправлено — проверьте Telegram")
        except Exception as e:
            bad(f"не могу написать в чат {chat}: {e}",
                "откройте бота в Telegram, нажмите Start и запустите faceless setup, чтобы номер чата обновился")

    print("\nСЛУЖБЫ")
    if shutil.which("systemctl") is None:
        print("  (systemd не найден, проверка пропущена)")
    else:
        st = _systemctl("is-active", "faceless-bot.service")
        if st == "active":
            ok("faceless-bot запущен (отвечает сразу)")
            beat = telegram._alive_file(cfg)
            try:
                info = json.loads(beat.read_text())
                age = time.time() - info["ts"]
                if age > 180:
                    bad(f"бот не подавал признаков жизни {age / 60:.0f} мин", "journalctl -u faceless-bot -n 30 --no-pager")
                elif info.get("error"):
                    bad(f"бот работает, но получает ошибку: {info['error']}")
                else:
                    ok("бот на связи с Telegram, ошибок нет")
            except (OSError, ValueError, KeyError):
                bad("бот запущен, но отметок активности нет", "подождите минуту и повторите")
        else:
            bad(f"faceless-bot не запущен ({st or 'нет данных'})",
                "обновите программу командой установки из ИНСТРУКЦИИ.md — служба включится сама")
        if _systemctl("is-enabled", "faceless-telegram.timer") == "enabled":
            bad("включён старый таймер faceless-telegram, он мешает боту", "обновите программу (установщик его уберёт)")
        for unit in ("faceless-make.timer", "faceless-publish.timer"):
            st = _systemctl("is-active", unit)
            ok(f"{unit} активен") if st == "active" else bad(f"{unit}: {st or 'нет данных'}", "faceless autopilot on")
        res = _systemctl("show", "faceless-make.service", "-p", "Result", "--value")
        if res and res not in ("success", ""):
            bad(f"последняя сборка закончилась так: {res}", "faceless autopilot log")

    print("\nОЧЕРЕДЬ")
    from . import adapt, pipeline

    store = Store(cfg["paths"]["db"])
    left = pipeline.inbox_left(cfg)
    ready = len(store.queue())
    ok(f"текстов ждут: {left}, готовых роликов: {ready}")
    llm = adapt.llm_provider(cfg) is not None
    if not llm and left == 0:
        bad("собирать нечего: нет ИИ-ключа и очередь текстов пуста", "пришлите боту тексты роликов")
    if left > 0 and ready == 0:
        print("      (ролики собираются по таймеру; ускорить: faceless autopilot run)")
    errs = [r for r in store.videos() if r["telegram_error"] and not r["telegram_id"]][:3]
    for r in errs:
        bad(f"ролик #{r['id']} не доставлен в Telegram: {r['telegram_error'][:150]}",
            "обычно причина — неверный чат или файл больше 50 МБ")
    publish_on = bool(cfg["telegram"]["enabled"] or Path(cfg["youtube"]["token"]).exists() or (token and chat))
    if not publish_on:
        bad("ролики некуда доставлять: Telegram и YouTube не подключены")

    print("\nСЕРВЕР")
    free = shutil.disk_usage(Path(cfg["paths"]["db"]).parent if Path(cfg["paths"]["db"]).parent.exists() else ".").free // 2**20
    ok(f"свободно на диске: {free} МБ") if free >= 300 else bad(f"на диске только {free} МБ", "faceless cancel all и очистка: rm -rf /opt/faceless/app/data/broll_cache")

    print(f"\n{'Всё в порядке ✔' if not problems else f'Найдено проблем: {problems}. Исправьте по подсказкам →'}")
    return problems
