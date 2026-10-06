"""Превращение поста Reddit в сценарий для озвучки.

* claude    — Claude переводит и адаптирует историю под формат коротких видео: сильный хук,
              разговорный язык, без воды; заодно ставит оценку «смотрибельности» и пишет описание.
              Это главный способ не выглядеть «бездушным» реюзом: текст получается переработанным.
* translate — машинный перевод (deep-translator / Google), без переработки.
* none      — исходный текст как есть.
"""
from __future__ import annotations

import json

from .models import Post, Script

SYSTEM_PROMPT = """Ты сценарист вертикальных роликов (YouTube Shorts / TikTok) в жанре «истории с Reddit».
Тебе дают пост (и, если это вопрос, лучшие ответы). Сделай из него сценарий для озвучки на языке: {language}.

Задача — чтобы живой зритель досмотрел до конца:
- title: первая фраза ролика и текст карточки. Это хук: интрига или конфликт за 1–2 секунды, до 90 символов.
  Не кликбейт-ложь: хук должен честно отражать историю.
- body: пересказ от первого лица (для вопросов — «Пользователи Reddit ответили…» и самые сильные ответы по очереди).
  Короткие предложения, разговорный язык, без канцелярита. Сохрани факты и развязку, убери повторы, ссылки,
  приписки EDIT/UPDATE. Числа и сокращения пиши словами так, как их надо произносить. Последняя фраза —
  вопрос к зрителю или яркая развязка. Длина body — не больше {max_chars} символов.
- description: 1–2 предложения для описания ролика + 3–5 хэштегов.
- tags: 5–10 тегов без «#».
- quality: от 1 до 10 — насколько эта история удержит зрителя (сюжет, эмоция, развязка).
  Ставь низко скучным, незавершённым, слишком локальным или токсичным историям.
Не добавляй выдуманных деталей, оскорблений и персональных данных реальных людей."""

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
    parts = [f"Сабреддит: r/{post.subreddit}", f"Заголовок: {post.title}"]
    if post.body:
        parts.append(f"Текст:\n{post.body}")
    for i, comment in enumerate(post.comments, 1):
        parts.append(f"Ответ {i}:\n{comment}")
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
    return Script(title=title, body=body, description=f"{title}\n\nИсточник: r/{post.subreddit}",
                  tags=[post.subreddit.lower()])
