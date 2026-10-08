"""Сбор популярных историй с Reddit.

С заданными REDDIT_CLIENT_ID/SECRET используется официальный OAuth (app-only) через
oauth.reddit.com — это надёжно и укладывается в лимиты API. Без них — публичный .json,
который Reddit часто режет для серверных IP.
"""
from __future__ import annotations

import html
import os
import re
import time

import requests

from .models import Post

_session = requests.Session()
_token: tuple[str, float] | None = None


def _user_agent() -> str:
    """Reddit требует честную подпись вида «платформа:приложение:версия (by /u/ник)»."""
    if os.environ.get("REDDIT_USER_AGENT"):
        return os.environ["REDDIT_USER_AGENT"]
    user = os.environ.get("REDDIT_USERNAME", "").lstrip("/").removeprefix("u/")
    return f"linux:faceless-factory:0.1 (by /u/{user})" if user else "linux:faceless-factory:0.1"


def _auth_headers() -> tuple[str, dict]:
    global _token
    cid, secret = os.environ.get("REDDIT_CLIENT_ID"), os.environ.get("REDDIT_CLIENT_SECRET")
    headers = {"User-Agent": _user_agent()}
    if not (cid and secret):
        return "https://www.reddit.com", headers
    if _token is None or _token[1] < time.time() + 60:
        resp = _session.post(
            "https://www.reddit.com/api/v1/access_token",
            auth=(cid, secret), data={"grant_type": "client_credentials"},
            headers=headers, timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        _token = (data["access_token"], time.time() + data.get("expires_in", 3600))
    headers["Authorization"] = f"bearer {_token[0]}"
    return "https://oauth.reddit.com", headers


def _get(path: str, params: dict) -> dict | list:
    base, headers = _auth_headers()
    for attempt in range(4):
        resp = _session.get(f"{base}{path}", params={**params, "raw_json": 1},
                            headers=headers, timeout=20)
        if resp.status_code == 429:
            time.sleep(2 ** attempt * 5)
            continue
        resp.raise_for_status()
        return resp.json()
    resp.raise_for_status()
    return {}


_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_URL = re.compile(r"https?://\S+")
_EDIT = re.compile(r"^\s*(edit|update|eta|ps)\s*\d*\s*[:\-].*$", re.I | re.M)
_TLDR = re.compile(r"^\s*tl;?dr.*$", re.I | re.M)


def clean_text(text: str) -> str:
    """Убирает разметку и то, что плохо звучит голосом: ссылки, EDIT/UPDATE-приписки, TL;DR."""
    text = html.unescape(text)
    text = _MD_LINK.sub(r"\1", text)
    text = _URL.sub("", text)
    text = _EDIT.sub("", text)
    text = _TLDR.sub("", text)
    text = re.sub(r"[*_~^>#`]+", "", text)
    text = re.sub(r"&amp;|&nbsp;", " ", text)
    text = re.sub(r"\n{2,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def _top_comments(post_id: str, limit: int, min_chars: int = 40) -> list[str]:
    data = _get(f"/comments/{post_id}", {"sort": "top", "limit": limit * 4, "depth": 1})
    out = []
    for child in data[1]["data"]["children"]:
        c = child.get("data", {})
        body = clean_text(c.get("body", ""))
        if child.get("kind") != "t1" or c.get("stickied") or body in ("[deleted]", "[removed]"):
            continue
        if c.get("author") == "AutoModerator" or len(body) < min_chars or len(body) > 900:
            continue
        out.append(body)
        if len(out) >= limit:
            break
    return out


def fetch_posts(subreddit: str, cfg: dict) -> list[Post]:
    rc = cfg["reddit"]
    params = {"limit": rc["limit"]}
    if rc["sort"] == "top":
        params["t"] = rc["time"]
    listing = _get(f"/r/{subreddit}/{rc['sort']}", params)
    is_question = subreddit.lower() in {s.lower() for s in rc["question_subreddits"]}

    posts = []
    for child in listing["data"]["children"]:
        d = child["data"]
        if d.get("over_18") or d.get("stickied") or d.get("score", 0) < rc["min_score"]:
            continue
        body = clean_text(d.get("selftext", ""))
        if body in ("[deleted]", "[removed]"):
            continue
        post = Post(id=d["id"], subreddit=d["subreddit"], title=clean_text(d["title"]), body=body,
                    score=d["score"], url="https://www.reddit.com" + d["permalink"])
        if is_question:
            post.comments = _top_comments(post.id, rc["top_comments"])
            if len(post.comments) < 2:
                continue
        size = len(post.body) + sum(map(len, post.comments))
        if rc["min_chars"] <= size <= rc["max_chars"]:
            posts.append(post)
    return posts
