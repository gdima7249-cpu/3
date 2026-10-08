"""Превращение поста Reddit в сценарий для озвучки.

* claude    — Claude переводит и адаптирует историю под формат коротких видео: сильный хук,
              разговорный язык, без воды; заодно ставит оценку «смотрибельности» и пишет описание.
              Это главный способ не выглядеть «бездушным» реюзом: текст получается переработанным.
* gemini    — то же самое через Gemini API (ключ из Google AI Studio, есть бесплатный тариф).
* auto      — что подключено: Claude, иначе Gemini, иначе как есть.
* translate — машинный перевод (deep-translator / Google), без переработки.
* none      — исходный текст как есть.
"""
from __future__ import annotations

import json
import logging
import os

from .models import Post, Script

log = logging.getLogger("faceless")

SYSTEM_PROMPT = """You write scripts for vertical short videos (YouTube Shorts / TikTok) in the "Reddit stories" genre.
You get a Reddit post (and, for question threads, the top answers). Turn it into a voice-over script.
Write every field in this language: {language}.

The goal is that a real viewer watches to the very end:
- title: the first line of the video and the text on the title card. It is the hook: intrigue or conflict
  within 1-2 seconds, at most 90 characters. No dishonest clickbait: the hook must reflect the actual story.
- body: retell the story in the first person (for question threads: "Reddit users answered..." and then the
  strongest answers one by one). Short sentences, conversational tone, no filler. Keep the facts and the
  ending; drop repetition, links and EDIT/UPDATE notes. Write numbers and abbreviations the way they should
  be spoken. End with a question to the viewer or a strong payoff. The body must be at most {max_chars} characters.
- description: 1-2 sentences for the video description plus 3-5 hashtags.
- tags: 5-10 tags without "#".
- quality: 1 to 10, how well this story will hold a viewer (plot, emotion, payoff). Score low for boring,
  unresolved, overly local or toxic stories.
Do not invent details, insults, or personal data about real people."""

SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "body": {"type": "string"},
        "description": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "quality": {"type": "integer"},
    },
    "required": ["title", "body", "description", "tags", "quality"],
    "additionalProperties": False,
}


def _post_as_text(post: Post) -> str:
    parts = [f"Subreddit: r/{post.subreddit}", f"Title: {post.title}"]
    if post.body:
        parts.append(f"Text:\n{post.body}")
    for i, comment in enumerate(post.comments, 1):
        parts.append(f"Answer {i}:\n{comment}")
    return "\n\n".join(parts)


class AdapterRefused(RuntimeError):
    pass


def adapt_claude(post: Post, cfg: dict) -> Script:
    import anthropic

    client = anthropic.Anthropic()
    max_chars = int(cfg["video"]["max_part_seconds"] * 15 * 3)  # ~15 символов/сек, до трёх частей
    response = client.beta.messages.create(
        model=cfg["text"]["model"],
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
        system=SYSTEM_PROMPT.format(language=cfg["text"]["language"], max_chars=max_chars),
        messages=[{"role": "user", "content": _post_as_text(post)}],
    )
    if response.stop_reason == "refusal":
        raise AdapterRefused(f"Claude отказался адаптировать пост {post.id}")
    text = next(b.text for b in response.content if b.type == "text")
    data = json.loads(text)
    return Script(title=data["title"].strip(), body=data["body"].strip(),
                  description=data["description"].strip(), tags=data["tags"],
                  quality=int(data["quality"]))


GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


def _gemini_schema(schema: dict) -> dict:
    """Gemini понимает урезанный OpenAPI-диалект: без additionalProperties."""
    out = {k: v for k, v in schema.items() if k != "additionalProperties"}
    if "properties" in out:
        out["properties"] = {k: _gemini_schema(v) for k, v in out["properties"].items()}
    if "items" in out:
        out["items"] = _gemini_schema(out["items"])
    return out


def adapt_gemini(post: Post, cfg: dict) -> Script:
    import requests

    max_chars = int(cfg["video"]["max_part_seconds"] * 15 * 3)
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT.format(language=cfg["text"]["language"], max_chars=max_chars)}]},
        "contents": [{"role": "user", "parts": [{"text": _post_as_text(post)}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": _gemini_schema(SCHEMA),
                             "temperature": 0.8},
    }
    last = None
    for attempt in range(3):
        resp = requests.post(GEMINI_URL.format(model=cfg["text"]["gemini_model"]), json=body, timeout=120,
                             headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
        if resp.status_code in (429, 500, 503):  # бесплатный тариф: упёрлись в лимит или сервис занят
            last = f"{resp.status_code}"
            import time
            time.sleep(10 * (attempt + 1))
            continue
        if resp.status_code >= 400:
            try:
                msg = resp.json()["error"]["message"]
            except Exception:
                msg = resp.text[:200]
            raise RuntimeError(f"Gemini {resp.status_code}: {msg}")
        data = resp.json()
        cands = data.get("candidates") or []
        if not cands or not cands[0].get("content", {}).get("parts"):
            reason = (data.get("promptFeedback") or {}).get("blockReason") or (cands[0].get("finishReason") if cands else "нет ответа")
            raise AdapterRefused(f"Gemini не вернул текст для {post.id}: {reason}")
        out = json.loads("".join(p.get("text", "") for p in cands[0]["content"]["parts"]))
        return Script(title=out["title"].strip(), body=out["body"].strip(), description=out["description"].strip(),
                      tags=list(out["tags"]), quality=int(out["quality"]))
    raise RuntimeError(f"Gemini: лимит запросов или сервис занят ({last}). Повторите позже.")


def _translate(text: str, target: str) -> str:
    from deep_translator import GoogleTranslator

    translator = GoogleTranslator(source="auto", target=target)
    chunks, buf = [], ""
    for para in text.split("\n"):
        if len(buf) + len(para) > 4500:
            chunks.append(buf)
            buf = ""
        buf += para + "\n"
    chunks.append(buf)
    return "\n".join(translator.translate(c) or "" for c in chunks if c.strip()).strip()


def adapt(post: Post, cfg: dict) -> Script:
    mode = cfg["text"]["adapter"]
    have_claude = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    have_gemini = bool(os.environ.get("GEMINI_API_KEY"))
    if mode == "auto":  # что подключено, тем и переписываем: сначала Claude, потом Gemini
        mode = "claude" if have_claude else "gemini" if have_gemini else "none"
    elif mode == "claude" and not have_claude:
        mode = "gemini" if have_gemini else "none"
    if mode == "gemini" and not have_gemini:
        mode = "none"
    if mode == "none" and cfg["text"]["adapter"] in ("claude", "gemini", "auto"):
        log.warning("Нет ключа Claude или Gemini: история идёт без переработки (как есть)")
    if mode == "claude":
        return adapt_claude(post, cfg)
    if mode == "gemini":
        return adapt_gemini(post, cfg)

    body = post.body
    if post.comments:
        body = "\n\n".join(filter(None, [body, *post.comments]))
    title = post.title
    if mode == "translate":
        lang = cfg["text"]["language"]
        title, body = _translate(title, lang), _translate(body, lang)
    elif mode != "none":
        raise ValueError(f"Неизвестный adapter: {mode}")
    return Script(title=title, body=body, description=title,
                  tags=[post.subreddit.lower()])
