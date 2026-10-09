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
- visuals: 4 to 6 short ENGLISH keywords (1-2 words each) for concrete things that could be filmed as stock video to
  illustrate this story (for example "coffee machine", "office", "night street"). No people's names.
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
        "visuals": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "body", "description", "tags", "quality", "visuals"],
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


def _claude_json(cfg: dict, system: str, user: str, what: str) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    response = client.beta.messages.create(
        model=cfg["text"]["model"],
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    if response.stop_reason == "refusal":
        raise AdapterRefused(f"Claude отказался: {what}")
    return json.loads(next(b.text for b in response.content if b.type == "text"))


GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class ipv4_only:
    """Пока выполняется блок, соединения идут только по IPv4.

    У многих VPS есть и IPv4, и IPv6, а Google определяет страну по адресу, с которого пришёл запрос.
    Если IPv6-адрес записан за другой страной, Gemini отвечает «User location is not supported»,
    хотя IPv4 сервера в поддерживаемой стране. Выбор семейства адресов не меняет, где стоит сервер."""

    def __init__(self, enabled: bool = True):
        self.enabled = enabled

    def __enter__(self):
        import urllib3.util.connection as conn

        self._conn, self._old = conn, conn.HAS_IPV6
        if self.enabled:
            conn.HAS_IPV6 = False
        return self

    def __exit__(self, *exc):
        self._conn.HAS_IPV6 = self._old
        return False


def _gemini_schema(schema: dict) -> dict:
    """Gemini понимает урезанный OpenAPI-диалект: без additionalProperties."""
    out = {k: v for k, v in schema.items() if k != "additionalProperties"}
    if "properties" in out:
        out["properties"] = {k: _gemini_schema(v) for k, v in out["properties"].items()}
    if "items" in out:
        out["items"] = _gemini_schema(out["items"])
    return out


def _gemini_json(cfg: dict, system: str, user: str, what: str, temperature: float = 0.8) -> dict:
    import time

    import requests

    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": _gemini_schema(SCHEMA),
                             "temperature": temperature},
    }
    models = cfg["text"].get("gemini_models") or [cfg["text"].get("gemini_model", "gemini-flash-latest")]
    last = "нет ответа"
    for rnd in range(3):  # три круга по всем моделям, с паузами между кругами
        for model in models:
            try:
                with ipv4_only(cfg["text"].get("ipv4_only", True)):
                    resp = requests.post(GEMINI_URL.format(model=model), json=body, timeout=(10, 60),
                                         headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
            except requests.RequestException as e:  # таймаут или обрыв: пробуем следующую модель
                last = f"{model}: {type(e).__name__}"
                continue
            if resp.status_code in (429, 500, 503, 404):  # лимит бесплатного тарифа, перегрузка, модель снята
                last = f"{model}: {resp.status_code}"
                continue
            if resp.status_code >= 400:
                try:
                    msg = resp.json()["error"]["message"]
                except Exception:
                    msg = resp.text[:200]
                if "location is not supported" in msg:
                    raise RuntimeError("Gemini недоступен с этого сервера: Google не поддерживает страну по IP-адресу "
                                       "сервера. Используйте faceless inbox (см. ИНСТРУКЦИЯ.md).")
                raise RuntimeError(f"Gemini {resp.status_code}: {msg}")
            data = resp.json()
            cands = data.get("candidates") or []
            if not cands or not cands[0].get("content", {}).get("parts"):
                reason = (data.get("promptFeedback") or {}).get("blockReason") or (cands[0].get("finishReason") if cands else "нет ответа")
                last = f"{model}: {reason}"
                continue
            try:
                return json.loads("".join(p.get("text", "") for p in cands[0]["content"]["parts"]))
            except ValueError:
                last = f"{model}: обрезанный ответ"
                continue
        if rnd < 2:
            time.sleep(20 * (rnd + 1))
    raise RuntimeError(f"Gemini недоступен или лимит исчерпан ({last}). Повторю позже.")


def _to_script(data: dict) -> Script:
    return Script(title=data["title"].strip(), body=data["body"].strip(), description=data["description"].strip(),
                  tags=list(data["tags"]), quality=int(data["quality"]),
                  visuals=[str(v).strip() for v in data.get("visuals", []) if str(v).strip()][:8])


def _max_chars(cfg: dict) -> int:
    return int(cfg["video"]["max_part_seconds"] * 15 * 3)  # ~15 символов/сек, до трёх частей


def adapt_claude(post: Post, cfg: dict) -> Script:
    system = SYSTEM_PROMPT.format(language=cfg["text"]["language"], max_chars=_max_chars(cfg))
    return _to_script(_claude_json(cfg, system, _post_as_text(post), f"пост {post.id}"))


def adapt_gemini(post: Post, cfg: dict) -> Script:
    system = SYSTEM_PROMPT.format(language=cfg["text"]["language"], max_chars=_max_chars(cfg))
    return _to_script(_gemini_json(cfg, system, _post_as_text(post), f"пост {post.id}"))


def llm_provider(cfg: dict) -> str | None:
    """Чем писать тексты: Claude, если есть ключ, иначе Gemini, иначе никак."""
    pref = cfg["text"]["adapter"]
    have_claude = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    have_gemini = bool(os.environ.get("GEMINI_API_KEY"))
    if pref == "gemini":
        return "gemini" if have_gemini else None
    if pref == "claude" and have_claude:
        return "claude"
    return "claude" if have_claude else "gemini" if have_gemini else None


GENERATE_PROMPT = """You write original fictional first-person stories for vertical short videos (YouTube Shorts / TikTok) in the "storytime" genre: a ground-level, believable situation, a clear conflict, a twist, a satisfying payoff.
Write every field in this language: {language}.

This is FICTION that you invent. It is not a retelling of any real post, article or person. Never claim it really happened.

Requirements:
- title: the hook, max 90 characters, intriguing, honest to the story.
- body: the whole story in first person. Short conversational sentences, no filler, a strong twist, a final line that is a payoff or a question to the viewer. At most {max_chars} characters. Numbers and abbreviations written the way they are spoken.
- description: 1-2 sentences plus 3-5 hashtags.
- tags: 5-10 tags without "#".
- visuals: 4 to 6 short ENGLISH keywords (1-2 words each) for concrete things that could be filmed as stock video to
  illustrate this story (for example "coffee machine", "office", "night street"). No people's names.
- quality: 1-10, honest self-assessment of how well this holds a viewer.
Avoid: real people or brands in a bad light, violence against children, sexual content, hate, self-harm, medical or legal advice, politics.
Do NOT reuse the plot of any of these recent stories:
{recent}"""


FACTS_PROMPT = """You write scripts for "Did you know?" vertical short videos (YouTube Shorts / TikTok).
Write every field in this language: {language}.
One video is about ONE topic: {topic}.

- title: the hook, at most 80 characters, like "5 ocean facts that sound fake" (the number must match the number of facts).
- body: exactly {n} facts, ONE per line, no numbering and no bullets. Each line: one or two short spoken sentences
  (110 to 170 characters) with a concrete number or detail, then " | " and 1-2 ENGLISH keywords for a stock video clip
  that illustrates THAT fact (e.g. "deep sea", "northern lights"). Only well-established, verifiable facts; if you are
  not sure a number is right, leave the number out; avoid absolute claims ("only", "first", "biggest", "never")
  unless they are certain and commonly documented. No medical, legal or financial advice. The last line MUST end
  with a question mark (a question to the viewer). Do not start lines with "Did you know".
- description: 1-2 sentences plus 3-5 hashtags.
- tags: 5-10 tags without "#".
- visuals: 4 to 6 short ENGLISH keywords for the topic as a whole.
- quality: 1-10, honest self-assessment of how well this holds a viewer.
Do NOT repeat the facts or topic of these recent videos:
{recent}"""


def generate_story(cfg: dict, recent_titles: list[str], rng) -> Script:
    """Придумывает ролик: «факты» (по умолчанию) или оригинальную вымышленную историю (content.format)."""
    facts = cfg.get("content", {}).get("format", "stories") == "facts"
    recent = "\n".join(f"- {t}" for t in recent_titles[:40]) or "(none yet)"
    if facts:
        topic = rng.choice(cfg["content"]["topics"])
        system = FACTS_PROMPT.format(language=cfg["text"]["language"], topic=topic, recent=recent,
                                     n=cfg["content"].get("facts_per_video", 5))
        user = f"Topic: {topic}. Pick a fresh angle, with surprising, specific facts."
    else:
        theme = rng.choice(cfg["stories"]["themes"])
        system = GENERATE_PROMPT.format(language=cfg["text"]["language"], max_chars=cfg["stories"]["max_chars"],
                                        recent=recent)
        user = f"Theme: {theme}. Make it surprising and specific (concrete names of places, objects, numbers)."
    provider = llm_provider(cfg)
    if provider == "claude":
        data = _claude_json(cfg, system, user, "генерация ролика")
    elif provider == "gemini":
        data = _gemini_json(cfg, system, user, "генерация ролика", temperature=1.0)
    else:
        raise RuntimeError("Для придуманных роликов нужен ключ Gemini или Claude (faceless setup --keys)")
    script = _to_script(data)
    script.tags = list(dict.fromkeys(script.tags + (["facts", "didyouknow"] if facts else ["storytime", "fiction"])))
    return script


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
    if mode in ("claude", "gemini", "auto"):
        mode = llm_provider(cfg) or "none"
        if mode == "none":
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
