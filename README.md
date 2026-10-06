# faceless-factory

Автоматическая фабрика вертикальных роликов (YouTube Shorts / TikTok) из историй Reddit.
По умолчанию ролики на **английском** (самая большая аудитория и выше доход с просмотра);
русский включается в `config.toml`: `language = "ru"` + русские голоса.
Python + FFmpeg, без MoviePy (так в разы быстрее).

```
Reddit (OAuth API) ─► фильтр + анти-дубли (SQLite)
   ─► адаптация: Claude переписывает в сценарий с хуком (на нужном языке), ставит оценку 1–10
   ─► нарезка на части ≤ 60 с с клиффхэнгером «Продолжение в части 2»
   ─► озвучка Edge TTS / ElevenLabs с таймингами каждого слова
   ─► субтитры ASS: 1–3 слова, подсветка текущего слова, «поп»-анимация
   ─► FFmpeg: фон 9:16 (случайный кусок, кроп, отражение) + карточка-хук + голос + музыка, громкость −14 LUFS
   ─► очередь со слотами публикации ─► YouTube Data API (publishAt) / TikTok Content Posting API
```

## Быстрый старт

```bash
sudo apt install ffmpeg            # или brew install ffmpeg
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

python -m faceless demo            # офлайн-проверка: соберёт output/demo/.../part1.mp4 без сети и ключей
python -m faceless demo --tts edge # то же, но с настоящим голосом Edge TTS
```

Боевой режим:

```bash
cp config.example.toml config.toml   # сабреддиты, язык, голоса, расписание
cp .env.example .env                 # ключи Reddit / Anthropic / ElevenLabs / TikTok
# положите 3+ длинных фоновых видео в assets/backgrounds/ (геймплей, паркур в Minecraft, мыло, краски…)
# опционально — тихую музыку без авторских прав в assets/music/

python -m faceless candidates        # что сейчас подходит
python -m faceless make -n 3         # собрать 3 истории (длинные дадут несколько частей)
python -m faceless make-file examples/story.json   # из своего JSON, если Reddit недоступен
python -m faceless auth-youtube      # один раз: OAuth, токен в secrets/
python -m faceless publish --dry-run
python -m faceless publish
python -m faceless status
```

На сервере — `deploy/*.timer` (systemd): сборка раз в сутки ночью, `publish` каждые 15 минут.
Есть `Dockerfile` (config.toml, .env, secrets/, assets/, output/, data/ монтируйте томами).

## Ключи и доступы

| Что | Где взять | Зачем |
|---|---|---|
| `REDDIT_CLIENT_ID/SECRET` | reddit.com/prefs/apps → «script» | официальный API; публичный `.json` с серверных IP часто отдаёт 403/429 |
| `ANTHROPIC_API_KEY` | platform.claude.com | адаптация историй (`text.adapter = "claude"`); без ключа — `none` (для английского перевод не нужен) |
| `ELEVENLABS_API_KEY` | elevenlabs.io | если нужен голос лучше Edge TTS (`tts.engine = "elevenlabs"`) |
| `secrets/client_secret.json` | Google Cloud Console → YouTube Data API v3 → OAuth client «Desktop» | загрузка в YouTube |
| `TIKTOK_ACCESS_TOKEN` | developers.tiktok.com, scope `video.publish` | загрузка в TikTok |

## Как бот борется с «бездушностью» и урезанием охватов

Главное правило: алгоритм режет ролики, которые **люди не досматривают**, и YouTube снимает
с монетизации **массовый однотипный контент** (политика inauthentic content). Поэтому:

1. **Отбор.** Только посты с высоким рейтингом, нужной длиной, без NSFW; Claude ставит оценку
   «смотрибельности» и отсекает скучные/незавершённые истории (`text.min_quality`).
2. **Переработка, а не перезалив.** Claude пишет сценарий заново: хук в первой фразе, разговорный
   язык, без воды, вопрос зрителю в конце (повышает комментарии). Это уже не дословная копия поста.
3. **Первые 2 секунды.** Хук звучит сразу и висит на карточке поверх видео — зритель понимает конфликт до свайпа.
4. **Темп.** Голос +12 %, паузы короткие, субтитры по 1–3 слова с подсветкой — глазу есть за чем следить.
5. **Части.** Длинные истории режутся на равные части с клиффхэнгером — серии смотрят подряд.
6. **Разнообразие.** Ротация голосов, цвета подсветки, случайный кусок фона, кроп и отражение,
   разные слоты публикации — ролики не выглядят клонами.
7. **Честность.** YouTube получает флаг `containsSyntheticMedia`, TikTok — `is_aigc`. Это требование
   платформ для реалистичного синтетического контента; скрывать его — прямой путь к страйку.

Что стоит добавить дальше (под реальные данные канала): забирать удержание из YouTube Analytics API
и подкручивать сабреддиты/длину/голос под лучшие ролики; A/B хуков.

## Важно знать заранее

- **Без эмуляторов и накрутки.** Загрузка только через официальные API. Эмуляторы/антидетект для
  массовой заливки нарушают правила платформ и приводят к бану аккаунтов.
- **YouTube:** квота API по умолчанию 10 000 ед./сутки, загрузка ≈ 1600 → ~6 роликов в день (можно
  запросить увеличение). Для YPP нужны 1000 подписчиков и 10 млн просмотров Shorts за 90 дней.
- **TikTok:** до аудита приложения посты доступны только как `SELF_ONLY` (видно лишь вам);
  отложенной публикации в API нет — поэтому `publish` по таймеру постит наступившие слоты.
- **Reddit:** тексты принадлежат авторам; коммерческое использование данных Reddit API регулируется
  их Data API Terms. Указывайте источник (бот пишет `История: r/...` в описании) и не используйте
  ники/личные данные.
- **Фон и музыка** — только свои или с лицензией на коммерческое использование: Content ID
  заберёт монетизацию за чужой геймплей с музыкой или чужой трек.

## Структура

```
faceless/
  reddit.py     сбор и очистка постов (OAuth / публичный JSON)
  adapt.py      Claude / машинный перевод / как есть
  text.py       нарезка на части
  tts.py        Edge TTS, ElevenLabs, silent; тайминги слов
  subtitles.py  генерация ASS
  card.py       карточка-хук (Pillow)
  render.py     сборка через FFmpeg
  schedule.py   слоты публикации
  storage.py    SQLite: использованные посты, очередь
  youtube.py    YouTube Data API v3 (resumable upload, publishAt)
  tiktok.py     TikTok Content Posting API (chunked upload)
  pipeline.py   всё вместе
  cli.py        команды
tests/          pytest (без сети)
deploy/         systemd-таймеры
```

Тесты: `pip install pytest && python -m pytest`.
