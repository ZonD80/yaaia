from __future__ import annotations

from .config import AppConfig
from .services.addressbook import AddressBookStore
from .services.agent import AgentService
from .services.google_workspace import GoogleWorkspaceService
from .services.secrets import SecretsStore
from .services.telegram_chat import TelegramChatService
from .services.telegram_calls import TelegramVoiceCallService
from .services.voice import MlxAudioService
from .setup import load_env_file, maybe_run_setup
from .storage import MessageStore
from .tui import ConsoleTUI


def run() -> int:
    load_env_file()
    maybe_run_setup()
    load_env_file()
    config = AppConfig.from_env()
    store = MessageStore(config.database_path)
    addressbook = AddressBookStore(config.database_path, config.home)
    secrets = SecretsStore(config.home)
    tui = ConsoleTUI(config, store, addressbook, secrets)
    telegram = TelegramChatService(config.telegram, tui.emit, tui.log)
    google = GoogleWorkspaceService(config.google, store, tui.emit, tui.log)
    voice = MlxAudioService(config.voice, tui.log)
    calls = TelegramVoiceCallService(config.telegram, config.voice, voice, tui.emit, tui.log)
    agent = AgentService(
        config.home,
        store,
        tui.deliver_agent_message,
        tui.log,
        tui.handle_script_event,
        addressbook,
        secrets,
    )
    tui.attach_services(telegram, google, agent, calls)

    try:
        agent.ensure_configured_interactive()
        tui.show_startup()
        telegram.start()
        google.start()
        if config.voice.enabled:
            try:
                calls.start()
            except Exception as exc:  # noqa: BLE001 - voice is optional
                tui.log(f"Telegram calls not started: {exc}")
        tui.prompt_startup_command()
        tui.run()
    finally:
        calls.stop()
        telegram.stop()
        google.stop()
        addressbook.close()
        store.close()
    return 0
