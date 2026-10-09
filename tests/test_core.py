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
        assert estimate_seconds(p.title + p.body) <= 60 * 1.1 + 1
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


def test_gemini_schema_and_adapter_selection(monkeypatch):
    from faceless import adapt
    from faceless.cli import DEMO_POST_EN
    from faceless.config import DEFAULTS, _merge

    schema = adapt._gemini_schema(adapt.SCHEMA)
    assert "additionalProperties" not in schema and "tags" in schema["properties"]

    calls = []
    monkeypatch.setattr(adapt, "adapt_gemini", lambda post, cfg: calls.append("gemini") or "G")
    monkeypatch.setattr(adapt, "adapt_claude", lambda post, cfg: calls.append("claude") or "C")
    cfg = _merge(DEFAULTS, {})
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GEMINI_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    assert adapt.adapt(DEMO_POST_EN, cfg).body.startswith("Three years ago")  # ни одного ключа: как есть
    monkeypatch.setenv("GEMINI_API_KEY", "AIza" + "x" * 35)
    assert adapt.adapt(DEMO_POST_EN, cfg) == "G"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-x")
    assert adapt.adapt(DEMO_POST_EN, cfg) == "C"  # Claude главнее, если подключены оба
    assert calls == ["gemini", "claude"]


def test_inbox_parse_and_selection(tmp_path, monkeypatch):
    from faceless import inbox, pipeline
    from faceless.config import DEFAULTS, _merge
    from faceless.storage import Store

    text = ("TITLE: The neighbor's dog\nStory: " + "It was a long night and the dog kept barking. " * 4 +
            "\n---\n**The second story**\n" + "Nothing happened at first, then everything did. " * 4 +
            "\n---\nshort\ntoo short\n---\n")
    stories = inbox.parse(text)
    assert [t for t, _ in stories] == ["The neighbor's dog", "The second story"]
    assert stories[0][1].startswith("It was a long night") and "**" not in stories[1][1]

    cfg = _merge(DEFAULTS, {"paths": {"db": str(tmp_path / "db.sqlite3"), "inbox": str(tmp_path / "inbox.txt")},
                            "stories": {"source": "inbox"}})
    assert inbox.append(cfg["paths"]["inbox"], text) == 2
    assert pipeline.inbox_left(cfg) == 2
    produced = []
    monkeypatch.setattr(pipeline, "produce", lambda post, script, cfg, store, rng: produced.append(post.title) or [tmp_path / "x.mp4"])
    made = pipeline.make(cfg, 1)
    assert produced == ["The neighbor's dog"] and len(made) == 1
    assert pipeline.inbox_left(cfg) == 1  # первая история отмечена использованной
    pipeline.make(cfg, 5)
    assert produced == ["The neighbor's dog", "The second story"] and pipeline.inbox_left(cfg) == 0


def test_ipv4_only_context_restores_state():
    import socket

    import urllib3.util.connection as conn

    from faceless.adapt import ipv4_only

    before = conn.HAS_IPV6
    with ipv4_only(True):
        assert conn.allowed_gai_family() == socket.AF_INET
    assert conn.HAS_IPV6 == before
    with ipv4_only(False):
        assert conn.HAS_IPV6 == before


def test_queue_cancel_and_skip(tmp_path):
    from faceless import inbox, pipeline
    from faceless.cli import _inbox_waiting, main
    from faceless.storage import Store

    db = tmp_path / "db.sqlite3"
    store = Store(db)
    files = []
    for part in (1, 2):
        f = tmp_path / f"p{part}.mp4"
        f.write_bytes(b"x")
        files.append(f)
        store.add_video(post_id="s1", part=part, parts=2, path=f, title="Story one", description="d", tags=[],
                        publish_at=f"2030-01-0{part}T00:00:00+00:00")
    f3 = tmp_path / "other.mp4"
    f3.write_bytes(b"x")
    store.add_video(post_id="s2", part=1, parts=1, path=f3, title="Story two", description="d", tags=[],
                    publish_at="2030-01-03T00:00:00+00:00")
    assert store.undelivered() == 3
    assert len(store.cancel(1)) == 2            # отменяются обе части истории
    assert store.undelivered() == 1 and store.cancel(1) == []   # повторная отмена ничего не делает
    assert [r["title"] for r in store.pending("telegram")] == ["Story two"]

    inb = tmp_path / "inbox.txt"
    inbox.append(inb, ("TITLE: A\n" + "alpha beta gamma delta. " * 5 + "\n---\nTITLE: B\n" + "one two three four. " * 5))
    cfgfile = tmp_path / "config.toml"
    cfgfile.write_text(f'[paths]\ndb = "{db}"\ninbox = "{inb}"\n')
    main(["-c", str(cfgfile), "skip", "1"])
    from faceless.config import load_config
    assert [t for t, _ in _inbox_waiting(load_config(cfgfile), Store(db))] == ["B"]


