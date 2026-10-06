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


def upload(row, cfg: dict) -> str:
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload

    service = build("youtube", "v3", credentials=credentials(cfg), cache_discovery=False)
    media = MediaFileUpload(row["path"], mimetype="video/mp4", chunksize=8 * 1024 * 1024, resumable=True)
    request = service.videos().insert(part="snippet,status", body=build_body(row, cfg), media_body=media)
    response = None
    while response is None:
        _, response = request.next_chunk(num_retries=5)
    return response["id"]
