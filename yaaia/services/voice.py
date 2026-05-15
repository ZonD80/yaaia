from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
import wave
from collections.abc import Callable
from pathlib import Path

from ..config import VoiceConfig

Log = Callable[[str], None]


class MacOSSpeechService:
    def __init__(self, config: VoiceConfig, log: Log) -> None:
        self.config = config
        self.log = log

    def check(self) -> None:
        self._require_macos()
        output = self._run_speech_helper(["check", self.config.speech_locale])
        engine = output.get("engine") or "SpeechAnalyzer"
        locale = output.get("locale") or self.config.speech_locale
        self.log(f"Native speech ready: STT={engine} locale={locale}; TTS=NSSpeechSynthesizer.")

    def synthesize_to_file(self, text: str) -> Path:
        self._require_macos()
        cleaned = sanitize_text_for_tts(text)
        if not cleaned:
            raise RuntimeError("Nothing to speak after stripping routing and markup.")
        output_dir = self.config.data_dir / "tts"
        output_dir.mkdir(parents=True, exist_ok=True)
        path = output_dir / f"tts-{int(time.time() * 1000)}.caf"
        self._run_speech_helper(
            [
                "synthesize-file",
                str(path),
                self.config.tts_voice,
                str(self.config.tts_rate),
                cleaned,
            ]
        )
        if not path.exists():
            raise RuntimeError("macOS TTS did not produce an audio file.")
        return path

    def transcribe_file(self, audio_path: Path) -> str:
        return self._transcribe_file(audio_path, preprocess=True)

    def transcribe_prepared_file(self, audio_path: Path) -> str:
        return self._transcribe_file(audio_path, preprocess=False)

    def _transcribe_file(self, audio_path: Path, *, preprocess: bool) -> str:
        self._require_macos()
        if not audio_path.exists():
            raise FileNotFoundError(audio_path)
        stt_audio_path = self.prepare_stt_audio_file(audio_path) if preprocess else audio_path
        output = self._run_speech_helper(["transcribe-file", str(stt_audio_path), self.config.speech_locale])
        return str(output.get("text") or "").strip()

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

    def pcm_to_stt_wav(self, pcm: bytes, *, prefix: str) -> Path:
        if not pcm:
            raise RuntimeError("No PCM audio captured for STT.")
        output_dir = self.config.data_dir / "stt"
        output_dir.mkdir(parents=True, exist_ok=True)
        path = output_dir / f"{prefix}-stt-{int(time.time() * 1000)}.wav"
        padded_pcm = _pad_pcm_silence(
            pcm,
            sample_rate=self.config.sample_rate,
            channels=self.config.channels,
            seconds=self.config.stt_pad_seconds,
        )
        command = self._ffmpeg_stt_command("pipe:0", path, raw_input=True)
        completed = subprocess.run(
            command,
            input=padded_pcm,
            capture_output=True,
            timeout=self.config.command_timeout_seconds,
            check=False,
        )
        if completed.returncode != 0:
            detail = completed.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"ffmpeg STT preparation failed: {detail or f'exit {completed.returncode}'}")
        return path

    def prepare_stt_audio_file(self, audio_path: Path) -> Path:
        output_dir = self.config.data_dir / "stt"
        output_dir.mkdir(parents=True, exist_ok=True)
        path = output_dir / f"{audio_path.stem}-stt-{int(time.time() * 1000)}.wav"
        command = self._ffmpeg_stt_command(str(audio_path), path, raw_input=False)
        completed = subprocess.run(
            command,
            capture_output=True,
            timeout=self.config.command_timeout_seconds,
            check=False,
        )
        if completed.returncode != 0:
            detail = completed.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"ffmpeg STT preparation failed: {detail or f'exit {completed.returncode}'}")
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

    def _run_speech_helper(self, args: list[str]) -> dict[str, object]:
        helper = self._ensure_speech_helper()
        completed = subprocess.run(
            [str(helper), *args],
            text=True,
            capture_output=True,
            timeout=self.config.command_timeout_seconds,
            check=False,
        )
        stdout = completed.stdout.strip()
        payload: dict[str, object] | None = None
        if stdout:
            try:
                payload = json.loads(stdout.splitlines()[-1])
            except json.JSONDecodeError:
                payload = None
        if completed.returncode != 0:
            detail = ""
            if payload and payload.get("error"):
                detail = str(payload["error"])
            else:
                detail = (completed.stderr or completed.stdout or "").strip()
            raise RuntimeError(f"SpeechAnalyzer helper failed: {detail or f'exit {completed.returncode}'}")
        if payload is None:
            detail = (completed.stderr or completed.stdout or "").strip()
            raise RuntimeError(f"SpeechAnalyzer helper returned invalid output: {detail}")
        if payload.get("ok") is not True:
            raise RuntimeError(str(payload.get("error") or "SpeechAnalyzer helper reported failure."))
        return payload

    def _ensure_speech_helper(self) -> Path:
        if self.config.speech_helper_path:
            path = self.config.speech_helper_path
            if not path.exists():
                raise RuntimeError(f"Configured SpeechAnalyzer helper does not exist: {path}")
            return path

        source = Path(__file__).resolve().parents[1] / "helpers" / "macos_speech_helper.swift"
        if not source.exists():
            raise RuntimeError(f"SpeechAnalyzer helper source is missing: {source}")
        plist = source.with_name("macos_speech_helper_Info.plist")
        output_dir = self.config.data_dir / "helpers"
        output_dir.mkdir(parents=True, exist_ok=True)
        module_cache = output_dir / "module-cache"
        module_cache.mkdir(parents=True, exist_ok=True)
        binary = output_dir / "yaaia-speech-helper"
        latest_input_mtime = max(
            source.stat().st_mtime,
            plist.stat().st_mtime if plist.exists() else 0,
        )
        if binary.exists() and binary.stat().st_mtime >= latest_input_mtime:
            return binary

        swiftc_command = self._swiftc_command()
        if not swiftc_command:
            raise RuntimeError("swiftc is required to build the SpeechAnalyzer helper.")
        self.log("Building native SpeechAnalyzer helper...")
        env = os.environ.copy()
        env["CLANG_MODULE_CACHE_PATH"] = str(module_cache)
        env["SWIFT_MODULE_CACHE_PATH"] = str(module_cache)
        command = [
            *swiftc_command,
            str(source),
            "-O",
            "-parse-as-library",
            "-module-cache-path",
            str(module_cache),
            "-Xcc",
            f"-fmodules-cache-path={module_cache}",
            "-framework",
            "Speech",
            "-framework",
            "AVFoundation",
            "-framework",
            "AppKit",
        ]
        if plist.exists():
            command.extend(
                [
                    "-Xlinker",
                    "-sectcreate",
                    "-Xlinker",
                    "__TEXT",
                    "-Xlinker",
                    "__info_plist",
                    "-Xlinker",
                    str(plist),
                ]
            )
        command.extend(["-o", str(binary)])
        completed = subprocess.run(
            command,
            text=True,
            capture_output=True,
            timeout=self.config.command_timeout_seconds,
            check=False,
            env=env,
        )
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "").strip()
            raise RuntimeError(f"Could not build SpeechAnalyzer helper: {detail or f'exit {completed.returncode}'}")
        return binary

    def _swiftc_command(self) -> list[str] | None:
        xcrun = shutil.which("xcrun")
        if xcrun:
            return [xcrun, "swiftc"]
        swiftc = shutil.which("swiftc")
        return [swiftc] if swiftc else None

    def _ffmpeg_stt_command(self, input_path: str, output_path: Path, *, raw_input: bool) -> list[str]:
        command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
        if raw_input:
            command.extend(
                [
                    "-f",
                    "s16le",
                    "-ar",
                    str(self.config.sample_rate),
                    "-ac",
                    str(self.config.channels),
                ]
            )
        command.extend(["-i", input_path])
        filters = ["highpass=f=80", "lowpass=f=7600"] if self.config.stt_normalize else []
        if self.config.stt_normalize:
            filters.append("dynaudnorm=f=75:g=15:p=0.95")
        if filters:
            command.extend(["-af", ",".join(filters)])
        command.extend(
            [
                "-ac",
                str(self.config.stt_channels),
                "-ar",
                str(self.config.stt_sample_rate),
                "-sample_fmt",
                "s16",
                str(output_path),
            ]
        )
        return command

    def _require_macos(self) -> None:
        if sys.platform != "darwin":
            raise RuntimeError("Native speech calls require macOS.")


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


def _pad_pcm_silence(pcm: bytes, *, sample_rate: int, channels: int, seconds: float) -> bytes:
    if seconds <= 0:
        return pcm
    silence = b"\x00" * int(sample_rate * channels * 2 * seconds)
    return silence + pcm + silence
