"""Загрузка конфигурации: значения по умолчанию + config.toml + .env."""
from __future__ import annotations

import copy
import os
import tomllib
from pathlib import Path

DEFAULTS: dict = {
    "paths": {"output_dir": "output", "db": "data/faceless.sqlite3", "inbox": "inbox.txt",
              "backgrounds_dir": "assets/backgrounds", "music_dir": "assets/music",
              "keep_work_files": False, "delete_after_upload": True},
    "reddit": {
        "subreddits": ["AskReddit", "TrueOffMyChest", "tifu"],
        "sort": "top", "time": "day", "limit": 50,
        "min_score": 1500, "min_chars": 300, "max_chars": 5000,
        "top_comments": 4, "question_subreddits": ["AskReddit", "NoStupidQuestions"],
    },
    "text": {"language": "en", "adapter": "auto", "model": "claude-opus-5-5", "gemini_models": ["gemini-flash-lite-latest", "gemini-3.1-flash-lite", "gemini-flash-latest"],
             "min_quality": 6},
    "tts": {
        "engine": "edge", "voices": ["en-US-ChristopherNeural", "en-US-AriaNeural", "en-US-GuyNeural", "en-US-JennyNeural"], "rate": "+12%",
        "elevenlabs_voice_ids": [], "elevenlabs_model": "eleven_multilingual_v2",
    },
    "video": {
        "width": 1080, "height": 1920, "fps": 30, "max_part_seconds": 60,
        "font": "Inter", "font_size": 92, "words_per_caption": 3,
        "highlight_colors": ["&H0000F0FF", "&H0055FF55", "&H00FFD24D"],
        "music_volume": 0.07, "mirror_chance": 0.5,
        "preset": "veryfast", "threads": 0,  # для слабого VPS: veryfast и 1–2 потока
    },
    "schedule": {"timezone": "America/New_York", "publish_times": ["11:50", "16:50", "19:50"]},
    "youtube": {
        "enabled": True, "client_secrets": "secrets/client_secret.json",
        "token": "secrets/youtube_token.json", "category_id": "24",
        "default_tags": ["reddit", "reddit stories", "askreddit", "shorts"], "contains_synthetic_media": True,
    },
    "tiktok": {"enabled": False, "privacy_level": "SELF_ONLY"},
    "telegram": {"enabled": False},
    "autopilot": {"queue_target": 6},  # сколько готовых, но ещё не доставленных роликов держать в запасе
    "stories": {
        # auto: Reddit, только если есть ключи Reddit; иначе ИИ придумывает истории. reddit | generate — принудительно
        "source": "auto",
        "max_chars": 950,  # придуманная история: примерно на одну минуту, т.е. один ролик (≈15 символов в секунду)
        "themes": [
            "petty revenge on a rude neighbor", "a coworker who kept taking credit for my work",
            "the roommate from hell", "a wedding that went completely wrong",
            "a strange message from an unknown number", "a night shift where something felt off",
            "a family secret found in the attic", "a stranger's kindness that came back years later",
            "a landlord who thought he could cheat me", "a school reunion with a twist",
            "a lost wallet and an unexpected ending", "a customer who yelled at the wrong person",
            "a group project betrayal", "an anonymous note left on my car",
            "a neighbor's dog that solved a mystery", "moving into a house with one strange rule",
            "an HOA that picked a fight with the wrong resident", "a road trip that took a wrong turn",
        ],
    },
}


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


def load_dotenv(path: Path) -> None:
    """Минимальный .env-парсер: KEY=VALUE, без перезаписи уже заданных переменных."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if value:
            os.environ.setdefault(key.strip(), value)


def load_config(path: str | Path = "config.toml") -> dict:
    path = Path(path)
    load_dotenv(path.parent / ".env")
    user = tomllib.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    return _merge(DEFAULTS, user)
