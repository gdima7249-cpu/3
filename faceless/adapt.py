"""Превращение поста Reddit в сценарий для озвучки.

* claude    — Claude переводит и адаптирует историю под формат коротких видео: сильный хук,
              разговорный язык, без воды; заодно ставит оценку «смотрибельности» и пишет описание.
              Это главный способ не выглядеть «бездушным» реюзом: текст получается переработанным.
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
    if mode == "claude" and not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        log.warning("Нет ANTHROPIC_API_KEY — истории идут без переработки Claude (adapter = none)")
        mode = "none"
    if mode == "claude":
        return adapt_claude(post, cfg)

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
