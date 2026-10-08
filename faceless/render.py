"""Сборка вертикального ролика: фон + карточка-хук + субтитры + голос (+ тихая музыка)."""
from __future__ import annotations

import random
from pathlib import Path

from . import media

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm"}
AUDIO_EXT = {".mp3", ".m4a", ".wav", ".ogg"}


def _pick(folder: Path, exts: set[str], rng: random.Random) -> Path | None:
    files = sorted(p for p in folder.glob("*") if p.suffix.lower() in exts) if folder.exists() else []
    return rng.choice(files) if files else None


GRADIENTS = [  # палитры мягких «живых» фонов: тёмные, чтобы белые субтитры читались
    ("0x1b1464", "0x6a11cb", "0x0b132b"),
    ("0x023e3f", "0x0f9b8e", "0x0a1128"),
    ("0x3a0ca3", "0xf72585", "0x10002b"),
    ("0x14213d", "0xfca311", "0x0b0b0b"),
]


def ensure_backgrounds(folder: Path) -> Path:
    """Если своих фонов нет, один раз делаем несколько спокойных анимированных градиентов.

    Градиент гладкий, поэтому считаем его в малом разрешении (360x640): так создание занимает секунды, а не минуты;
    при сборке ролика кадр всё равно растягивается до нужного размера."""
    folder.mkdir(parents=True, exist_ok=True)
    if not any(p.suffix.lower() in VIDEO_EXT for p in folder.glob("*")):
        for i, (c0, c1, c2) in enumerate(GRADIENTS, 1):
            media.run(["ffmpeg", "-y", "-f", "lavfi", "-i",
                       f"gradients=s=360x640:r=24:c0={c0}:c1={c1}:c2={c2}:nb_colors=3:speed=0.02:duration=40:seed={i}",
                       "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-threads", "1",
                       "-movflags", "+faststart", str(folder / f"auto_gradient_{i}.mp4")])
    return folder


def render(*, voice: Path, subs: Path, card: Path, title_end: float, duration: float, out: Path,
           cfg: dict, rng: random.Random) -> Path:
    vc, paths = cfg["video"], cfg["paths"]
    w, h, fps = vc["width"], vc["height"], vc["fps"]
    background = _pick(Path(paths["backgrounds_dir"]), VIDEO_EXT, rng)
    if background is None:
        background = _pick(ensure_backgrounds(Path(paths["backgrounds_dir"])), VIDEO_EXT, rng)
    music = _pick(Path(paths["music_dir"]), AUDIO_EXT, rng)

    total = duration + 0.6  # небольшой хвост после последнего слова
    bg_len = media.duration(background)
    cmd = ["ffmpeg", "-y"]
    if bg_len > total + 1:
        cmd += ["-ss", f"{rng.uniform(0, bg_len - total - 1):.2f}"]  # каждый раз другой кусок фона
    else:
        cmd += ["-stream_loop", "-1"]
    cmd += ["-i", str(background.resolve()), "-i", str(voice.resolve()),
            "-loop", "1", "-i", str(card.resolve())]
    if music:
        cmd += ["-stream_loop", "-1", "-i", str(music.resolve())]

    mirror = ",hflip" if rng.random() < vc["mirror_chance"] else ""
    zoom = rng.uniform(1.0, 1.08)  # лёгкий случайный кроп, чтобы кадры не совпадали между роликами
    zw, zh = int(w * zoom) // 2 * 2, int(h * zoom) // 2 * 2
    card_end = max(title_end, 1.2)
    vf = (
        f"[0:v]scale={zw}:{zh}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps={fps}{mirror},"
        f"eq=brightness=-0.04:saturation=1.1[bg];"
        f"[2:v]scale=iw*{w / 1080:.4f}:-2,format=rgba,fade=in:st=0:d=0.2:alpha=1,fade=out:st={card_end - 0.15:.2f}:d=0.15:alpha=1[card];"
        f"[bg][card]overlay=(W-w)/2:(H-h)/2-{int(80 * w / 1080)}:enable='lte(t,{card_end:.2f})'[v1];"
        f"[v1]ass={subs.name}[v]"
    )
    if music:
        af = (f"[1:a]aresample=44100,apad[voice];[3:a]aresample=44100,volume={vc['music_volume']}[bgm];"
              f"[voice][bgm]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]")
    else:
        af = "[1:a]aresample=44100,apad,loudnorm=I=-14:TP=-1.5:LRA=11[a]"

    cmd += ["-filter_complex", f"{vf};{af}", "-map", "[v]", "-map", "[a]", "-t", f"{total:.2f}",
            "-c:v", "libx264", "-preset", vc["preset"], "-crf", str(vc.get("crf", 23)),
            "-threads", str(vc["threads"]), "-pix_fmt", "yuv420p",
            "-r", str(fps), "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-movflags", "+faststart",
            str(out.resolve())]
    out.parent.mkdir(parents=True, exist_ok=True)
    media.run(cmd, cwd=subs.parent)  # ass-фильтр получает путь без экранирования
    return out
