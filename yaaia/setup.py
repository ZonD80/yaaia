from __future__ import annotations

import argparse
import json
import os
import platform
import re
import sys
import getpass
from dataclasses import dataclass
from pathlib import Path

from .tdlib import format_tdlib_version, is_tdlib_too_old_for_login, tdlib_version_from_library

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = PROJECT_ROOT / ".env"
ENV_EXAMPLE_PATH = PROJECT_ROOT / ".env.example"
SECRETS_PATH = PROJECT_ROOT / "secrets.txt"

GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
DEFAULT_HOME = "~/yaaia"
DEFAULT_GOOGLE_CREDENTIALS = "~/yaaia/google/credentials.json"
DEFAULT_GOOGLE_TOKEN = "~/yaaia/google/token.json"
DEFAULT_TDLIB_CANDIDATES = [
    "~/yaaia/tdlib/libtdjson.dylib",
    "/opt/homebrew/lib/libtdjson.dylib",
    "/usr/local/lib/libtdjson.dylib",
]


@dataclass(slots=True)
class DiscoveredCredentials:
    telegram_api_id: str | None = None
    telegram_api_hash: str | None = None
    google_client_id: str | None = None
    google_client_secret: str | None = None

    @property
    def has_any(self) -> bool:
        return any(
            [
                self.telegram_api_id,
                self.telegram_api_hash,
                self.google_client_id,
                self.google_client_secret,
            ]
        )


def load_env_file(path: Path = ENV_PATH, *, override: bool = False) -> dict[str, str]:
    values = parse_env_file(path)
    for key, value in values.items():
        if override or key not in os.environ:
            os.environ[key] = value
    return values


def parse_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        values[key] = value
    return values


def discover_credentials() -> DiscoveredCredentials:
    discovered = DiscoveredCredentials()
    if not SECRETS_PATH.exists():
        return discovered
    text = SECRETS_PATH.read_text(encoding="utf-8", errors="ignore")
    discovered.telegram_api_id = _first_match(text, r"telegram\s+app\s+id\s+([0-9]+)")
    discovered.telegram_api_hash = _first_match(text, r"telegram\s+app\s+api\s+hash\s+([0-9a-fA-F]+)")
    discovered.google_client_id = _first_match(text, r"Google\s+OAUTH:\s*(\S+)")
    discovered.google_client_secret = _first_match(text, r"SECRET:\s*(\S+)")
    return discovered


def maybe_run_setup() -> None:
    if _bool_env("YAAIA_SKIP_SETUP", False) or not sys.stdin.isatty() or not sys.stdout.isatty():
        return
    env = current_env()
    missing = missing_setup_items(env)
    if not missing:
        return
    print("YAAIA setup is incomplete:")
    for item in missing:
        print(f"  - {item}")
    if not _confirm("Run setup now?", default=True):
        return
    run_interactive_setup()


def run_setup_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Configure local YAAIA credentials.")
    parser.add_argument("--from-secrets", action="store_true", help="Import available values from local secrets.txt without prompting.")
    parser.add_argument("--no-google-auth", action="store_true", help="Do not offer Google OAuth after setup.")
    args = parser.parse_args(argv)

    if args.from_secrets:
        updates = import_from_discovered_credentials()
        if updates:
            print("Imported available credentials into local config.")
        else:
            print("No importable credentials found.")
        return 0

    run_interactive_setup(offer_google_auth=not args.no_google_auth)
    return 0


