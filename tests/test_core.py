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


def test_telegram_publish_flow(tmp_path, monkeypatch):
    from faceless import pipeline, telegram
    from faceless.config import DEFAULTS, _merge
    from faceless.storage import Store

    cfg = _merge(DEFAULTS, {"paths": {"db": str(tmp_path / "db.sqlite3")},
                            "youtube": {"token": str(tmp_path / "none.json")},
                            "telegram": {"enabled": True}})
    video = tmp_path / "v" / "part1.mp4"
    video.parent.mkdir()
    video.write_bytes(b"x")
    store = Store(cfg["paths"]["db"])
    store.add_video(post_id="p", part=1, parts=2, path=video, title="Hook", description="Desc",
                    tags=["reddit stories"], publish_at="2000-01-01T00:00:00+00:00")
    sent = []
    monkeypatch.setattr(telegram, "upload", lambda row, cfg: sent.append(telegram.caption_text(row)) or "42")
    pipeline.publish(cfg)
    assert "часть 1/2" in sent[0] and "#redditstories" in sent[0]
    assert Store(cfg["paths"]["db"]).videos()[0]["telegram_id"] == "42"
    assert not video.exists()  # YouTube не подключён → учитывается только Telegram, файл удалён


def test_youtube_resumable_upload_resumes_after_drop(tmp_path, monkeypatch):
    import google.auth.transport.requests as gtr
    from faceless import youtube
    from faceless.config import DEFAULTS

    video = tmp_path / "v.mp4"
    video.write_bytes(b"0123456789")
    calls = []

    class Resp:
        def __init__(self, code, headers=None, body=None):
            self.status_code, self.headers, self._body, self.text = code, headers or {}, body or {}, ""

        def json(self):
            return self._body

    class FakeSession:
        def __init__(self, creds):
            pass

        def post(self, url, **kw):
            calls.append(("init", kw["headers"]["X-Upload-Content-Length"]))
            return Resp(200, {"Location": "https://upload/session"})

        def put(self, url, data=None, headers=None, **kw):
            if headers.get("Content-Range", "").startswith("bytes */"):
                calls.append(("status",))
                return Resp(308, {"Range": "bytes=0-3"})
            sent = data.read()
            calls.append(("put", headers.get("Content-Range"), sent))
            if len([c for c in calls if c[0] == "put"]) == 1:
                raise ConnectionError("drop")  # обрыв на первой попытке
            return Resp(201, body={"id": "abc123"})

    monkeypatch.setattr(gtr, "AuthorizedSession", FakeSession)
    monkeypatch.setattr(youtube, "credentials", lambda cfg: None)
    monkeypatch.setattr("time.sleep", lambda s: None)
    row = {"path": str(video), "title": "T", "description": "D", "tags": "[]",
           "publish_at": "2000-01-01T00:00:00+00:00"}
    assert youtube.upload(row, DEFAULTS) == "abc123"
    assert calls[0] == ("init", "10")
    assert calls[-1] == ("put", "bytes 4-9/10", b"456789")


def test_direct_link_and_hints():
    from faceless.setup_wizard import _html_hint, direct_link

    drive = direct_link("https://drive.google.com/file/d/1rk7VOTUHuD4l1RgN6WUC6LUDYTrSJCbB/view?usp=sharing")
    assert drive == ("https://drive.usercontent.google.com/download?id=1rk7VOTUHuD4l1RgN6WUC6LUDYTrSJCbB"
                     "&export=download&confirm=t")
    assert direct_link("https://drive.google.com/open?id=ABC_1").endswith("id=ABC_1&export=download&confirm=t")
    assert direct_link("https://www.dropbox.com/s/x/a.mp4?dl=0").endswith("a.mp4?dl=1")
    assert direct_link("https://www.dropbox.com/s/x/a.mp4").endswith("a.mp4?dl=1")
    assert direct_link("https://videos.pexels.com/a.mp4") == "https://videos.pexels.com/a.mp4"
    assert "Все, у кого есть ссылка" in _html_hint(drive, "<html>Sign in to continue</html>")
    assert "Pexels" in _html_hint("https://example.com/x", "<html></html>")


def test_wizard_rejects_misplaced_values():
    from faceless.setup_wizard import _check_value

    assert _check_value("ANTHROPIC_API_KEY", "") is None
    assert _check_value("ANTHROPIC_API_KEY", "sk-ant-abc123") is None
    assert "JSON" in _check_value("ANTHROPIC_API_KEY", '{"installed":{"client_id":"x"}}')
    assert "sk-ant" in _check_value("ANTHROPIC_API_KEY", "abc123")
    assert _check_value("REDDIT_CLIENT_ID", "a1B2c3D4e5") is None
    assert _check_value("REDDIT_CLIENT_ID", "two words") is not None


def test_post_from_text():
    from faceless.cli import post_from_text

    p = post_from_text("\n  My neighbor stole my Wi-Fi\n\nIt started in **2021**.\nEDIT: thanks!\nThen it got weird.\n")
    assert p.title == "My neighbor stole my Wi-Fi"
    assert "EDIT" not in p.body and "**" not in p.body and p.body.startswith("It started in 2021.")
    assert p.id.startswith("txt-") and post_from_text("a\nb").id == post_from_text("a\nb").id


def test_reddit_user_agent(monkeypatch):
    from faceless import reddit

    monkeypatch.delenv("REDDIT_USER_AGENT", raising=False)
    monkeypatch.setenv("REDDIT_USERNAME", "u/DinRed")
    assert reddit._user_agent() == "linux:faceless-factory:0.1 (by /u/DinRed)"
    monkeypatch.delenv("REDDIT_USERNAME")
    assert reddit._user_agent() == "linux:faceless-factory:0.1"
