"""Публикация в TikTok через официальный Content Posting API (Direct Post).

Ограничения TikTok: приложение должно пройти аудит, иначе посты доступны только как SELF_ONLY;
отложенной публикации в API нет — поэтому `publish` надо запускать по cron, и он постит
ролики, чей слот уже наступил.
"""
from __future__ import annotations

import math
import os
import time
from pathlib import Path

import requests

API = "https://open.tiktokapis.com/v2"
MIN_CHUNK, MAX_CHUNK = 5 * 1024 * 1024, 64 * 1024 * 1024


def chunk_plan(size: int, chunk: int = 10 * 1024 * 1024) -> tuple[int, int]:
    """(chunk_size, total_chunk_count) по правилам TikTok: файл < 64 МБ — одним куском,
    иначе куски по chunk, а остаток приклеивается к последнему."""
    if size <= MAX_CHUNK:
        return size, 1
    chunk = min(max(chunk, MIN_CHUNK), MAX_CHUNK)
    return chunk, max(1, math.floor(size / chunk))


def _headers() -> dict:
    return {"Authorization": f"Bearer {os.environ['TIKTOK_ACCESS_TOKEN']}",
            "Content-Type": "application/json; charset=UTF-8"}


def upload(row, cfg: dict, poll_seconds: int = 300) -> str:
    path = Path(row["path"])
    size = path.stat().st_size
    chunk_size, count = chunk_plan(size)
    caption = f"{row['title']}\n\n{row['description']}"[:2200]

    init = requests.post(f"{API}/post/publish/video/init/", headers=_headers(), timeout=30, json={
        "post_info": {"title": caption, "privacy_level": cfg["tiktok"]["privacy_level"],
                      "disable_duet": False, "disable_comment": False, "disable_stitch": False,
                      "is_aigc": True},
        "source_info": {"source": "FILE_UPLOAD", "video_size": size,
                        "chunk_size": chunk_size, "total_chunk_count": count},
    })
    init.raise_for_status()
    data = init.json()["data"]
    publish_id, upload_url = data["publish_id"], data["upload_url"]

    with path.open("rb") as f:
        for i in range(count):
            start = i * chunk_size
            end = size - 1 if i == count - 1 else start + chunk_size - 1
            f.seek(start)
            body = f.read(end - start + 1)
            r = requests.put(upload_url, data=body, timeout=300, headers={
                "Content-Type": "video/mp4", "Content-Length": str(len(body)),
                "Content-Range": f"bytes {start}-{end}/{size}"})
            r.raise_for_status()

    deadline = time.time() + poll_seconds
    while time.time() < deadline:
        st = requests.post(f"{API}/post/publish/status/fetch/", headers=_headers(), timeout=30,
                           json={"publish_id": publish_id})
        st.raise_for_status()
        status = st.json()["data"].get("status")
        if status == "PUBLISH_COMPLETE":
            return publish_id
        if status == "FAILED":
            raise RuntimeError(f"TikTok: {st.json()['data'].get('fail_reason')}")
        time.sleep(10)
    return publish_id  # ещё обрабатывается — TikTok допубликует сам