def run_interactive_setup(*, offer_google_auth: bool = True) -> None:
    existing = current_env()
    discovered = discover_credentials()
    updates: dict[str, str] = {}

    home = _prompt("YAAIA home directory", existing.get("YAAIA_HOME") or DEFAULT_HOME)
    updates["YAAIA_HOME"] = home

    print("\nTelegram text chat")
    tg_api_id = existing.get("YAAIA_TELEGRAM_API_ID") or discovered.telegram_api_id
    tg_api_hash = existing.get("YAAIA_TELEGRAM_API_HASH") or discovered.telegram_api_hash
    if not tg_api_id:
        tg_api_id = _prompt("Telegram API ID", "")
    if not tg_api_hash:
        tg_api_hash = _prompt("Telegram API hash", "")
    if tg_api_id:
        updates["YAAIA_TELEGRAM_API_ID"] = tg_api_id
    if tg_api_hash:
        updates["YAAIA_TELEGRAM_API_HASH"] = tg_api_hash

    phone = existing.get("YAAIA_TELEGRAM_PHONE", "")
    bot_token = existing.get("YAAIA_TELEGRAM_BOT_TOKEN", "")
    if not phone and not bot_token:
        login_kind = _prompt("Telegram login mode: phone, bot, or skip", "phone").strip().lower()
        if login_kind == "bot":
            bot_token = _prompt("Telegram bot token", "")
        elif login_kind != "skip":
            phone = _prompt("Telegram phone number", "")
    updates["YAAIA_TELEGRAM_PHONE"] = phone
    updates["YAAIA_TELEGRAM_BOT_TOKEN"] = bot_token

    existing_tdlib_path = existing.get("YAAIA_TDLIB_LIBRARY_PATH")
    tdlib_path = existing_tdlib_path if tdlib_path_is_usable(existing_tdlib_path) else find_tdlib_library()
    if tdlib_path:
        updates["YAAIA_TDLIB_LIBRARY_PATH"] = tdlib_path
    elif needs_external_tdlib():
        print(
            "Apple Silicon detected and no current arm64 TDLib was found. "
            "Run `./scripts/install-tdlib.sh`, then rerun setup."
        )

    print("\nGoogle Workspace")
    credentials_path = existing.get("YAAIA_GOOGLE_CREDENTIALS") or DEFAULT_GOOGLE_CREDENTIALS
    token_path = existing.get("YAAIA_GOOGLE_TOKEN") or DEFAULT_GOOGLE_TOKEN
    updates["YAAIA_GOOGLE_CREDENTIALS"] = credentials_path
    updates["YAAIA_GOOGLE_TOKEN"] = token_path
    updates["YAAIA_GOOGLE_POLL_SECONDS"] = existing.get("YAAIA_GOOGLE_POLL_SECONDS") or "300"

    client_id = existing.get("YAAIA_GOOGLE_CLIENT_ID") or discovered.google_client_id
    client_secret = existing.get("YAAIA_GOOGLE_CLIENT_SECRET") or discovered.google_client_secret
    credentials_file = Path(credentials_path).expanduser()
    if not credentials_file.exists():
        if not client_id:
            client_id = _prompt("Google OAuth client ID", "")
        if not client_secret:
            client_secret = _prompt("Google OAuth client secret", "")
        if client_id and client_secret:
            write_google_credentials_file(credentials_file, client_id, client_secret)
            updates["YAAIA_GOOGLE_CLIENT_ID"] = client_id
            updates["YAAIA_GOOGLE_CLIENT_SECRET"] = client_secret
            print(f"Wrote Google OAuth credentials to {credentials_file}.")

    write_env_updates(updates)
    for key, value in updates.items():
        os.environ[key] = value

    migrated = migrate_legacy_google_token(
        token_path=Path(token_path).expanduser(),
        client_id=client_id,
        client_secret=client_secret,
    )
    if migrated:
        print("Migrated legacy Google OAuth token.")

    if offer_google_auth and client_id and client_secret and not Path(token_path).expanduser().exists():
        if _confirm("Authorize Google now?", default=False):
            from .services.google_workspace import GoogleWorkspaceService
            from .storage import MessageStore
            from .config import AppConfig

            config = AppConfig.from_env()
            store = MessageStore(config.database_path)
            try:
                service = GoogleWorkspaceService(config.google, store, lambda _event: None, print)
                service.authorize()
            finally:
                store.close()

    print("\nAI provider")
    from .services.agent import load_agent_config, save_agent_config

    agent_config = load_agent_config(Path(home).expanduser())
    provider = _prompt("AI provider: openrouter, claude, or codex", agent_config.provider).strip().lower()
    if provider in {"openrouter", "claude", "codex"}:
        agent_config.provider = provider
    if agent_config.provider == "openrouter":
        if not agent_config.openrouter_api_key:
            key = getpass.getpass("OpenRouter API key: ").strip()
            if key:
                agent_config.openrouter_api_key = key
        model = _prompt("OpenRouter model", agent_config.openrouter_model)
        if model:
            agent_config.openrouter_model = model
    elif agent_config.provider == "claude":
        if not agent_config.claude_api_key:
            key = getpass.getpass("Claude API key: ").strip()
            if key:
                agent_config.claude_api_key = key
        model = _prompt("Claude model", agent_config.claude_model)
        if model:
            agent_config.claude_model = model
    else:
        model = _prompt("Codex model", agent_config.codex_model)
        if model:
            agent_config.codex_model = model
        if not (Path(home).expanduser() / "codex-auth.json").exists():
            print("Codex auth not found at ~/yaaia/codex-auth.json. Restore it or use OpenRouter/Claude.")
    save_agent_config(Path(home).expanduser(), agent_config)

    print("Setup complete. Start with ./launch.sh.")


