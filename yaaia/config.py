from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _expand_path(value: str | None, default: Path) -> Path:
    if not value:
        return default
    return Path(value).expanduser()


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True, slots=True)
class TelegramConfig:
    enabled: bool
    api_id: int | None
    api_hash: str | None
    phone: str | None
    bot_token: str | None
    database_encryption_key: str
    files_directory: Path
    tdlib_library_path: Path | None


@dataclass(frozen=True, slots=True)
class GoogleConfig:
    enabled: bool
    credentials_path: Path
    token_path: Path
    poll_seconds: int
    gmail_enabled: bool
    calendar_enabled: bool


@dataclass(frozen=True, slots=True)
class VoiceConfig:
    enabled: bool
    session_dir: Path
    call_timeout_seconds: int
    auto_accept: bool
    text_fallback: bool
    send_silence: bool
    sample_rate: int
    channels: int
    vad_threshold: int
    silence_seconds: float
    min_utterance_seconds: float
    max_utterance_seconds: float
    tts_model: str
    tts_voice: str
    tts_language: str
    stt_model: str
    command_timeout_seconds: int
    data_dir: Path


@dataclass(frozen=True, slots=True)
class AppConfig:
    home: Path
    database_path: Path
    startup_history_limit: int
    telegram: TelegramConfig
    google: GoogleConfig
    voice: VoiceConfig

    @classmethod
    def from_env(cls) -> "AppConfig":
        home = _expand_path(os.getenv("YAAIA_HOME"), Path.home() / "yaaia")
        data_dir = home / "data"
        api_id_raw = os.getenv("YAAIA_TELEGRAM_API_ID", "").strip()
        api_id = int(api_id_raw) if api_id_raw.isdigit() else None
        api_hash = os.getenv("YAAIA_TELEGRAM_API_HASH", "").strip() or None
        phone = os.getenv("YAAIA_TELEGRAM_PHONE", "").strip() or None
        bot_token = os.getenv("YAAIA_TELEGRAM_BOT_TOKEN", "").strip() or None
        telegram_auto_enabled = bool(api_id and api_hash and (phone or bot_token))
        tdlib_library_raw = os.getenv("YAAIA_TDLIB_LIBRARY_PATH")
        tdlib_default = home / "tdlib" / "libtdjson.dylib"
        tdlib_library_path = (
            _expand_path(tdlib_library_raw, Path())
            if tdlib_library_raw
            else tdlib_default
            if tdlib_default.exists()
            else None
        )

        credentials_path = _expand_path(
            os.getenv("YAAIA_GOOGLE_CREDENTIALS"),
            home / "google" / "credentials.json",
        )
        token_path = _expand_path(
            os.getenv("YAAIA_GOOGLE_TOKEN"),
            home / "google" / "token.json",
        )
        google_auto_enabled = credentials_path.exists() or token_path.exists()

        return cls(
            home=home,
            database_path=_expand_path(os.getenv("YAAIA_DB"), data_dir / "messages.sqlite3"),
            startup_history_limit=_int_env("YAAIA_STARTUP_HISTORY_LIMIT", 30),
            telegram=TelegramConfig(
                enabled=_bool_env("YAAIA_TELEGRAM_ENABLED", telegram_auto_enabled),
                api_id=api_id,
                api_hash=api_hash,
                phone=phone,
                bot_token=bot_token,
                database_encryption_key=os.getenv(
                    "YAAIA_TELEGRAM_DATABASE_KEY",
                    "yaaia-local-tdlib-key",
                ),
                files_directory=_expand_path(
                    os.getenv("YAAIA_TELEGRAM_FILES_DIR"),
                    home / "telegram" / "tdlib",
                ),
                tdlib_library_path=tdlib_library_path,
            ),
            google=GoogleConfig(
                enabled=_bool_env("YAAIA_GOOGLE_ENABLED", google_auto_enabled),
                credentials_path=credentials_path,
                token_path=token_path,
                poll_seconds=_int_env("YAAIA_GOOGLE_POLL_SECONDS", 300),
                gmail_enabled=_bool_env("YAAIA_GMAIL_ENABLED", True),
                calendar_enabled=_bool_env("YAAIA_CALENDAR_ENABLED", True),
            ),
            voice=VoiceConfig(
                enabled=_bool_env("YAAIA_CALLS_ENABLED", False),
                session_dir=_expand_path(os.getenv("YAAIA_CALLS_SESSION_DIR"), home / "telegram" / "calls"),
                call_timeout_seconds=_int_env("YAAIA_CALLS_TIMEOUT_SECONDS", 60),
                auto_accept=_bool_env("YAAIA_CALLS_AUTO_ACCEPT", False),
                text_fallback=_bool_env("YAAIA_CALLS_TEXT_FALLBACK", True),
                send_silence=_bool_env("YAAIA_CALLS_SEND_SILENCE", True),
                sample_rate=_int_env("YAAIA_CALLS_SAMPLE_RATE", 48000),
                channels=_int_env("YAAIA_CALLS_CHANNELS", 2),
                vad_threshold=_int_env("YAAIA_CALLS_VAD_THRESHOLD", 450),
                silence_seconds=_float_env("YAAIA_CALLS_SILENCE_SECONDS", 1.2),
                min_utterance_seconds=_float_env("YAAIA_CALLS_MIN_UTTERANCE_SECONDS", 0.45),
                max_utterance_seconds=_float_env("YAAIA_CALLS_MAX_UTTERANCE_SECONDS", 20.0),
                tts_model=os.getenv(
                    "YAAIA_MLX_TTS_MODEL",
                    "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
                ),
                tts_voice=os.getenv("YAAIA_MLX_TTS_VOICE", "Chelsie"),
                tts_language=os.getenv("YAAIA_MLX_TTS_LANGUAGE", "English"),
                stt_model=os.getenv("YAAIA_MLX_STT_MODEL", "mlx-community/whisper-large-v3-turbo-asr-fp16"),
                command_timeout_seconds=_int_env("YAAIA_MLX_COMMAND_TIMEOUT_SECONDS", 300),
                data_dir=_expand_path(os.getenv("YAAIA_VOICE_DATA_DIR"), home / "voice"),
            ),
        )
