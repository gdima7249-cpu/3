from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Post:
    id: str
    subreddit: str
    title: str
    body: str
    score: int
    url: str
    comments: list[str] = field(default_factory=list)

    @property
    def is_question(self) -> bool:
        return bool(self.comments)


@dataclass
class Script:
    """Текст, готовый к озвучке: хук-заголовок + тело, плюс метаданные для публикации."""
    title: str            # читается первым и показывается на карточке
    body: str
    description: str = ""
    tags: list[str] = field(default_factory=list)
    quality: int = 10     # оценка «смотрибельности» от адаптера
    visuals: list[str] = field(default_factory=list)  # ключевые слова для видеофона (англ.)
    segments: list[tuple[str, str]] = field(default_factory=list)  # «факты»: (текст, ключевые слова кадра)
    kind: str = "story"  # story | facts


@dataclass
class Word:
    text: str
    start: float  # секунды
    end: float


@dataclass
class Part:
    """Одна часть ролика (длинные истории режутся на несколько)."""
    index: int
    total: int
    title: str
    body: str