def import_from_discovered_credentials() -> dict[str, str]:
    existing = current_env()
    discovered = discover_credentials()
    if not discovered.has_any:
        return {}
    updates: dict[str, str] = {}

    if discovered.telegram_api_id and not existing.get("YAAIA_TELEGRAM_API_ID"):
        updates["YAAIA_TELEGRAM_API_ID"] = discovered.telegram_api_id
    if discovered.telegram_api_hash and not existing.get("YAAIA_TELEGRAM_API_HASH"):
        updates["YAAIA_TELEGRAM_API_HASH"] = discovered.telegram_api_hash
    existing_tdlib_path = existing.get("YAAIA_TDLIB_LIBRARY_PATH")
    tdlib_path = existing_tdlib_path if tdlib_path_is_usable(existing_tdlib_path) else find_tdlib_library()
    if tdlib_path and tdlib_path != existing_tdlib_path:
        updates["YAAIA_TDLIB_LIBRARY_PATH"] = tdlib_path

    credentials_path = existing.get("YAAIA_GOOGLE_CREDENTIALS") or DEFAULT_GOOGLE_CREDENTIALS
    token_path = existing.get("YAAIA_GOOGLE_TOKEN") or DEFAULT_GOOGLE_TOKEN
    updates.setdefault("YAAIA_HOME", existing.get("YAAIA_HOME") or DEFAULT_HOME)
    updates.setdefault("YAAIA_GOOGLE_CREDENTIALS", credentials_path)
    updates.setdefault("YAAIA_GOOGLE_TOKEN", token_path)
    updates.setdefault("YAAIA_GOOGLE_POLL_SECONDS", existing.get("YAAIA_GOOGLE_POLL_SECONDS") or "300")

    if discovered.google_client_id and not existing.get("YAAIA_GOOGLE_CLIENT_ID"):
        updates["YAAIA_GOOGLE_CLIENT_ID"] = discovered.google_client_id
    if discovered.google_client_secret and not existing.get("YAAIA_GOOGLE_CLIENT_SECRET"):
        updates["YAAIA_GOOGLE_CLIENT_SECRET"] = discovered.google_client_secret

    if discovered.google_client_id and discovered.google_client_secret:
        credentials_file = Path(credentials_path).expanduser()
        if not credentials_file.exists():
            write_google_credentials_file(
                credentials_file,
                discovered.google_client_id,
                discovered.google_client_secret,
            )
        migrate_legacy_google_token(
            token_path=Path(token_path).expanduser(),
            client_id=discovered.google_client_id,
            client_secret=discovered.google_client_secret,
        )

    write_env_updates(updates)
    for key, value in updates.items():
        os.environ[key] = value
    return updates


def current_env() -> dict[str, str]:
    env = parse_env_file(ENV_PATH)
    merged = dict(env)
    for key, value in os.environ.items():
        if key.startswith("YAAIA_") and value:
            merged[key] = value
    return merged


def missing_setup_items(env: dict[str, str]) -> list[str]:
    missing: list[str] = []
    telegram_disabled = _env_bool_value(env.get("YAAIA_TELEGRAM_ENABLED")) is False
    if not telegram_disabled:
        if not env.get("YAAIA_TELEGRAM_API_ID") or not env.get("YAAIA_TELEGRAM_API_HASH"):
            missing.append("Telegram API credentials")
        if not env.get("YAAIA_TELEGRAM_PHONE") and not env.get("YAAIA_TELEGRAM_BOT_TOKEN"):
            missing.append("Telegram phone or bot token")
        tdlib_path = env.get("YAAIA_TDLIB_LIBRARY_PATH") or find_tdlib_library()
        if needs_external_tdlib() and not tdlib_path_is_usable(tdlib_path):
            missing.append("current arm64 Telegram TDLib library")

    google_disabled = _env_bool_value(env.get("YAAIA_GOOGLE_ENABLED")) is False
    if not google_disabled:
        credentials_path = Path(env.get("YAAIA_GOOGLE_CREDENTIALS") or DEFAULT_GOOGLE_CREDENTIALS).expanduser()
        token_path = Path(env.get("YAAIA_GOOGLE_TOKEN") or DEFAULT_GOOGLE_TOKEN).expanduser()
        if not credentials_path.exists() and not (
            env.get("YAAIA_GOOGLE_CLIENT_ID") and env.get("YAAIA_GOOGLE_CLIENT_SECRET")
        ):
            missing.append("Google OAuth client credentials")
        if not token_path.exists():
            missing.append("Google OAuth token")
    try:
        from .services.agent import load_agent_config

        home_path = Path(env.get("YAAIA_HOME") or DEFAULT_HOME).expanduser()
        agent_config = load_agent_config(home_path)
        if agent_config.provider == "codex":
            if not (home_path / "codex-auth.json").exists():
                missing.append("Codex auth token")
        elif not agent_config.ready:
            missing.append(f"{agent_config.provider} API key")
    except Exception:
        missing.append("AI provider configuration")
    return missing


