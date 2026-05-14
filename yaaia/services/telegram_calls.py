from __future__ import annotations

import asyncio
import shlex
import sys
import threading
import time
from array import array
from collections.abc import Callable
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import TelegramConfig, VoiceConfig
from ..events import MessageEvent, utc_now
from .voice import MlxAudioService

Emit = Callable[[MessageEvent], None]
Log = Callable[[str], None]


@dataclass(slots=True)
class _ActiveCall:
    chat_id: int
    bus_id: str
    mode: str = "listening"
    recording: bool = False
    buffer: bytearray = field(default_factory=bytearray)
    last_voice_at: float = 0.0
    utterance_started_at: float = 0.0
    silence_task: asyncio.Task[Any] | None = None


class TelegramVoiceCallService:
    def __init__(
        self,
        telegram_config: TelegramConfig,
        voice_config: VoiceConfig,
        voice: MlxAudioService,
        emit: Emit,
        log: Log,
    ) -> None:
        self.telegram_config = telegram_config
        self.config = voice_config
        self.voice = voice
        self.emit = emit
        self.log = log
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._startup_error: BaseException | None = None
        self._lock = threading.RLock()
        self._calls: dict[int, _ActiveCall] = {}
        self._pending_incoming: set[int] = set()
        self._call_py: Any | None = None
        self._pyrogram: Any | None = None
        self._types: dict[str, Any] = {}

    @property
    def running(self) -> bool:
        return self._loop is not None and self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if not self.config.enabled:
            raise RuntimeError("Telegram calls are disabled. Set YAAIA_CALLS_ENABLED=1.")
        if not self.telegram_config.api_id or not self.telegram_config.api_hash:
            raise RuntimeError("Telegram calls require YAAIA_TELEGRAM_API_ID and YAAIA_TELEGRAM_API_HASH.")
        if not self.telegram_config.phone and not self.telegram_config.bot_token:
            raise RuntimeError("Telegram calls require phone login or bot token.")
        with self._lock:
            if self.running:
                return
            self._ready.clear()
            self._startup_error = None
            self._thread = threading.Thread(target=self._thread_main, name="yaaia-telegram-calls", daemon=True)
            self._thread.start()
        if not self._ready.wait(timeout=max(30, self.config.command_timeout_seconds)):
            raise RuntimeError("Timed out while starting Telegram call service.")
        if self._startup_error:
            raise RuntimeError(f"Telegram call service failed: {self._startup_error}") from self._startup_error

    def stop(self) -> None:
        loop = self._loop
        if not loop:
            return
        try:
            future = asyncio.run_coroutine_threadsafe(self._async_stop(), loop)
            future.result(timeout=15)
        except Exception as exc:  # noqa: BLE001
            self.log(f"Telegram call service stop failed: {exc}")
        finally:
            loop.call_soon_threadsafe(loop.stop)
            with self._lock:
                self._loop = None

    def status(self) -> dict[str, Any]:
        with self._lock:
            calls = [
                {"bus_id": state.bus_id, "chat_id": state.chat_id, "mode": state.mode}
                for state in self._calls.values()
            ]
            pending = [f"telegram-{chat_id}" for chat_id in sorted(self._pending_incoming)]
        return {
            "enabled": self.config.enabled,
            "running": self.running,
            "active_calls": calls,
            "pending_incoming": pending,
            "sample_rate": self.config.sample_rate,
            "channels": self.config.channels,
            "tts_model": self.config.tts_model,
            "stt_model": self.config.stt_model,
        }

    def list_connected_buses(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                {
                    "bus_id": state.bus_id,
                    "source": "telegram-call",
                    "title": f"voice call ({state.mode})",
                    "state": "connected",
                    "unread_count": 0,
                }
                for state in self._calls.values()
            ]

    def is_active_bus(self, bus_id: str) -> bool:
        try:
            chat_id = parse_telegram_chat_id(bus_id)
        except ValueError:
            return False
        with self._lock:
            return chat_id in self._calls

    def start_call(self, bus_or_chat_id: str) -> str:
        self.start()
        chat_id = parse_telegram_chat_id(bus_or_chat_id)
        self._run(self._begin_call(chat_id), timeout=max(30, self.config.call_timeout_seconds + 30))
        return f"Call active on telegram-{chat_id}."

    def accept_call(self, bus_or_chat_id: str) -> str:
        return self.start_call(bus_or_chat_id)

    def hangup(self, bus_or_chat_id: str | None = None) -> str:
        self.start()
        chat_id = self._target_chat_id(bus_or_chat_id)
        self._run(self._hangup(chat_id), timeout=20)
        return f"Call closed on telegram-{chat_id}."

    def reject(self, bus_or_chat_id: str | None = None) -> str:
        return self.hangup(bus_or_chat_id)

    def forget_bus(self, bus_or_chat_id: str) -> str | None:
        try:
            chat_id = parse_telegram_chat_id(bus_or_chat_id)
        except ValueError:
            return None
        if self.running:
            with self._lock:
                active = chat_id in self._calls
            if active:
                try:
                    return self.hangup(f"telegram-{chat_id}")
                except Exception as exc:  # noqa: BLE001 - forgetting should still continue
                    return f"Call cleanup failed on telegram-{chat_id}: {exc}"
            self._run(self._discard_pending(chat_id), timeout=10)
        else:
            with self._lock:
                self._pending_incoming.discard(chat_id)
        return None

    def say(self, bus_or_chat_id: str, text: str, *, sender: str = "assistant") -> str:
        self.start()
        chat_id = parse_telegram_chat_id(bus_or_chat_id)
        with self._lock:
            if chat_id not in self._calls:
                raise RuntimeError(f"No active call on telegram-{chat_id}.")
            self._calls[chat_id].mode = "speaking"
        try:
            audio_path = self.voice.synthesize_to_file(text)
            pcm = self.voice.audio_file_to_pcm16(audio_path)
            self._run(self._send_pcm(chat_id, pcm), timeout=max(30, self.config.command_timeout_seconds))
            self.emit(
                MessageEvent(
                    source="telegram-call",
                    bus_id=f"telegram-{chat_id}",
                    sender=sender,
                    text=f"[Spoken] {text}",
                    timestamp=utc_now(),
                    outbound=True,
                    meta={"audio_path": str(audio_path)},
                )
            )
            return f"Spoke {len(pcm)} PCM bytes on telegram-{chat_id} from {audio_path}."
        finally:
            with self._lock:
                state = self._calls.get(chat_id)
                if state:
                    state.mode = "listening"

    def transcribe_file(self, audio_path: Path) -> str:
        return self.voice.transcribe_file(audio_path)

    def preview_tts(self, text: str) -> Path:
        return self.voice.preview_tts(text)

    def handle_agent_command(self, content: str) -> str:
        parts = shlex.split(content)
        if not parts:
            raise ValueError("Usage: call:<status|start|accept|hangup|reject|say|tts|stt> ...")
        command = parts[0].lower()
        if command == "status":
            return str(self.status())
        if command in {"start", "call"} and len(parts) >= 2:
            return self.start_call(parts[1])
        if command in {"accept", "pickup"} and len(parts) >= 2:
            return self.accept_call(parts[1])
        if command in {"hangup", "stop"}:
            return self.hangup(parts[1] if len(parts) >= 2 else None)
        if command == "reject":
            return self.reject(parts[1] if len(parts) >= 2 else None)
        if command == "say" and len(parts) >= 3:
            return self.say(parts[1], " ".join(parts[2:]))
        if command == "tts" and len(parts) >= 2:
            return str(self.preview_tts(" ".join(parts[1:])))
        if command == "stt" and len(parts) == 2:
            return self.transcribe_file(Path(parts[1]).expanduser())
        raise ValueError("Usage: call:<status|start|accept|hangup|reject|say|tts|stt> ...")

    def _thread_main(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        with self._lock:
            self._loop = loop
        try:
            loop.run_until_complete(self._async_start())
            self._ready.set()
            loop.run_forever()
        except BaseException as exc:  # noqa: BLE001 - startup errors cross thread boundary
            self._startup_error = exc
            self._ready.set()
        finally:
            try:
                pending = asyncio.all_tasks(loop)
                for task in pending:
                    task.cancel()
                if pending:
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            finally:
                loop.close()

    async def _async_start(self) -> None:
        try:
            from pyrogram import Client
            from pytgcalls import PyTgCalls, filters
            from pytgcalls.types import ChatUpdate, Device, Direction, ExternalMedia, MediaStream, RecordStream
            from pytgcalls.types.raw import AudioParameters
        except ImportError as exc:
            raise RuntimeError("Install voice dependencies with `pip install -r requirements-voice.txt`.") from exc

        self._types = {
            "AudioParameters": AudioParameters,
            "ChatUpdate": ChatUpdate,
            "Device": Device,
            "Direction": Direction,
            "ExternalMedia": ExternalMedia,
            "MediaStream": MediaStream,
            "RecordStream": RecordStream,
            "filters": filters,
        }
        self.config.session_dir.mkdir(parents=True, exist_ok=True)
        client_kwargs: dict[str, Any] = {
            "api_id": self.telegram_config.api_id,
            "api_hash": self.telegram_config.api_hash,
            "workdir": str(self.config.session_dir),
        }
        if self.telegram_config.bot_token:
            client_kwargs["bot_token"] = self.telegram_config.bot_token
        else:
            client_kwargs["phone_number"] = self.telegram_config.phone
        self._pyrogram = Client("yaaia-calls", **client_kwargs)
        self._call_py = PyTgCalls(self._pyrogram)

        @self._call_py.on_update(filters.chat_update(ChatUpdate.Status.INCOMING_CALL))
        async def incoming_handler(_: Any, update: Any) -> None:
            await self._handle_incoming_call(update.chat_id)

        @self._call_py.on_update(filters.chat_update(ChatUpdate.Status.LEFT_CALL))
        async def left_handler(_: Any, update: Any) -> None:
            await self._clear_call(update.chat_id)

        @self._call_py.on_update(filters.stream_frame(Direction.INCOMING, Device.MICROPHONE))
        async def frame_handler(_: Any, update: Any) -> None:
            await self._handle_stream_frames(update)

        await self._call_py.start()
        self.log("Telegram call service started.")

    async def _async_stop(self) -> None:
        for chat_id in list(self._calls):
            try:
                await self._hangup(chat_id)
            except Exception:
                pass
        if self._pyrogram is not None:
            await self._pyrogram.stop()
        self.log("Telegram call service stopped.")

    async def _handle_incoming_call(self, chat_id: int) -> None:
        with self._lock:
            self._pending_incoming.add(chat_id)
        self.log(f"Incoming Telegram call from telegram-{chat_id}. Use `call accept telegram-{chat_id}`.")
        if self.config.auto_accept:
            await self._begin_call(chat_id)

    async def _begin_call(self, chat_id: int) -> None:
        call_py = self._require_call_py()
        audio_parameters = self._types["AudioParameters"](self.config.sample_rate, self.config.channels)
        stream = self._types["MediaStream"](self._types["ExternalMedia"].AUDIO, audio_parameters)
        await call_py.play(chat_id, stream)
        await call_py.record(chat_id, self._types["RecordStream"](True, audio_parameters))
        with self._lock:
            state = self._calls.get(chat_id)
            if state is None:
                state = _ActiveCall(chat_id=chat_id, bus_id=f"telegram-{chat_id}")
                self._calls[chat_id] = state
            state.mode = "listening"
            self._pending_incoming.discard(chat_id)
            if self.config.send_silence and state.silence_task is None:
                state.silence_task = asyncio.create_task(self._silence_loop(chat_id))
        self.log(f"Telegram call active on telegram-{chat_id}.")

    async def _hangup(self, chat_id: int) -> None:
        call_py = self._require_call_py()
        try:
            await call_py.leave_call(chat_id)
        finally:
            await self._clear_call(chat_id)

    async def _clear_call(self, chat_id: int) -> None:
        with self._lock:
            state = self._calls.pop(chat_id, None)
            self._pending_incoming.discard(chat_id)
        if state and state.silence_task:
            state.silence_task.cancel()
        self.log(f"Telegram call cleared on telegram-{chat_id}.")

    async def _discard_pending(self, chat_id: int) -> None:
        with self._lock:
            self._pending_incoming.discard(chat_id)

    async def _silence_loop(self, chat_id: int) -> None:
        silence = b"\x00" * self._pcm_chunk_size()
        while True:
            await asyncio.sleep(0.01)
            with self._lock:
                state = self._calls.get(chat_id)
                should_send = bool(state and state.mode == "listening")
            if not state:
                return
            if not should_send:
                continue
            try:
                await self._require_call_py().send_frame(chat_id, self._types["Device"].MICROPHONE, silence)
            except Exception:
                return

    async def _send_pcm(self, chat_id: int, pcm: bytes) -> None:
        chunk_size = self._pcm_chunk_size()
        call_py = self._require_call_py()
        device = self._types["Device"].MICROPHONE
        for offset in range(0, len(pcm), chunk_size):
            chunk = pcm[offset : offset + chunk_size]
            if len(chunk) < chunk_size:
                chunk = chunk + (b"\x00" * (chunk_size - len(chunk)))
            await call_py.send_frame(chat_id, device, chunk)
            await asyncio.sleep(0.01)

    async def _handle_stream_frames(self, update: Any) -> None:
        chat_id = int(update.chat_id)
        for frame in update.frames:
            data = getattr(frame, "frame", b"")
            if data:
                self._handle_audio_frame(chat_id, data)

    def _handle_audio_frame(self, chat_id: int, data: bytes) -> None:
        now = time.monotonic()
        finalize: bytes | None = None
        with self._lock:
            state = self._calls.get(chat_id)
            if state is None or state.mode in {"speaking", "transcribing"}:
                return
            rms = _pcm16_rms(data)
            if rms >= self.config.vad_threshold:
                if not state.recording:
                    state.buffer.clear()
                    state.recording = True
                    state.utterance_started_at = now
                state.buffer.extend(data)
                state.last_voice_at = now
                return
            if not state.recording:
                return
            state.buffer.extend(data)
            duration = now - state.utterance_started_at
            silence = now - state.last_voice_at
            if silence >= self.config.silence_seconds or duration >= self.config.max_utterance_seconds:
                if duration >= self.config.min_utterance_seconds:
                    finalize = bytes(state.buffer)
                    state.mode = "transcribing"
                state.buffer.clear()
                state.recording = False
        if finalize:
            threading.Thread(
                target=self._transcribe_utterance,
                args=(chat_id, finalize),
                name=f"yaaia-call-stt-{chat_id}",
                daemon=True,
            ).start()

    def _transcribe_utterance(self, chat_id: int, pcm: bytes) -> None:
        try:
            wav_path = self.voice.pcm_to_wav(pcm, prefix=f"telegram-{chat_id}")
            text = self.voice.transcribe_file(wav_path).strip()
            if text:
                self.emit(
                    MessageEvent(
                        source="telegram-call",
                        bus_id=f"telegram-{chat_id}",
                        sender="call",
                        text=f"[Call transcript] {text}",
                        timestamp=utc_now(),
                        outbound=False,
                        meta={"audio_path": str(wav_path)},
                    )
                )
        except Exception as exc:  # noqa: BLE001
            self.log(f"Telegram call STT failed on telegram-{chat_id}: {exc}")
        finally:
            with self._lock:
                state = self._calls.get(chat_id)
                if state:
                    state.mode = "listening"

    def _run(self, coroutine: Any, *, timeout: float) -> Any:
        loop = self._loop
        if not loop:
            raise RuntimeError("Telegram call service is not running.")
        future = asyncio.run_coroutine_threadsafe(coroutine, loop)
        try:
            return future.result(timeout=timeout)
        except FutureTimeoutError as exc:
            future.cancel()
            raise RuntimeError("Telegram call operation timed out.") from exc

    def _target_chat_id(self, bus_or_chat_id: str | None) -> int:
        if bus_or_chat_id:
            return parse_telegram_chat_id(bus_or_chat_id)
        with self._lock:
            if len(self._calls) == 1:
                return next(iter(self._calls))
            if len(self._pending_incoming) == 1:
                return next(iter(self._pending_incoming))
        raise ValueError("Specify a Telegram bus/chat id.")

    def _require_call_py(self) -> Any:
        if self._call_py is None:
            raise RuntimeError("Telegram call service is not running.")
        return self._call_py

    def _pcm_chunk_size(self) -> int:
        return max(1, self.config.sample_rate // 100) * self.config.channels * 2


def parse_telegram_chat_id(bus_or_chat_id: str) -> int:
    value = str(bus_or_chat_id).strip()
    if value.startswith("telegram-"):
        value = value.removeprefix("telegram-")
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError("Expected telegram-<chat_id> or numeric chat id.") from exc


def _pcm16_rms(data: bytes) -> float:
    if len(data) < 2:
        return 0.0
    usable = data[: len(data) - (len(data) % 2)]
    samples = array("h")
    samples.frombytes(usable)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        return 0.0
    total = 0
    for sample in samples:
        total += sample * sample
    return (total / len(samples)) ** 0.5
