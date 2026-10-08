"""SQLite: использованные посты (без повторов) и очередь публикаций."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY, subreddit TEXT, title TEXT, status TEXT, reason TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT, part INTEGER, parts INTEGER, path TEXT,
    title TEXT, description TEXT, tags TEXT,
    publish_at TEXT,                         -- UTC ISO-8601, слот публикации
    youtube_id TEXT, youtube_error TEXT,
    tiktok_id TEXT, tiktok_error TEXT,
    telegram_id TEXT, telegram_error TEXT,
    created_at TEXT
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: str | Path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        cols = {r[1] for r in self.db.execute("PRAGMA table_info(videos)")}
        for col in ("telegram_id", "telegram_error"):  # миграция баз, созданных до появления Telegram
            if col not in cols:
                self.db.execute(f"ALTER TABLE videos ADD COLUMN {col} TEXT")

    def seen(self, post_id: str) -> bool:
        return self.db.execute("SELECT 1 FROM posts WHERE id=?", (post_id,)).fetchone() is not None

    def recent_titles(self, prefix: str, limit: int = 40) -> list[str]:
        rows = self.db.execute("SELECT title FROM posts WHERE id LIKE ? ORDER BY created_at DESC LIMIT ?",
                               (prefix + "%", limit))
        return [r[0] for r in rows]

    def mark_post(self, post_id: str, subreddit: str, title: str, status: str, reason: str = "") -> None:
        self.db.execute("INSERT OR REPLACE INTO posts VALUES (?,?,?,?,?,?)",
                        (post_id, subreddit, title, status, reason, now_iso()))
        self.db.commit()

    def add_video(self, *, post_id: str, part: int, parts: int, path: Path, title: str,
                  description: str, tags: list[str], publish_at: str) -> int:
        cur = self.db.execute(
            "INSERT INTO videos (post_id, part, parts, path, title, description, tags, publish_at, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (post_id, part, parts, str(path), title, description, json.dumps(tags, ensure_ascii=False),
             publish_at, now_iso()),
        )
        self.db.commit()
        return cur.lastrowid

    def undelivered(self) -> int:
        """Готовые ролики, которые ещё никуда не ушли (очередь, которую надо держать заполненной)."""
        return self.db.execute("SELECT COUNT(*) FROM videos WHERE youtube_id IS NULL AND tiktok_id IS NULL "
                               "AND telegram_id IS NULL").fetchone()[0]

    def taken_slots(self) -> set[str]:
        return {r[0] for r in self.db.execute("SELECT publish_at FROM videos WHERE publish_at IS NOT NULL")}

    def pending(self, platform: str) -> list[sqlite3.Row]:
        col = f"{platform}_id"
        return list(self.db.execute(f"SELECT * FROM videos WHERE {col} IS NULL ORDER BY publish_at, id"))

    def set_result(self, video_id: int, platform: str, remote_id: str | None, error: str | None) -> None:
        self.db.execute(f"UPDATE videos SET {platform}_id=?, {platform}_error=? WHERE id=?",
                        (remote_id, error, video_id))
        self.db.commit()

    def videos(self, limit: int = 30) -> list[sqlite3.Row]:
        return list(self.db.execute("SELECT * FROM videos ORDER BY id DESC LIMIT ?", (limit,)))