def needs_external_tdlib() -> bool:
    return platform.system() == "Darwin" and platform.machine() in {"arm64", "arm64e"}


def find_tdlib_library() -> str:
    for raw_path in DEFAULT_TDLIB_CANDIDATES:
        path = Path(raw_path).expanduser()
        if path.exists() and tdlib_path_is_usable(str(path)):
            return str(path)
    return ""


def tdlib_path_is_usable(raw_path: str | None) -> bool:
    if not raw_path:
        return False
    path = Path(raw_path).expanduser()
    if not path.exists():
        return False
    version = tdlib_version_from_library(path)
    return not is_tdlib_too_old_for_login(version)


def tdlib_status(raw_path: str | None) -> str:
    if not raw_path:
        return "missing"
    path = Path(raw_path).expanduser()
    if not path.exists():
        return "missing"
    version = tdlib_version_from_library(path)
    if is_tdlib_too_old_for_login(version):
        return f"too old ({format_tdlib_version(version)})"
    return f"ok ({format_tdlib_version(version)})"


def write_env_updates(updates: dict[str, str]) -> None:
    if not updates:
        return
    source_lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else _default_env_lines()
    remaining = dict(updates)
    output: list[str] = []
    key_re = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=")
    for line in source_lines:
        match = key_re.match(line)
        if not match:
            output.append(line)
            continue
        key = match.group(1)
        if key in remaining:
            output.append(f"{key}={remaining.pop(key)}")
        else:
            output.append(line)
    if remaining:
        if output and output[-1].strip():
            output.append("")
        for key, value in remaining.items():
            output.append(f"{key}={value}")
    ENV_PATH.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")


def write_google_credentials_file(path: Path, client_id: str, client_secret: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "installed": {
            "client_id": client_id,
            "project_id": "yaaia-local",
            "auth_uri": GOOGLE_AUTH_URI,
            "token_uri": GOOGLE_TOKEN_URI,
            "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
            "client_secret": client_secret,
            "redirect_uris": ["http://localhost"],
        }
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def migrate_legacy_google_token(*, token_path: Path, client_id: str | None, client_secret: str | None) -> bool:
    if token_path.exists() or not client_id or not client_secret:
        return False
    legacy_path = Path(os.getenv("YAAIA_LEGACY_GOOGLE_TOKEN", "~/yaaia/google-api-auth.json")).expanduser()
    if not legacy_path.exists():
        return False
    try:
        legacy = json.loads(legacy_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return False
    token = legacy.get("token") or legacy.get("access_token")
    refresh_token = legacy.get("refresh_token")
    if not token and not refresh_token:
        return False
    from .services.google_workspace import SCOPES

    payload = {
        "token": token,
        "refresh_token": refresh_token,
        "token_uri": GOOGLE_TOKEN_URI,
        "client_id": client_id,
        "client_secret": client_secret,
        "scopes": SCOPES,
    }
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return True


def _default_env_lines() -> list[str]:
    if ENV_EXAMPLE_PATH.exists():
        return ENV_EXAMPLE_PATH.read_text(encoding="utf-8").splitlines()
    return []


def _first_match(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, flags=re.IGNORECASE)
    return match.group(1).strip() if match else None


def _prompt(label: str, default: str) -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{label}{suffix}: ").strip()
    return value or default


def _confirm(label: str, *, default: bool) -> bool:
    default_text = "Y/n" if default else "y/N"
    value = input(f"{label} [{default_text}]: ").strip().lower()
    if not value:
        return default
    return value in {"y", "yes"}


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    parsed = _env_bool_value(value)
    return default if parsed is None else parsed


def _env_bool_value(value: str | None) -> bool | None:
    if value is None or value == "":
        return None
    lowered = value.strip().lower()
    if lowered in {"0", "false", "no", "off"}:
        return False
    if lowered in {"1", "true", "yes", "on"}:
        return True
    return None
