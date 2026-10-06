"""Загрузка в YouTube через официальный Data API v3.

Ролик загружается заранее как private с publishAt — YouTube сам опубликует его в слот.
Квота по умолчанию 10 000 единиц/сутки, одна загрузка ≈ 1600 → до ~6 роликов в день на проект.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
REDIRECT_URI = "http://localhost:8765/"


def credentials(cfg: dict, interactive: bool = False):
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    yc = cfg["youtube"]
    token = Path(yc["token"])
    creds = Credentials.from_authorized_user_file(str(token), SCOPES) if token.exists() else None
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    if not creds or not creds.valid:
        if not interactive:
            raise RuntimeError("Нет токена YouTube — выполните `python -m faceless auth-youtube`")
        creds = authorize_by_paste(yc["client_secrets"])
    token.parent.mkdir(parents=True, exist_ok=True)
    token.write_text(creds.to_json())
    return creds


def authorize_by_paste(client_secrets: str):
    """Вход без браузера на сервере: пользователь открывает ссылку у себя, а адрес, на который
    его вернул Google (страница «не открывается» — так и должно быть), вставляет в терминал."""
    from urllib.parse import parse_qs, urlparse

    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_secrets_file(client_secrets, SCOPES, redirect_uri=REDIRECT_URI)
    url, _ = flow.authorization_url(access_type="offline", prompt="consent")
    print("\n1) Откройте эту ссылку в браузере на своём компьютере или телефоне:\n")
    print(url)
    print("\n2) Войдите в Google-аккаунт канала, выберите канал и нажмите «Продолжить»/«Разрешить».")
    print("   Если увидите «Google hasn't verified this app» — нажмите «Advanced» → «Go to ... (unsafe)».")
    print("3) Браузер покажет ошибку «Не удаётся открыть страницу localhost» — это нормально.")
    print("   Скопируйте ПОЛНЫЙ адрес из адресной строки (начинается с http://localhost:8765/?...)\n")
    answer = input("Вставьте адрес сюда и нажмите Enter: ").strip()
    code = parse_qs(urlparse(answer).query).get("code", [answer])[0]
    flow.fetch_token(code=code)
    return flow.credentials


def build_body(row, cfg: dict) -> dict:
    yc = cfg["youtube"]
    title = row["title"]
    if "#shorts" not in title.lower() and len(title) <= 90:
        title = f"{title} #shorts"
    tags = list(dict.fromkeys(json.loads(row["tags"] or "[]") + yc["default_tags"]))
    status = {"selfDeclaredMadeForKids": False, "containsSyntheticMedia": yc["contains_synthetic_media"]}
    publish_at = datetime.fromisoformat(row["publish_at"])
    if publish_at > datetime.now(timezone.utc) + timedelta(minutes=15):
        status |= {"privacyStatus": "private", "publishAt": publish_at.strftime("%Y-%m-%dT%H:%M:%SZ")}
    else:  # слот уже прошёл (например, сервер был выключен) — публикуем сразу
        status["privacyStatus"] = "public"
    return {
        "snippet": {
            "title": title[:100],
            "description": row["description"][:4900],
            "tags": tags[:30],
            "categoryId": yc["category_id"],
            "defaultLanguage": cfg["text"]["language"],
            "defaultAudioLanguage": cfg["text"]["language"],
        },
        "status": status,
    }


UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"


def upload(row, cfg: dict, attempts: int = 6) -> str:
    """Resumable upload через REST (без тяжёлой google-api-python-client — экономим ~110 МБ диска)."""
    import time

    from google.auth.transport.requests import AuthorizedSession

    session = AuthorizedSession(credentials(cfg))
    path = Path(row["path"])
    size = path.stat().st_size
    init = session.post(
        UPLOAD_URL, params={"uploadType": "resumable", "part": "snippet,status"},
        json=build_body(row, cfg), timeout=60,
        headers={"X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": str(size)},
    )
    _raise(init)
    location = init.headers["Location"]

    offset = 0
    for attempt in range(attempts):
        try:
            with path.open("rb") as f:
                f.seek(offset)
                headers = {"Content-Length": str(size - offset), "Content-Type": "video/mp4"}
                if offset:
                    headers["Content-Range"] = f"bytes {offset}-{size - 1}/{size}"
                resp = session.put(location, data=f, headers=headers, timeout=900)
            if resp.status_code in (200, 201):
                return resp.json()["id"]
            if resp.status_code < 500 and resp.status_code != 308:
                _raise(resp)
        except OSError:
            pass  # обрыв соединения — спросим, сколько дошло, и продолжим
        time.sleep(min(60, 2 ** attempt * 3))
        status = session.put(location, headers={"Content-Range": f"bytes */{size}", "Content-Length": "0"},
                             timeout=60)
        if status.status_code in (200, 201):
            return status.json()["id"]
        rng = status.headers.get("Range")  # "bytes=0-12345"
        offset = int(rng.split("-")[1]) + 1 if rng else 0
    raise RuntimeError("YouTube: загрузка не удалась после нескольких попыток")


def _raise(resp) -> None:
    if resp.status_code >= 400:
        try:
            err = resp.json()["error"]
            reason = (err.get("errors") or [{}])[0].get("reason", "")
            msg = f"{err.get('code')} {reason}: {err.get('message')}"
        except Exception:
            msg = f"{resp.status_code}: {resp.text[:300]}"
        raise RuntimeError(f"YouTube {msg}")
