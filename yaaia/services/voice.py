from __future__ import annotations

import re
import subprocess
import sys
import time
import wave
from collections.abc import Callable
from pathlib import Path

from ..config import VoiceConfig

Log = Callable[[str], None]


class MlxAudioService:
    def __init__(self, config: VoiceConfig, log: Log) -> None:
        self.config = config
        self.log = log

    def synthesize_to_file(self, text: str) -> Path:
        cleaned = sanitize_text_for_tts(text)
        if not cleaned:
            raise RuntimeError("Nothing to speak after stripping routing and markup.")
        output_dir = self.config.data_dir / "tts"
        output_dir.mkdir(parents=True, exist_ok=True)
        before = _audio_files(output_dir)
        command = [
            sys.executable,
            "-m",
            "mlx_audio.tts.generate",
            "--model",
            self.config.tts_model,
            "--text",
            cleaned,
            "--output_path",
            str(output_dir),
            "--join_audio",
        ]
        if self.config.tts_voice:
            command.extend(["--voice", self.config.tts_voice])
        if self.config.tts_language:
            command.extend(["--lang_code", self.config.tts_language])
        completed = subprocess.run(
            command,
            text=True,
            capture_output=True,
            timeout=self.config.command_timeout_seconds,
            check=False,
        )
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "").strip()
            raise RuntimeError(f"mlx-audio TTS failed: {detail or f'exit {completed.returncode}'}")
        created = [path for path in _audio_files(output_dir) if path not in before]
        candidates = created or _audio_files(output_dir)
        if not candidates:
            raise RuntimeError("mlx-audio TTS did not produce an audio file.")
        return max(candidates, key=lambda path: path.stat().st_mtime)

    def transcribe_file(self, audio_path: Path) -> str:
        if not audio_path.exists():
            raise FileNotFoundError(audio_path)
        output_dir = self.config.data_dir / "stt"
        output_dir.mkdir(parents=True, exist_ok=True)
        transcript_path = output_dir / f"{audio_path.stem}-transcript-{int(time.time() * 1000)}"
        code = (
            "import sys\n"
            "from mlx_audio.stt.generate import generate_transcription\n"
            "result = generate_transcription(model=sys.argv[2], audio=sys.argv[1], output_path=sys.argv[3])\n"
            "print(getattr(result, 'text', result) or '')\n"
        )
        completed = subprocess.run(
            [sys.executable, "-c", code, str(audio_path), self.config.stt_model, str(transcript_path)],
            text=True,
            capture_output=True,
            timeout=self.config.command_timeout_seconds,
            check=False,
        )
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "").strip()
            raise RuntimeError(f"mlx-audio STT failed: {detail or f'exit {completed.returncode}'}")
        return completed.stdout.strip()

    def pcm_to_wav(self, pcm: bytes, *, prefix: str) -> Path:
        output_dir = self.config.data_dir / "stt"
        output_dir.mkdir(parents=True, exist_ok=True)
        path = output_dir / f"{prefix}-{int(time.time() * 1000)}.wav"
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(self.config.channels)
            wav.setsampwidth(2)
            wav.setframerate(self.config.sample_rate)
            wav.writeframes(pcm)
        return path

    def audio_file_to_pcm16(self, audio_path: Path) -> bytes:
        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(audio_path),
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ac",
            str(self.config.channels),
            "-ar",
            str(self.config.sample_rate),
            "pipe:1",
        ]
        completed = subprocess.run(
            command,
            capture_output=True,
            timeout=self.config.command_timeout_seconds,
            check=False,
        )
        if completed.returncode != 0:
            detail = completed.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"ffmpeg PCM conversion failed: {detail or f'exit {completed.returncode}'}")
        return completed.stdout

    def preview_tts(self, text: str) -> Path:
        return self.synthesize_to_file(text)


def sanitize_text_for_tts(text: str) -> str:
    cleaned = text.strip()
    cleaned = re.sub(r"(?m)^\s*(root|telegram--?\d+|gmail-[^:]+|calendar-[^:]+|email-[^:]+)\s*:\s*", "", cleaned)
    cleaned = re.sub(r"\[/?[a-zA-Z0-9_*=-]+(?:=[^\]]*)?\]", "", cleaned)
    cleaned = re.sub(r"```[\s\S]*?```", " ", cleaned)
    cleaned = re.sub(r"`([^`]+)`", r"\1", cleaned)
    cleaned = re.sub(r"\*\*([^*]+)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"__([^_]+)__", r"\1", cleaned)
    cleaned = re.sub(r"\*([^*]+)\*", r"\1", cleaned)
    cleaned = re.sub(r"_([^_]+)_", r"\1", cleaned)
    cleaned = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def _audio_files(directory: Path) -> set[Path]:
    suffixes = {".wav", ".mp3", ".flac", ".aiff", ".aif", ".m4a", ".ogg"}
    return {path for path in directory.iterdir() if path.is_file() and path.suffix.lower() in suffixes}