def test_telegram_build_text_and_sync(tmp_path, monkeypatch):
    from faceless import inbox, telegram
    from faceless.config import DEFAULTS, _merge

    # Длинную историю Telegram режет на куски: продолжение склеивается, отдельные сообщения — разные истории
    body = "word " * 800  # ~4000 символов
    first = "TITLE: Long one\n" + body
    text = telegram.build_text([first, "and the end of the long story, it keeps going on and on for a bit more.",
                                "TITLE: Second\n" + "Another story text that is long enough to count. " * 3])
    parsed = inbox.parse(text)
    assert [t for t, _ in parsed] == ["Long one", "Second"] and "keeps going" in parsed[0][1]

    cfg = _merge(DEFAULTS, {"paths": {"db": str(tmp_path / "db.sqlite3"), "inbox": str(tmp_path / "inbox.txt")}})
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:abc")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    story = "TITLE: From phone\n" + "A believable situation with a twist at the end. " * 4
    updates = [
        {"update_id": 10, "message": {"chat": {"id": 42}, "text": story}},
        {"update_id": 11, "message": {"chat": {"id": 999}, "text": "TITLE: Stranger\n" + "evil " * 40}},  # чужой чат
        {"update_id": 12, "message": {"chat": {"id": 42}, "text": "/queue"}},
    ]
    sent, calls = [], []

    def fake_call(method, token=None, **kw):
        calls.append((method, kw.get("data")))
        if method == "getUpdates":
            return updates if not (tmp_path / "tg_offset.txt").exists() else []
        if method == "sendMessage":
            sent.append(kw["data"]["text"])
        return {}

    monkeypatch.setattr(telegram, "_call", fake_call)
    assert telegram.sync_inbox(cfg) == 1
    assert [t for t, _ in inbox.load(cfg["paths"]["inbox"])] == ["From phone"]  # чужое не попало
    assert any("Добавлено новых: 1" in m for m in sent) and any("Готовых роликов" in m for m in sent)
    assert (tmp_path / "tg_offset.txt").read_text() == "12"
    assert telegram.sync_inbox(cfg) == 0  # повторно те же сообщения не обрабатываются


def test_inbox_parse_without_separators():
    from faceless import inbox

    text = ("TITLE: First\n" + "Some long enough story text here. " * 4 +
            "\nTITLE: Second\n" + "More long enough story text here. " * 4 +
            "\n**TITLE: Third**\n" + "And yet another story text here. " * 4)
    assert [t for t, _ in inbox.parse(text)] == ["First", "Second", "Third"]


def test_send_now_and_relative_time(tmp_path, monkeypatch, capsys):
    from datetime import datetime, timedelta, timezone

    from faceless import telegram
    from faceless.cli import _in, main
    from faceless.storage import Store

    assert _in((datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()) == "пора отправлять"
    assert _in((datetime.now(timezone.utc) + timedelta(hours=3, minutes=20, seconds=30)).isoformat()).startswith("через 3 ч")

    db = tmp_path / "db.sqlite3"
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    store = Store(db)
    store.add_video(post_id="p", part=1, parts=1, path=video, title="Hook", description="d", tags=[],
                    publish_at=(datetime.now(timezone.utc) + timedelta(hours=5)).isoformat(timespec="seconds"))
    cfgfile = tmp_path / "config.toml"
    cfgfile.write_text(f'[paths]\ndb = "{db}"\n')
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "1:a")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "5")
    monkeypatch.setattr(telegram, "upload", lambda row, cfg: "777")
    main(["-c", str(cfgfile), "send"])
    assert "Отправлено" in capsys.readouterr().out
    assert Store(db).videos()[0]["telegram_id"] == "777" and Store(db).undelivered() == 0


