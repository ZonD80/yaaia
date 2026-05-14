from __future__ import annotations

import re
import shlex
import sys
import threading
import time
from dataclasses import dataclass
from datetime import timezone
from pathlib import Path
from typing import Any, Callable

from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax
from rich.table import Table
from rich.text import Text

from .config import AppConfig
from .events import MessageEvent
from .schedules import consume_due_schedules, get_startup_command, set_startup_command
from .services.addressbook import AddressBookStore
from .services.agent import AgentService
from .services.google_workspace import GoogleWorkspaceService
from .services.secrets import SecretsStore
from .services.telegram_chat import TelegramChatService
from .services.telegram_calls import TelegramVoiceCallService
from .storage import ROOT_BUS_ID, MessageStore


@dataclass(frozen=True, slots=True)
class EmailPayload:
    to: str = ""
    subject: str = ""
    body: str = ""
    cc: str = ""
    bcc: str = ""
    html_body: str = ""
    attachments: tuple[Path, ...] = ()


class ConsoleTUI:
    def __init__(
        self,
        config: AppConfig,
        store: MessageStore,
        addressbook: AddressBookStore,
        secrets: SecretsStore,
    ) -> None:
        self.config = config
        self.store = store
        self.addressbook = addressbook
        self.secrets = secrets
        self.console = Console()
        self._lock = threading.RLock()
        self._agent_lock = threading.RLock()
        self._agent_queue_lock = threading.RLock()
        self._agent_pending: list[MessageEvent] = []
        self._agent_worker_active = False
        self.telegram: TelegramChatService | None = None
        self.google: GoogleWorkspaceService | None = None
        self.agent: AgentService | None = None
        self.calls: TelegramVoiceCallService | None = None

    def attach_services(
        self,
        telegram: TelegramChatService,
        google: GoogleWorkspaceService,
        agent: AgentService,
        calls: TelegramVoiceCallService,
    ) -> None:
        self.telegram = telegram
        self.google = google
        self.agent = agent
        self.calls = calls

    def show_startup(self) -> None:
        self._print_banner()
        self._print_startup_history()
        self.console.print("Type [bold]help[/bold] for commands. Any other input is appended to the root bus.")

    def prompt_startup_command(self) -> None:
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            return
        command = get_startup_command(self.config.home)
        due_text = f"\nDue scheduled tasks: {len(command.due_schedules)}" if command.due_schedules else ""
        self.console.print(
            Panel.fit(
                f"[bold]Startup command[/bold]\nTitle: {command.title}{due_text}\n\n{command.instructions}",
                border_style="yellow",
            )
        )
        answer = self.console.input("[bold yellow]Execute startup command now?[/bold yellow] [Y/n] ").strip().lower()
        if answer in {"n", "no", "skip"}:
            self.log("Startup command skipped.")
            return
        if command.due_schedules:
            consume_due_schedules(self.config.home)
        event = self._append_root_message(command.text, sender="startup")
        self.log("Startup command appended to root bus.")
        self._respond_with_agent(event)

    def emit(self, event: MessageEvent) -> None:
        if self._event_targets_forgotten_bus(event):
            return
        inserted = self.store.append(event)
        if inserted:
            self.print_event(event)
            self._mirror_to_root(event)

    def log(self, message: str) -> None:
        self.emit(MessageEvent(source="system", bus_id="system", sender="yaaia", text=message))

    def run(self) -> None:
        while True:
            try:
                line = self.console.input("[bold cyan]root[/bold cyan]> ")
            except (EOFError, KeyboardInterrupt):
                self.console.print()
                return
            if not line.strip():
                continue
            try:
                keep_running = self._handle_command(line.strip())
            except Exception as exc:  # noqa: BLE001 - command loop should keep running
                self.console.print(f"[red]Error:[/red] {exc}")
                keep_running = True
            if not keep_running:
                return

    def print_event(self, event: MessageEvent) -> None:
        timestamp = event.timestamp.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        direction = ">" if event.outbound else "<"
        source_style = {
            "telegram": "bright_blue",
            "gmail": "green",
            "calendar": "magenta",
            "system": "dim",
            "root": "cyan",
            "telegram-call": "bright_magenta",
            "call": "bright_magenta",
        }.get(event.source, "white")
        line = Text()
        line.append(f"{timestamp} ", style="dim")
        line.append(f"{event.source}", style=source_style)
        line.append(f" {direction} ")
        line.append(f"{event.bus_id} ", style="dim")
        line.append(f"{event.sender}: ", style="bold")
        line.append(event.text)
        with self._lock:
            self.console.print(line)

    def _handle_command(self, line: str) -> bool:
        command_mode = line.startswith("/")
        if command_mode:
            line = line[1:].strip()
        if line in {"quit", "exit", "q"}:
            return False
        if line == "help":
            self._print_help()
            return True
        if line == "status":
            self._print_status()
            return True
        if line == "agent status":
            self._print_agent_status()
            return True
        if line == "agent setup":
            if not self.agent:
                raise RuntimeError("Agent service not configured.")
            self.agent.configure_interactive()
            self.console.print("[green]Agent configuration saved.[/green]")
            return True
        if line == "agent reset":
            if self.agent:
                self.agent.clear_session()
            self.console.print("[green]Agent session reset.[/green]")
            return True
        if line in {"call status", "calls status", "voice status"}:
            self._print_call_status()
            return True
        if line in {"calls start", "call service start", "voice start"}:
            if not self.calls:
                raise RuntimeError("Call service not configured.")
            self.calls.start()
            self.console.print("[green]Telegram call service started.[/green]")
            return True
        if line.startswith(("call start ", "call accept ", "call pickup ", "call hangup ", "call reject ")):
            self._handle_call_command(line)
            return True
        if line == "call hangup":
            if not self.calls:
                raise RuntimeError("Call service not configured.")
            self.console.print(self.calls.hangup())
            return True
        if line.startswith("call say "):
            self._handle_call_say(line)
            return True
        if line.startswith("voice tts "):
            if not self.calls:
                raise RuntimeError("Call service not configured.")
            path = self.calls.preview_tts(line.removeprefix("voice tts ").strip())
            self.console.print(f"[green]TTS written:[/green] {path}")
            return True
        if line.startswith("voice stt "):
            if not self.calls:
                raise RuntimeError("Call service not configured.")
            text = self.calls.transcribe_file(Path(line.removeprefix("voice stt ").strip()).expanduser())
            self.console.print(text or "[yellow]No transcription.[/yellow]", markup=False)
            return True
        if line in {"clear chat", "chat clear", "clear root", "wipe root"}:
            self._clear_chat()
            return True
        if line in {"contacts", "contacts list", "addressbook", "addressbook list"}:
            self._print_contacts(self.addressbook.list())
            return True
        if line.startswith(("contacts search ", "addressbook search ")):
            query = line.split(" ", 2)[2]
            self._print_contacts(self.addressbook.search(query))
            return True
        if line.startswith(("contact get ", "addressbook get ")):
            key = line.split(" ", 2)[2]
            self._print_contact(key)
            return True
        if line.startswith(("contact add ", "addressbook add ")):
            self._add_contact(line.split(" ", 2)[2])
            return True
        if line.startswith(("contact update ", "addressbook update ")):
            self._update_contact(line.split(" ", 2)[2])
            return True
        if line.startswith(("contact delete ", "addressbook delete ")):
            key = line.split(" ", 2)[2]
            deleted = self.addressbook.delete(key)
            self.console.print("[green]Contact deleted.[/green]" if deleted else "[yellow]Contact not found.[/yellow]")
            return True
        if line in {"secrets", "secrets list", "passwords", "passwords list"}:
            self._print_secrets()
            return True
        if line.startswith(("secret get ", "password get ")):
            self._print_secret(line.split(" ", 2)[2])
            return True
        if line.startswith(("secret set ", "password set ")):
            self._set_secret(line.split(" ", 2)[2])
            return True
        if line.startswith(("secret delete ", "password delete ")):
            key = line.split(" ", 2)[2]
            deleted = self.secrets.delete(key)
            self.console.print("[green]Secret deleted.[/green]" if deleted else "[yellow]Secret not found.[/yellow]")
            return True
        if line in {"buses", "bus list"}:
            self._print_buses()
            return True
        if line == "connected buses":
            self._print_buses(connected_only=True)
            return True
        if line in {"forgotten buses", "buses forgotten"}:
            self._print_forgotten_buses()
            return True
        if line.startswith(("forget bus ", "bus forget ")):
            self._forget_bus(_bus_arg(line))
            return True
        if line.startswith(("restore bus ", "bus restore ", "unforget bus ")):
            self._restore_bus(_bus_arg(line))
            return True
        if line == "startup":
            self._print_startup_command()
            return True
        if line == "startup run":
            command = get_startup_command(self.config.home)
            if command.due_schedules:
                consume_due_schedules(self.config.home)
            event = self._append_root_message(command.text, sender="startup")
            self._respond_with_agent(event)
            return True
        if line.startswith("startup set "):
            title, instructions = self._parse_startup_set(line)
            set_startup_command(self.config.home, title=title, instructions=instructions)
            self.console.print("[green]Startup command updated.[/green]")
            return True
        if line.startswith("history"):
            parts = shlex.split(line)
            if len(parts) > 1 and parts[1] == "all":
                limit = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 50
                self._print_history(limit, all_buses=True)
            else:
                limit = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 50
                self._print_history(limit)
            return True
        if line.startswith("telegram chats"):
            parts = shlex.split(line)
            limit = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 30
            self._print_telegram_chats(limit)
            return True
        if line.startswith("telegram send "):
            _, _, rest = line.partition("telegram send ")
            chat_id_raw, _, text = rest.partition(" ")
            if not chat_id_raw or not text:
                raise ValueError("Usage: telegram send <chat_id> <message>")
            if not self.telegram:
                raise RuntimeError("Telegram service not configured.")
            self.telegram.send_text(int(chat_id_raw), text)
            return True
        if line == "google auth":
            if not self.google:
                raise RuntimeError("Google service not configured.")
            self.google.stop()
            self.google.authorize()
            self.google.start()
            return True
        if line == "google logout":
            if not self.google:
                raise RuntimeError("Google service not configured.")
            self.google.stop()
            self.config.google.token_path.unlink(missing_ok=True)
            self.console.print("[yellow]Google token removed. Run google auth to reconnect.[/yellow]")
            return True
        if line == "google poll":
            if not self.google:
                raise RuntimeError("Google service not configured.")
            self.google.poll_once()
            return True
        if line.startswith("gmail send "):
            to, subject, body = self._parse_gmail_send(line)
            if not self.google:
                raise RuntimeError("Google service not configured.")
            message_id = self.google.send_email(to, subject, body)
            self.console.print(f"[green]Sent Gmail message[/green] {message_id}")
            return True
        if line == "clear":
            self.console.clear()
            return True
        if command_mode:
            self.console.print("[yellow]Unknown command.[/yellow] Type help.")
            return True
        event = self._append_root_message(line)
        self._respond_with_agent(event)
        return True

    def _parse_gmail_send(self, line: str) -> tuple[str, str, str]:
        payload = line.removeprefix("gmail send ").strip()
        to, sep, remainder = payload.partition(" ")
        if not sep:
            raise ValueError("Usage: gmail send <to> <subject> | <body>")
        subject, sep, body = remainder.partition("|")
        if not sep:
            raise ValueError("Usage: gmail send <to> <subject> | <body>")
        return to.strip(), subject.strip(), body.strip()

    def _handle_call_command(self, line: str) -> None:
        if not self.calls:
            raise RuntimeError("Call service not configured.")
        parts = shlex.split(line)
        if len(parts) < 3:
            raise ValueError("Usage: call <start|accept|pickup|hangup|reject> <telegram-bus|chat_id>")
        action = parts[1]
        target = parts[2]
        if action == "start":
            result = self.calls.start_call(target)
        elif action in {"accept", "pickup"}:
            result = self.calls.accept_call(target)
        elif action == "hangup":
            result = self.calls.hangup(target)
        elif action == "reject":
            result = self.calls.reject(target)
        else:
            raise ValueError("Usage: call <start|accept|pickup|hangup|reject> <telegram-bus|chat_id>")
        self.console.print(result)

    def _handle_call_say(self, line: str) -> None:
        if not self.calls:
            raise RuntimeError("Call service not configured.")
        payload = line.removeprefix("call say ").strip()
        target, sep, text = payload.partition(" ")
        if not sep or not text.strip():
            raise ValueError("Usage: call say <telegram-bus|chat_id> <text>")
        result = self.calls.say(target, text)
        self.console.print(result)

    def _parse_startup_set(self, line: str) -> tuple[str, str]:
        payload = line.removeprefix("startup set ").strip()
        title, sep, instructions = payload.partition("|")
        if not sep:
            raise ValueError("Usage: startup set <title> | <instructions>")
        return title.strip(), instructions.strip()

    def _print_banner(self) -> None:
        self.console.print(
            Panel.fit(
                "[bold]YAAIA[/bold]\nPython console client for Telegram text chat and Google Workspace.",
                border_style="cyan",
            )
        )

    def _print_startup_history(self) -> None:
        history = self.store.recent_bus(ROOT_BUS_ID, self.config.startup_history_limit)
        if not history:
            return
        self.console.print(f"[dim]Last {len(history)} root bus messages:[/dim]")
        for event in history:
            self.print_event(event)

    def _print_help(self) -> None:
        table = Table(title="Commands", show_header=True, header_style="bold cyan")
        table.add_column("Command")
        table.add_column("Description")
        table.add_row("<message>", "Append a message to the root bus.")
        table.add_row("status", "Show Telegram and Google connection state.")
        table.add_row("agent status", "Show AI provider/model configuration state.")
        table.add_row("agent setup", "Configure AI provider credentials interactively.")
        table.add_row("agent reset", "Clear in-memory agent conversation session.")
        table.add_row("clear chat", "Clear root chat history and reset the agent session.")
        table.add_row("call status", "Show Telegram call/STT/TTS state.")
        table.add_row("calls start", "Start the optional py-tgcalls media service.")
        table.add_row("call start <telegram-bus|chat_id>", "Place a Telegram audio call.")
        table.add_row("call accept <telegram-bus|chat_id>", "Accept an incoming Telegram call.")
        table.add_row("call hangup [telegram-bus|chat_id]", "Hang up an active call.")
        table.add_row("call say <telegram-bus|chat_id> <text>", "Speak text into an active call via mlx-audio TTS.")
        table.add_row("voice tts <text>", "Generate a local mlx-audio TTS file.")
        table.add_row("voice stt <path>", "Transcribe an audio file with mlx-audio STT.")
        table.add_row("contacts", "List addressbook contacts.")
        table.add_row("contacts search <query>", "Search addressbook contacts.")
        table.add_row("contact get <id|identifier>", "Show one contact.")
        table.add_row("contact add <name> | <identifier> | [trust] | [buses] | [notes]", "Create a contact.")
        table.add_row("contact update <id|identifier> field=value ...", "Update a contact.")
        table.add_row("contact delete <id|identifier>", "Delete a contact.")
        table.add_row("secrets", "List secret descriptions without values.")
        table.add_row("secret get <id|description> [raw]", "Print a secret value or generated TOTP.")
        table.add_row("secret set <description> | <string|totp> | <value> [| force]", "Create or update a secret.")
        table.add_row("secret delete <id|description>", "Delete a secret.")
        table.add_row("buses", "List root and connected/known message buses.")
        table.add_row("connected buses", "List only currently connected message buses.")
        table.add_row("forget bus <bus_id>", "Delete a bus' local history and hide future events.")
        table.add_row("restore bus <bus_id>", "Allow a forgotten bus to appear again for new events.")
        table.add_row("forgotten buses", "List hidden buses.")
        table.add_row("history [limit]", "Print root bus history.")
        table.add_row("history all [limit]", "Print stored messages from every bus.")
        table.add_row("startup", "Show configured startup command.")
        table.add_row("startup run", "Append startup command to root bus.")
        table.add_row("startup set <title> | <instructions>", "Update startup command.")
        table.add_row("telegram chats [limit]", "List Telegram chats and IDs.")
        table.add_row("telegram send <chat_id> <message>", "Send a Telegram text message.")
        table.add_row("google auth", "Run Google OAuth and save token.")
        table.add_row("google logout", "Remove the saved Google OAuth token.")
        table.add_row("google poll", "Poll Gmail and Calendar immediately.")
        table.add_row("gmail send <to> <subject> | <body>", "Send a Gmail message.")
        table.add_row("clear", "Clear the console.")
        table.add_row("quit", "Exit.")
        self.console.print(table)

    def _print_status(self) -> None:
        table = Table(title="Status", show_header=True, header_style="bold cyan")
        table.add_column("Service")
        table.add_column("State")
        telegram_state = "connected" if self.telegram and self.telegram.connected else "not connected"
        google_state = "polling" if self.google and self.google.running else "not polling"
        call_state = "running" if self.calls and self.calls.running else "not running"
        if self.calls and not self.config.voice.enabled:
            call_state = "disabled"
        if self.google and self.google.last_error:
            google_state += f" ({self.google.last_error})"
        table.add_row("Telegram", telegram_state)
        table.add_row("Telegram calls", call_state)
        table.add_row("Google", google_state)
        table.add_row("Database", str(self.config.database_path))
        self.console.print(table)

    def _print_call_status(self) -> None:
        table = Table(title="Telegram Calls", show_header=True, header_style="bold cyan")
        table.add_column("Field")
        table.add_column("Value")
        if not self.calls:
            table.add_row("configured", "no")
            self.console.print(table)
            return
        status = self.calls.status()
        table.add_row("enabled", "yes" if status["enabled"] else "no")
        table.add_row("running", "yes" if status["running"] else "no")
        table.add_row("sample_rate", str(status["sample_rate"]))
        table.add_row("channels", str(status["channels"]))
        table.add_row("tts_model", str(status["tts_model"]))
        table.add_row("stt_model", str(status["stt_model"]))
        pending = ", ".join(status["pending_incoming"]) if status["pending_incoming"] else ""
        table.add_row("pending_incoming", pending)
        calls = status["active_calls"]
        table.add_row("active_calls", ", ".join(f"{call['bus_id']} ({call['mode']})" for call in calls))
        self.console.print(table)

    def _clear_chat(self) -> None:
        if self.agent:
            self.agent.clear_session()
        with self._agent_queue_lock:
            self._agent_pending = []
        deleted = self.store.wipe_root_history()
        self.console.clear()
        self.console.print(f"[green]Chat cleared.[/green] Removed {deleted} root message(s).")

    def _print_contacts(self, contacts: list[Any]) -> None:
        table = Table(title="Addressbook", show_header=True, header_style="bold cyan")
        table.add_column("ID")
        table.add_column("Name")
        table.add_column("Identifier")
        table.add_column("Trust")
        table.add_column("Buses")
        table.add_column("Notes")
        for contact in contacts:
            table.add_row(
                contact.id,
                contact.name,
                contact.identifier,
                contact.trust_level,
                ", ".join(contact.bus_ids),
                contact.notes,
            )
        self.console.print(table)

    def _print_contact(self, key: str) -> None:
        contact = self.addressbook.get(key)
        if not contact:
            self.console.print("[yellow]Contact not found.[/yellow]")
            return
        table = Table(title="Contact", show_header=True, header_style="bold cyan")
        table.add_column("Field")
        table.add_column("Value")
        table.add_row("id", contact.id)
        table.add_row("name", contact.name)
        table.add_row("identifier", contact.identifier)
        table.add_row("trust_level", contact.trust_level)
        table.add_row("bus_ids", ", ".join(contact.bus_ids))
        table.add_row("notes", contact.notes)
        self.console.print(table)

    def _add_contact(self, payload: str) -> None:
        parts = [part.strip() for part in payload.split("|")]
        if len(parts) < 2 or not parts[0] or not parts[1]:
            raise ValueError("Usage: contact add <name> | <identifier> | [trust] | [buses] | [notes]")
        contact_id = self.addressbook.create(
            name=parts[0],
            identifier=parts[1],
            trust_level=parts[2] if len(parts) > 2 and parts[2] else "normal",
            bus_ids=_split_csv(parts[3]) if len(parts) > 3 else [],
            notes=parts[4] if len(parts) > 4 else "",
        )
        self.console.print(f"[green]Contact created.[/green] {contact_id}")

    def _update_contact(self, payload: str) -> None:
        key, _, raw_updates = payload.partition(" ")
        if not key or not raw_updates:
            raise ValueError("Usage: contact update <id|identifier> field=value ...")
        updates: dict[str, Any] = {}
        for token in shlex.split(raw_updates):
            field, sep, value = token.partition("=")
            if not sep:
                raise ValueError("Updates must be field=value pairs.")
            if field == "bus_ids":
                updates[field] = _split_csv(value)
            elif field in {"name", "identifier", "trust_level", "notes"}:
                updates[field] = value
            else:
                raise ValueError(f"Unsupported contact field: {field}")
        self.addressbook.update(key, **updates)
        self.console.print("[green]Contact updated.[/green]")

    def _print_secrets(self) -> None:
        table = Table(title="Secrets", show_header=True, header_style="bold cyan")
        table.add_column("UUID")
        table.add_column("Description")
        table.add_column("Type")
        for entry in self.secrets.list():
            table.add_row(entry["uuid"], entry["description"], entry["type"])
        self.console.print(table)

    def _print_secret(self, payload: str) -> None:
        key = payload.strip()
        raw = False
        if key.endswith(" raw"):
            raw = True
            key = key.removesuffix(" raw").strip()
        value = self.secrets.get(key, raw=raw)
        if value is None:
            self.console.print("[yellow]Secret not found.[/yellow]")
            return
        self.console.print(value, markup=False)

    def _set_secret(self, payload: str) -> None:
        parts = [part.strip() for part in payload.split("|")]
        if len(parts) < 3 or not parts[0] or not parts[1]:
            raise ValueError("Usage: secret set <description> | <string|totp> | <value> [| force]")
        force = len(parts) > 3 and parts[3].strip().lower() in {"1", "true", "yes", "force"}
        secret_id = self.secrets.set(description=parts[0], type=parts[1], value=parts[2], force=force)
        self.console.print(f"[green]Secret saved.[/green] {secret_id}")

    def _print_agent_status(self) -> None:
        table = Table(title="Agent", show_header=True, header_style="bold cyan")
        table.add_column("Field")
        table.add_column("Value")
        if not self.agent:
            table.add_row("ready", "no")
        else:
            status = self.agent.status()
            table.add_row("ready", status["ready"])
            table.add_row("provider", status["provider"])
            table.add_row("model", status["model"])
        self.console.print(table)

    def _print_history(self, limit: int, *, all_buses: bool = False) -> None:
        history = self.store.recent(limit) if all_buses else self.store.recent_bus(ROOT_BUS_ID, limit)
        for event in history:
            self.print_event(event)

    def _print_startup_command(self) -> None:
        command = get_startup_command(self.config.home)
        self.console.print(
            Panel.fit(
                f"[bold]{command.title}[/bold]\n\n{command.instructions}\n\nDue scheduled tasks: {len(command.due_schedules)}",
                title="Startup Command",
                border_style="yellow",
            )
        )

    def _print_buses(self, *, connected_only: bool = False) -> None:
        buses = self._collect_buses()
        if connected_only:
            buses = [bus for bus in buses if bus.get("state") in {"connected", "polling", "authorized"}]
        title = "Connected Message Buses" if connected_only else "Message Buses"
        table = Table(title=title, show_header=True, header_style="bold cyan")
        table.add_column("Bus")
        table.add_column("Source")
        table.add_column("State")
        table.add_column("Description")
        table.add_column("Messages", justify="right")
        table.add_column("Last")
        for bus in buses:
            table.add_row(
                str(bus["bus_id"]),
                str(bus.get("source") or ""),
                str(bus.get("state") or ""),
                str(bus.get("title") or ""),
                str(bus.get("message_count") or 0),
                str(bus.get("last_received_at") or ""),
            )
        self.console.print(table)

    def _print_forgotten_buses(self) -> None:
        table = Table(title="Forgotten Buses", show_header=True, header_style="bold cyan")
        table.add_column("Bus")
        table.add_column("Forgotten At")
        table.add_column("Reason")
        for bus in self.store.list_forgotten_buses():
            table.add_row(bus["bus_id"], bus["forgotten_at"], bus["reason"])
        self.console.print(table)

    def _forget_bus(self, bus_id: str) -> None:
        bus_id = bus_id.strip()
        call_cleanup = None
        if self.calls:
            call_cleanup = self.calls.forget_bus(bus_id)
        contacts_updated = self.addressbook.remove_bus(bus_id)
        result = self.store.forget_bus(bus_id, reason="manual")
        with self._agent_queue_lock:
            self._agent_pending = [
                event for event in self._agent_pending if not self._event_matches_bus(event, bus_id)
            ]
        if self.agent:
            self.agent.clear_session()
        parts = [
            f"deleted {result['deleted_messages']} bus message(s)",
            f"deleted {result['deleted_root_mirrors']} root mirror(s)",
            f"updated {contacts_updated} contact(s)",
        ]
        if call_cleanup:
            parts.append(call_cleanup)
        self.console.print(f"[green]Forgot {bus_id}.[/green] " + "; ".join(parts))

    def _restore_bus(self, bus_id: str) -> None:
        restored = self.store.restore_bus(bus_id)
        if restored:
            self.console.print(f"[green]Restored {bus_id}.[/green] New events can be stored again.")
        else:
            self.console.print(f"[yellow]{bus_id} was not forgotten.[/yellow]")

    def _collect_buses(self) -> list[dict[str, Any]]:
        by_id: dict[str, dict[str, Any]] = {}
        forgotten = self.store.forgotten_bus_ids()
        for bus in self.store.list_buses():
            bus_id = str(bus["bus_id"])
            by_id[bus_id] = {
                **bus,
                "state": self._bus_state(bus_id),
                "title": "Desktop chat" if bus_id == ROOT_BUS_ID else "",
            }
        by_id.setdefault(
            ROOT_BUS_ID,
            {
                "bus_id": ROOT_BUS_ID,
                "source": ROOT_BUS_ID,
                "state": "connected",
                "title": "Desktop chat",
                "message_count": 0,
                "last_received_at": "",
            },
        )
        for bus in self._live_buses():
            bus_id = str(bus["bus_id"])
            if bus_id in forgotten:
                continue
            existing = by_id.get(bus_id, {})
            by_id[bus_id] = {**existing, **bus, "state": bus.get("state") or self._bus_state(bus_id)}
        return sorted(
            by_id.values(),
            key=lambda bus: (
                0 if bus["bus_id"] == ROOT_BUS_ID else 1,
                str(bus.get("source") or ""),
                str(bus["bus_id"]),
            ),
        )

    def _live_buses(self) -> list[dict[str, Any]]:
        buses: list[dict[str, Any]] = []
        if self.telegram and self.telegram.connected:
            try:
                buses.extend(self.telegram.list_connected_buses())
            except Exception as exc:  # noqa: BLE001 - buses command should stay usable
                buses.append(
                    {
                        "bus_id": "telegram",
                        "source": "telegram",
                        "title": f"List failed: {exc}",
                        "state": "error",
                    }
                )
        if self.calls and self.calls.running:
            try:
                buses.extend(self.calls.list_connected_buses())
            except Exception as exc:  # noqa: BLE001
                buses.append(
                    {
                        "bus_id": "telegram-call",
                        "source": "telegram-call",
                        "title": f"List failed: {exc}",
                        "state": "error",
                    }
                )
        if self.google and self.google.config.enabled and self.google.is_authorized():
            try:
                buses.extend(self.google.list_connected_buses())
            except Exception as exc:  # noqa: BLE001
                buses.append(
                    {
                        "bus_id": "google",
                        "source": "google",
                        "title": f"List failed: {exc}",
                        "state": "error",
                    }
                )
        return buses

    def _bus_state(self, bus_id: str) -> str:
        if bus_id == ROOT_BUS_ID:
            return "connected"
        if bus_id.startswith("telegram-"):
            if self.calls and self.calls.is_active_bus(bus_id):
                return "in call"
            return "connected" if self.telegram and self.telegram.connected else "disconnected"
        if bus_id.startswith(("gmail-", "calendar-")):
            if self.google and self.google.config.enabled and self.google.running:
                return "polling"
            if self.google and self.google.config.enabled and self.google.is_authorized():
                return "authorized"
            return "disconnected"
        return "known"

    def _append_root_message(self, text: str, *, sender: str = "user") -> MessageEvent:
        event = MessageEvent(
            source=ROOT_BUS_ID,
            bus_id=ROOT_BUS_ID,
            sender=sender,
            text=text,
            outbound=True,
        )
        self.emit(event)
        return event

    def _mirror_to_root(self, event: MessageEvent) -> None:
        if event.bus_id == ROOT_BUS_ID or event.source in {ROOT_BUS_ID, "system"}:
            return
        external_id = None
        if event.external_id:
            external_id = f"mirror:{event.source}:{event.bus_id}:{event.external_id}"
        mirrored = MessageEvent(
            source=ROOT_BUS_ID,
            bus_id=ROOT_BUS_ID,
            sender=event.sender,
            text=f"{event.bus_id}:{event.text}",
            timestamp=event.timestamp,
            external_id=external_id,
            outbound=event.outbound,
            meta={"mirrored_source": event.source, "mirrored_bus_id": event.bus_id},
        )
        inserted = self.store.append(mirrored)
        if inserted and not event.outbound:
            self._queue_agent_response(mirrored)

    def _event_targets_forgotten_bus(self, event: MessageEvent) -> bool:
        if event.bus_id != ROOT_BUS_ID and self.store.is_bus_forgotten(event.bus_id):
            return True
        mirrored = event.meta.get("mirrored_bus_id")
        return isinstance(mirrored, str) and self.store.is_bus_forgotten(mirrored)

    def _event_matches_bus(self, event: MessageEvent, bus_id: str) -> bool:
        if event.bus_id == bus_id:
            return True
        mirrored = event.meta.get("mirrored_bus_id")
        if mirrored == bus_id:
            return True
        return event.bus_id == ROOT_BUS_ID and event.text.startswith(f"{bus_id}:")

    def _respond_with_agent(self, event: MessageEvent) -> None:
        if not self.agent:
            return
        stop_typing = self._start_telegram_typing(event)
        try:
            with self._agent_lock:
                self.console.print("[dim]assistant:[/dim]", end="")
                response = self.agent.respond(event, self._stream_agent_delta)
                if response:
                    self.print_event(response)
        except Exception as exc:  # noqa: BLE001 - keep TUI alive
            self.console.print(f"[red]Agent error:[/red] {exc}")
        finally:
            stop_typing()

    def _queue_agent_response(self, event: MessageEvent) -> None:
        if not self.agent or not self.agent.ready:
            return
        with self._agent_queue_lock:
            self._agent_pending.append(event)
            if self._agent_worker_active:
                return
            self._agent_worker_active = True
        thread = threading.Thread(target=self._agent_queue_worker, name="yaaia-agent-queue", daemon=True)
        thread.start()

    def _agent_queue_worker(self) -> None:
        try:
            while True:
                time.sleep(1.0)
                with self._agent_queue_lock:
                    batch = self._agent_pending
                    self._agent_pending = []
                if not batch:
                    return
                if len(batch) == 1:
                    event = batch[0]
                else:
                    text = "New messages received while you were busy:\n\n" + "\n\n".join(event.text for event in batch)
                    event = MessageEvent(source=ROOT_BUS_ID, bus_id=ROOT_BUS_ID, sender="queue", text=text, outbound=True)
                    self.store.append(event)
                self._respond_with_agent(event)
        finally:
            with self._agent_queue_lock:
                if self._agent_pending:
                    thread = threading.Thread(target=self._agent_queue_worker, name="yaaia-agent-queue", daemon=True)
                    thread.start()
                else:
                    self._agent_worker_active = False

    def _stream_agent_delta(self, chunk: str) -> None:
        with self._lock:
            self.console.print(chunk, end="", soft_wrap=True, markup=False)

    def handle_script_event(self, event_type: str, payload: dict[str, Any]) -> None:
        with self._lock:
            if event_type == "script":
                language = str(payload.get("language") or "text")
                code = str(payload.get("code") or "")
                executable = bool(payload.get("executable"))
                title = f"Agent wrote {language} script #{payload.get('index')}"
                subtitle = "executing" if executable else "display only"
                lexer = "python" if language in {"python", "py"} else "text"
                self.console.print(
                    Panel(
                        Syntax(code, lexer, word_wrap=True, line_numbers=True),
                        title=title,
                        subtitle=subtitle,
                        border_style="yellow" if executable else "dim",
                    )
                )
                return
            if event_type == "script_result":
                status = "ok" if payload.get("ok") else "failed"
                parts = [f"status: {status}", f"duration: {float(payload.get('duration_seconds') or 0):.3f}s"]
                stdout = str(payload.get("stdout") or "").strip()
                stderr = str(payload.get("stderr") or "").strip()
                error = str(payload.get("error") or "").strip()
                routes = payload.get("routes") if isinstance(payload.get("routes"), list) else []
                if stdout:
                    parts.extend(["", "stdout:", stdout])
                if stderr:
                    parts.extend(["", "stderr:", stderr])
                if error:
                    parts.extend(["", "error:", error])
                if routes:
                    parts.append("")
                    parts.append("sent messages:")
                    for route in routes:
                        if isinstance(route, dict):
                            parts.append(f"{route.get('bus_id')}:{route.get('content')}")
                self.console.print(
                    Panel(
                        "\n".join(parts),
                        title=f"Script result #{payload.get('index')}",
                        border_style="green" if payload.get("ok") else "red",
                    )
                )

    def _start_telegram_typing(self, event: MessageEvent) -> Callable[[], None]:
        chat_ids = self._telegram_chat_ids_for_event(event)
        if not chat_ids or not self.telegram or not self.telegram.connected:
            return lambda: None
        stopped = threading.Event()
        for chat_id in chat_ids:
            self.telegram.send_typing(chat_id, typing=True)

        def worker() -> None:
            while not stopped.is_set():
                stopped.wait(4.0)
                if stopped.is_set():
                    break
                for chat_id in chat_ids:
                    if self.telegram and self.telegram.connected:
                        self.telegram.send_typing(chat_id, typing=True)
            for chat_id in chat_ids:
                if self.telegram and self.telegram.connected:
                    self.telegram.send_typing(chat_id, typing=False)

        thread = threading.Thread(target=worker, name="yaaia-telegram-typing", daemon=True)
        thread.start()
        return stopped.set

    def _telegram_chat_ids_for_event(self, event: MessageEvent) -> list[int]:
        bus_ids: set[str] = set()
        mirrored = event.meta.get("mirrored_bus_id")
        if isinstance(mirrored, str):
            bus_ids.add(mirrored)
        bus_ids.update(re.findall(r"\btelegram--?\d+\b", event.text))
        if event.bus_id.startswith("telegram-"):
            bus_ids.add(event.bus_id)
        chat_ids: list[int] = []
        for bus_id in bus_ids:
            raw = bus_id.removeprefix("telegram-")
            try:
                chat_ids.append(int(raw))
            except ValueError:
                continue
        return sorted(set(chat_ids))

    def deliver_agent_message(self, bus_id: str, content: str) -> None:
        if self.store.is_bus_forgotten(bus_id):
            raise RuntimeError(f"{bus_id} is forgotten. Run `restore bus {bus_id}` before sending.")
        if bus_id == "call":
            if not self.calls:
                raise RuntimeError("Call service not configured.")
            result = self.calls.handle_agent_command(content)
            self.emit(
                MessageEvent(
                    source="call",
                    bus_id="call",
                    sender="agent",
                    text=result,
                    outbound=True,
                )
            )
            return
        if bus_id == "email" or bus_id.startswith(("gmail-", "email-")):
            self._send_agent_email(bus_id, content)
            return
        if bus_id.startswith("telegram-"):
            spoken = False
            if self.calls and self.calls.is_active_bus(bus_id):
                self.calls.say(bus_id, content)
                spoken = True
            if self.config.voice.text_fallback or not spoken:
                if not self.telegram or not self.telegram.connected:
                    if spoken:
                        return
                    raise RuntimeError(f"Telegram is not connected for {bus_id}.")
                self.telegram.send_text(int(bus_id.removeprefix("telegram-")), content)
            return
        event = MessageEvent(
            source=ROOT_BUS_ID,
            bus_id=ROOT_BUS_ID,
            sender="assistant",
            text=f"{bus_id}:{content}",
            outbound=False,
        )
        self.emit(event)

    def _send_agent_email(self, bus_id: str, content: str) -> None:
        if not self.google:
            raise RuntimeError("Google service not configured.")
        if self.store.is_bus_forgotten(bus_id):
            raise RuntimeError(f"{bus_id} is forgotten. Run `restore bus {bus_id}` before sending.")
        is_reply = bus_id.startswith("gmail-")
        payload = _parse_email_payload(content, require_to=not is_reply)
        if is_reply and not payload.to:
            self.google.reply_to_last_email(
                bus_id,
                payload.body,
                subject=payload.subject or None,
                cc=payload.cc or None,
                bcc=payload.bcc or None,
                html_body=payload.html_body or None,
                attachments=payload.attachments,
            )
            return
        if not payload.to:
            raise ValueError("Email recipient is required. Use email:<to> | <subject> | <body>.")
        self.google.send_email(
            payload.to,
            payload.subject,
            payload.body,
            cc=payload.cc or None,
            bcc=payload.bcc or None,
            html_body=payload.html_body or None,
            attachments=payload.attachments,
            bus_id=bus_id if bus_id.startswith("gmail-") else None,
        )

    def _print_telegram_chats(self, limit: int) -> None:
        if not self.telegram:
            raise RuntimeError("Telegram service not configured.")
        chats = self.telegram.list_chats(limit)
        table = Table(title="Telegram Chats", show_header=True, header_style="bold cyan")
        table.add_column("ID")
        table.add_column("Title")
        table.add_column("Unread", justify="right")
        for chat in chats:
            table.add_row(str(chat["id"]), str(chat["title"]), str(chat.get("unread_count", 0)))
        self.console.print(table)


