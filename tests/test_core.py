import random
from datetime import datetime, timezone

from faceless import card, reddit, subtitles, tiktok, tts
from faceless.config import DEFAULTS
from faceless.models import Script, Word
from faceless.schedule import next_slots
from faceless.text import estimate_seconds, split_parts


def test_clean_text_strips_links_edits_and_markdown():
    raw = "**Hi** [there](http://x.y) see https://a.b/c\nEDIT: thanks for gold!\nTL;DR: stuff\n\n\n\nEnd &amp; more"
    out = reddit.clean_text(raw)
    assert "http" not in out and "EDIT" not in out and "TL;DR" not in out and "*" not in out
    assert out.startswith("Hi there") and out.endswith("End & more")


def test_split_parts_respects_limit_and_adds_cliffhanger():
    body = " ".join(f"This is sentence number {i} of a long story." for i in range(60))
    parts = split_parts(Script(title="Hook?", body=body), max_seconds=60)
    assert len(parts) > 1
    for p in parts:
        assert estimate_seconds(p.title + p.body) <= 60 + 5
    assert parts[0].title == "Hook? Part 1." and parts[1].title.startswith("Part 2.")
    assert parts[0].body.endswith("Part 2 is up next.")
    assert "up next" not in parts[-1].body
    # части примерно равные
    lens = [len(p.body) for p in parts]
    assert max(lens) / min(lens) < 2


def test_split_parts_russian_phrases():
    body = " ".join(f"Предложение номер {i} в длинной истории." for i in range(60))
    parts = split_parts(Script(title="Хук", body=body), max_seconds=60, language="ru")
    assert parts[0].body.endswith("Продолжение в части 2.")


def test_short_story_is_single_part():
    parts = split_parts(Script(title="Хук", body="Коротко. Ясно."), max_seconds=60)
    assert len(parts) == 1 and parts[0].title == "Хук"


def test_chunk_words_breaks_on_punctuation_and_gaps():
    words = [Word("Я", 0, .1), Word("пошёл", .1, .4), Word("домой.", .4, .8),
             Word("Там", .9, 1.1), Word("было", 2.0, 2.2)]
    chunks = subtitles.chunk_words(words, max_words=3)
    assert [[w.text for w in c] for c in chunks] == [["Я", "пошёл", "домой."], ["Там"], ["было"]]


def test_build_ass_skips_title_and_highlights():
    words = [Word("Заголовок", 0, .5), Word("раз", 1, 1.2), Word("два", 1.2, 1.5)]
    ass = subtitles.build_ass(words, start_at=.9, end_at=2, width=1080, height=1920, font="Inter",
                              font_size=90, highlight="&H0000F0FF")
    events = [l for l in ass.splitlines() if l.startswith("Dialogue")]
    assert len(events) == 2 and "ЗАГОЛОВОК" not in ass
    assert events[0].startswith("Dialogue: 0,0:00:01.00,0:00:01.20")
    assert "\\c&H0000F0FF&" in events[0]


def test_ass_time():
    assert subtitles.ass_time(3725.456) == "1:02:05.46"


def test_chars_to_words():
    chars = list("Привет мир")
    starts = [i * .1 for i in range(len(chars))]
    words = tts.chars_to_words(chars, starts, [s + .1 for s in starts])
    assert [(w.text, round(w.start, 1), round(w.end, 1)) for w in words] == [("Привет", 0, .6), ("мир", .7, 1.0)]


def test_next_slots_skips_taken_and_past():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)  # 15:00 по Москве
    slots = next_slots(3, publish_times=["09:30", "14:30", "19:30"], tz="Europe/Moscow",
                       taken={"2026-01-01T16:30:00+00:00"}, now=now)
    assert slots == ["2026-01-02T06:30:00+00:00", "2026-01-02T11:30:00+00:00", "2026-01-02T16:30:00+00:00"]


def test_tiktok_chunk_plan():
    assert tiktok.chunk_plan(30 * 2**20) == (30 * 2**20, 1)
    size, count = tiktok.chunk_plan(105 * 2**20)
    assert size == 10 * 2**20 and count == 10  # остаток 5 МБ уходит в последний кусок


def test_defaults_are_consistent():
    assert DEFAULTS["text"]["model"] == "claude-opus-5-5"
    assert DEFAULTS["text"]["language"] == "en"
    assert random.Random(1).choice(DEFAULTS["tts"]["voices"]).startswith("en-US")


def test_compact_number():
    assert [card.compact_number(n) for n in (950, 24100, 3000, 1_250_000)] == ["950", "24.1K", "3K", "1.2M"]


def test_cleanup_uploaded_deletes_only_fully_uploaded(tmp_path):
    from faceless.pipeline import cleanup_uploaded
    from faceless.storage import Store

    store = Store(tmp_path / "db.sqlite3")
    files = []
    for i in range(2):
        f = tmp_path / f"v{i}" / "part1.mp4"
        f.parent.mkdir()
        f.write_bytes(b"x")
        files.append(f)
        store.add_video(post_id=str(i), part=1, parts=1, path=f, title="t", description="d", tags=[],
                        publish_at=f"2030-01-0{i + 1}T00:00:00+00:00")
    store.set_result(1, "youtube", "yt1", None)
    store.set_result(1, "tiktok", "tt1", None)
    store.set_result(2, "youtube", "yt2", None)  # в TikTok ещё не ушёл
    cleanup_uploaded(store, ["youtube", "tiktok"])
    assert not files[0].exists() and not files[0].parent.exists()
    assert files[1].exists()