def test_broll_pick_file_and_visuals_line():
    from faceless import broll, inbox

    video = {"id": 1, "video_files": [
        {"file_type": "video/mp4", "width": 3840, "height": 2160, "link": "landscape4k"},
        {"file_type": "video/mp4", "width": 2160, "height": 3840, "link": "portrait4k"},
        {"file_type": "video/mp4", "width": 1080, "height": 1920, "link": "portrait_hd"},
        {"file_type": "video/mp4", "width": 720, "height": 1280, "link": "portrait_720"},
        {"file_type": "video/webm", "width": 720, "height": 1280, "link": "webm"}]}
    assert broll.pick_file(video) == "portrait_720"          # вертикальный, не 4K, ближе всего к 720
    assert broll.pick_file({"video_files": [{"file_type": "video/mp4", "width": 1920, "height": 1080, "link": "x"}]}) is None

    body, vis = inbox.split_visuals("Story text here.\nVISUALS: Coffee machine, office; night street.\n")
    assert body == "Story text here." and vis == ["Coffee machine", "office", "night street"]
    assert inbox.split_visuals("No keywords here.") == ("No keywords here.", [])


def test_broll_build_for_with_fake_pexels(tmp_path, monkeypatch):
    import random
    import shutil
    import subprocess

    from faceless import broll, media
    from faceless.config import DEFAULTS, _merge

    clip = tmp_path / "src.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=360x640:r=24", "-t", "7",
                    "-c:v", "libx264", "-preset", "ultrafast", str(clip)], check=True)
    monkeypatch.setattr(broll, "search", lambda q, key, per_page=15: [
        {"id": i, "video_files": [{"file_type": "video/mp4", "width": 720, "height": 1280, "link": f"l{i}"}]} for i in range(1, 6)])
    monkeypatch.setattr(broll, "download", lambda url, dest: (dest.parent.mkdir(parents=True, exist_ok=True), shutil.copy(clip, dest), dest)[2])
    monkeypatch.setenv("PEXELS_API_KEY", "x" * 30)
    cfg = _merge(DEFAULTS, {"paths": {"backgrounds_dir": str(tmp_path / "assets" / "backgrounds")},
                            "video": {"width": 360, "height": 640, "fps": 24}})
    assert broll.enabled(cfg)
    out = broll.build_for(["coffee", "office"], 12.0, tmp_path, cfg, random.Random(1))
    assert media.duration(out) >= 14.0                      # длительность + запас
    assert (tmp_path / "assets" / "broll_cache").exists()


def test_facts_parse_finalize_and_timing(tmp_path):
    import random

    from faceless import pipeline, subtitles, tts
    from faceless.config import DEFAULTS, _merge
    from faceless.models import Script, Word
    from faceless.text import narration, parse_segments

    body = ("1. Honey never spoils; edible honey was found in ancient Egyptian tombs. | ancient honey jar\n"
            "Fact 2: Bananas curve because they grow upwards against gravity. | banana tree\n"
            "- Nutmeg is a hallucinogen in large doses because of myristicin. | nutmeg\n"
            "Which of these surprised you the most? | amazed face")
    segs = parse_segments(body)
    assert [v for _, v in segs] == ["ancient honey jar", "banana tree", "nutmeg", "amazed face"]
    assert segs[0][0].startswith("Honey never spoils") and segs[1][0].startswith("Bananas")
    assert parse_segments("A normal story without pipes.\nSecond line of the story.") == []
    assert narration([("No end", "x"), ("Ends here.", "y")]) == "No end. Ends here."

    sc = pipeline.finalize(Script(title="T", body=body, description="T #storytime #story", tags=["storytime", "fiction", "x"]))
    assert sc.kind == "facts" and len(sc.segments) == 4 and "|" not in sc.body
    assert sc.tags[:3] == ["facts", "didyouknow", "funfacts"] and "fiction" not in sc.tags
    assert "#facts" in sc.description

    cfg = _merge(DEFAULTS, {"tts": {"engine": "silent"}})
    sp = tts.synthesize("Title here", sc.body, tmp_path, cfg, random.Random(1), pieces=[t for t, _ in sc.segments])
    assert len(sp.pieces) == 4 and all(a < b for a, b in sp.pieces)
    assert all(sp.pieces[i][1] < sp.pieces[i + 1][0] for i in range(3))   # факты идут подряд с паузами
    assert sp.pieces[0][0] > sp.title_end and sp.duration >= sp.pieces[-1][1]

    ass = subtitles.build_ass([Word("hi", 1, 1.2)], start_at=0.5, end_at=3, width=720, height=1280, font="Inter",
                              font_size=61, highlight="&H0000F0FF", badges=[(1.0, 2.5, "FACT 2")])
    assert "FACT 2" in ass and "\\an8" in ass