def _split_csv(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def _bus_arg(line: str) -> str:
    parts = shlex.split(line)
    if len(parts) < 3:
        raise ValueError("Usage: forget bus <bus_id> or restore bus <bus_id>")
    return parts[2]


def _parse_email_payload(content: str, *, require_to: bool) -> EmailPayload:
    content = content.strip()
    if not content:
        raise ValueError("Email content is required.")
    if _starts_with_email_header(content):
        return _parse_email_header_payload(content, require_to=require_to)
    if require_to:
        parts = [part.strip() for part in content.split("|", 2)]
        if len(parts) != 3 or not parts[0] or not parts[2]:
            raise ValueError("Usage: email:<to> | <subject> | <body>")
        return EmailPayload(to=parts[0], subject=parts[1], body=parts[2])
    subject, sep, body = content.partition("|")
    if sep:
        return EmailPayload(subject=subject.strip(), body=body.strip())
    return EmailPayload(body=content)


def _parse_email_header_payload(content: str, *, require_to: bool) -> EmailPayload:
    headers: dict[str, str] = {}
    lines = content.splitlines()
    body_start = 0
    parsed_any = False
    for index, line in enumerate(lines):
        if not line.strip():
            body_start = index + 1
            break
        key, sep, value = line.partition(":")
        normalized = _email_header_key(key)
        if not sep or not normalized:
            body_start = index
            break
        parsed_any = True
        previous = headers.get(normalized, "")
        headers[normalized] = f"{previous}, {value.strip()}" if previous and value.strip() else previous or value.strip()
        body_start = index + 1
    if not parsed_any:
        return _parse_email_payload(content, require_to=require_to)

    body = "\n".join(lines[body_start:]).strip()
    if headers.get("body") and not body:
        body = headers["body"]

    html_header = headers.get("html", "")
    html_body = headers.get("html_body", "")
    if html_header.lower() in {"1", "true", "yes", "body"}:
        html_body = body
        body = headers.get("body", "")
    elif html_header and not html_body:
        html_body = html_header

    to = headers.get("to", "")
    if require_to and not to:
        raise ValueError("Email recipient is required. Add `to:` or use email:<to> | <subject> | <body>.")
    return EmailPayload(
        to=to,
        subject=headers.get("subject", ""),
        body=body,
        cc=headers.get("cc", ""),
        bcc=headers.get("bcc", ""),
        html_body=html_body,
        attachments=tuple(Path(item).expanduser() for item in _split_email_list(headers.get("attachments", ""))),
    )


def _starts_with_email_header(content: str) -> bool:
    first = content.splitlines()[0] if content.splitlines() else ""
    key, sep, _ = first.partition(":")
    return bool(sep and _email_header_key(key))


def _email_header_key(key: str) -> str:
    normalized = key.strip().lower().replace("-", "_")
    aliases = {
        "to": "to",
        "cc": "cc",
        "bcc": "bcc",
        "subject": "subject",
        "body": "body",
        "html": "html",
        "html_body": "html_body",
        "attachment": "attachments",
        "attachments": "attachments",
        "file": "attachments",
        "files": "attachments",
    }
    return aliases.get(normalized, "")


def _split_email_list(value: str) -> list[str]:
    if not value.strip():
        return []
    if "," in value:
        return [part.strip() for part in value.split(",") if part.strip()]
    return shlex.split(value)
