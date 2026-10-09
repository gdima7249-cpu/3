"""Тонкие обёртки над ffmpeg/ffprobe."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path


def run(cmd: list[str], cwd: str | Path | None = None) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    if proc.returncode != 0:
        raise RuntimeError(f"Команда упала ({proc.returncode}): {' '.join(cmd)}\n{proc.stderr[-3000:]}")


def duration(path: str | Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    return float(json.loads(out)["format"]["duration"])


def silence(path: Path, seconds: float) -> Path:
    run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", f"{seconds:.3f}",
         "-c:a", "libmp3lame", "-q:a", "4", str(path)])
    return path


def to_wav(path: Path) -> Path:
    """mp3 -> wav 44.1 кГц моно: у mp3 есть служебные «хвосты», у wav длительность точная (нужна для таймингов)."""
    out = path.with_suffix(".wav")
    run(["ffmpeg", "-y", "-i", str(path), "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", str(out)])
    return out


def concat_audio(inputs: list[Path], out: Path) -> Path:
    """Склеивает аудиофайлы последовательно, приводя к 44.1 кГц моно."""
    cmd = ["ffmpeg", "-y"]
    for p in inputs:
        cmd += ["-i", str(p)]
    chains = "".join(f"[{i}:a]aresample=44100,aformat=channel_layouts=mono[a{i}];" for i in range(len(inputs)))
    joined = "".join(f"[a{i}]" for i in range(len(inputs)))
    cmd += ["-filter_complex", f"{chains}{joined}concat=n={len(inputs)}:v=0:a=1[out]",
            "-map", "[out]", "-c:a", "pcm_s16le", str(out)]
    run(cmd)
    return out