def test_pixabay_candidates_and_library_fallback(tmp_path, monkeypatch):
    import random
    import shutil
    import subprocess

    from faceless import broll, media
    from faceless.config import DEFAULTS, _merge
    from faceless.setup_wizard import _check_value

    hit = {"id": 7, "videos": {"large": {"url": "https://cdn/large.mp4", "size": 80 * 2**20},   # слишком тяжёлый
                               "medium": {"url": "https://cdn/medium.mp4", "size": 6 * 2**20},
                               "small": {"url": "https://cdn/small.mp4", "size": 2 * 2**20}}}
    assert broll.pick_pixabay(hit) == "https://cdn/medium.mp4"
    assert broll.pick_pixabay({"videos": {"large": {"url": "", "size": 1}}}) is None

    monkeypatch.delenv("PEXELS_API_KEY", raising=False)
    monkeypatch.setenv("PIXABAY_API_KEY", "12345678-abcdef0123456789abcdef012")
    monkeypatch.setattr(broll, "search_pixabay", lambda q, key, per_page=20: [hit])
    assert broll.candidates("ocean") == [("pixabay-7", "https://cdn/medium.mp4")]
    assert _check_value("PIXABAY_API_KEY", "12345678-abcdef0123456789abcdef012") is None
    assert _check_value("PIXABAY_API_KEY", "no way") is not None

    # без ключей, но со своими видео: имя файла = тема, подбор по словам
    monkeypatch.delenv("PIXABAY_API_KEY")
    lib = tmp_path / "assets" / "backgrounds"
    lib.mkdir(parents=True)
    src = tmp_path / "src.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=360x640:r=24", "-t", "6",
                    "-c:v", "libx264", "-preset", "ultrafast", str(src)], check=True)
    for name in ("ocean.mp4", "city_night.mp4", "auto_gradient_1.mp4"):
        shutil.copy(src, lib / name)
    cfg = _merge(DEFAULTS, {"paths": {"backgrounds_dir": str(lib)}, "video": {"width": 360, "height": 640, "fps": 24}})
    assert [p.name for p in broll.library_clips(cfg)] == ["city_night.mp4", "ocean.mp4"]  # градиенты не в счёт
    assert broll.enabled(cfg)
    assert broll._library_clip("ocean waves", broll.library_clips(cfg), random.Random(1), set()).name == "ocean.mp4"
    out = broll.build_for(["ocean"], 8.0, tmp_path, cfg, random.Random(2), windows=[(4.0, "ocean"), (6.5, "night city")])
    assert media.duration(out) >= 10.0


def test_inbox_dedupe_clear_and_append_only_new(tmp_path):
    from faceless import inbox, pipeline

    def story(title):
        return f"TITLE: {title}\n" + "A long enough story text that goes on and on. " * 4

    path = tmp_path / "inbox.txt"
    batch = "\n---\n".join(story(t) for t in ("One", "Two", "Three"))
    assert inbox.append(path, batch) == 3
    assert inbox.append(path, batch) == 0                       # та же пачка второй раз: ничего нового
    assert inbox.append(path, batch + "\n---\n" + story("Four")) == 1
    assert [t for t, _ in inbox.load(path)] == ["One", "Two", "Three", "Four"]

    # файл, где повторы уже накопились (как у пользователя), читается без дублей
    path.write_text(batch + "\n---\n" + batch + "\n---\n" + batch, encoding="utf-8")
    assert [t for t, _ in inbox.load(path)] == ["One", "Two", "Three"]

    assert inbox.clear(path) == 3 and not path.exists() and (tmp_path / "inbox.old.txt").exists()
    assert inbox.load(path) == []
