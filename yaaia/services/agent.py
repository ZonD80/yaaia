from __future__ import annotations

import base64
import getpass
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from ..events import MessageEvent, utc_now
from ..storage import ROOT_BUS_ID, MessageStore
from .addressbook import AddressBookStore
from .secrets import SecretsStore
from .script_runner import ScriptBlock, ScriptExecution, execute_python_script, extract_script_blocks

Stream = Callable[[str], None]
Deliver = Callable[[str, str], str | None]
Log = Callable[[str], None]
ScriptObserver = Callable[[str, dict[str, Any]], None]

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"
CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

MODEL_HISTORY_MAX_CHARS = 50_000
SESSION_ROLLING_MAX_CHARS = 200_000


@dataclass(slots=True)
class AgentConfig:
    provider: str = "openrouter"
    claude_api_key: str = ""
    claude_model: str = "claude-sonnet-4-6"
    openrouter_api_key: str = ""
    openrouter_model: str = "google/gemini-2.5-flash"
    openai_api_key: str = ""
    openai_model: str = "gpt-5.4"
    codex_model: str = "gpt-5.1-codex"
    max_tokens: int = 8192

    @property
    def required_secret(self) -> str:
        if self.provider == "claude":
            return self.claude_api_key
        if self.provider == "openai":
            return self.openai_api_key
        if self.provider == "codex":
            return "codex-auth"
        return self.openrouter_api_key

    @property
    def ready(self) -> bool:
        if self.provider == "codex":
            return True
        return bool(self.required_secret.strip())


class AgentService:
    def __init__(
        self,
        home: Path,
        store: MessageStore,
        deliver: Deliver,
        log: Log,
        script_observer: ScriptObserver | None = None,
        addressbook: AddressBookStore | None = None,
        secrets: SecretsStore | None = None,
    ) -> None:
        self.home = home
        self.store = store
        self.deliver = deliver
        self.log = log
        self.script_observer = script_observer
        self.addressbook = addressbook
        self.secrets = secrets
        self.config = load_agent_config(home)
        self._session: list[dict[str, str]] = []
        self._last_codex_reasoning: str | None = None

    @property
    def ready(self) -> bool:
        if self.config.provider == "codex":
            return _load_codex_auth(self.home) is not None
        return self.config.ready

    def configure_interactive(self) -> None:
        self.config = prompt_agent_config(self.home, self.config)
        save_agent_config(self.home, self.config)

    def ensure_configured_interactive(self) -> None:
        if self.ready:
            return
        if not os.isatty(0):
            self.log("Agent disabled: missing AI provider credentials. Run `agent setup`.")
            return
        self.log("Agent configuration missing. Starting interactive AI provider setup.")
        self.configure_interactive()

    def clear_session(self) -> None:
        self._session = []

    def status(self) -> dict[str, str]:
        return {
            "provider": self.config.provider,
            "model": _active_model(self.config),
            "ready": "yes" if self.ready else "no",
        }

    def respond(self, trigger: MessageEvent, stream: Stream) -> MessageEvent | None:
        if not self.ready:
            raise RuntimeError("Agent is not configured. Run `agent setup`.")

        system_prompt = _system_prompt()
        user_message = self._current_message_for_model(trigger)
        if self._session:
            api_messages = [*self._session, {"role": "user", "content": user_message}]
        else:
            history = self.store.recent_bus_before(ROOT_BUS_ID, trigger.db_id, 100)
            api_messages = [{"role": "user", "content": self._synthetic_history(user_message, history)}]

        messages = [*api_messages]
        for script_round in range(1, 5):
            stream("\n")
            full_text = ""
            for chunk in self._stream_provider(system_prompt, messages):
                full_text += chunk
                stream(chunk)
            stream("\n")

            final_text = full_text.strip()
            if not final_text:
                return None

            blocks = extract_script_blocks(final_text)
            executable_blocks = [block for block in blocks if block.executable]
            if not blocks:
                self._session = _trim_session([*messages, {"role": "assistant", "content": final_text}])
                return self._persist_and_deliver(final_text)
            if not executable_blocks:
                self._display_script_blocks(blocks, script_round)
                self._session = _trim_session([*messages, {"role": "assistant", "content": final_text}])
                return self._persist_and_deliver(final_text)

            messages.append({"role": "assistant", "content": final_text})
            results = self._execute_script_blocks(blocks, script_round)
            messages.append({"role": "user", "content": _script_results_for_model(results)})

        limit_message = "root:Stopped after 4 Python execution rounds. Please provide a final answer without another script block."
        self._session = _trim_session([*messages, {"role": "user", "content": limit_message}])
        return self._persist_and_deliver(limit_message)

    def _stream_provider(self, system_prompt: str, messages: list[dict[str, str]]) -> Iterable[str]:
        provider = self.config.provider
        if provider == "claude":
            yield from _stream_anthropic(self.config, system_prompt, _merge_messages(messages))
            return
        if provider == "codex":
            yield from _stream_codex(
                self.home,
                self.config,
                system_prompt,
                _merge_messages(messages),
                self._last_codex_reasoning,
                self._set_codex_reasoning,
            )
            return
        if provider == "openai":
            yield from _stream_openai(self.config, system_prompt, _merge_messages(messages))
            return
        yield from _stream_openrouter(self.config, system_prompt, _merge_messages(messages))

    def _set_codex_reasoning(self, reasoning: str) -> None:
        self._last_codex_reasoning = reasoning

    def _current_message_for_model(self, trigger: MessageEvent) -> str:
        text = _prefix_for_model(trigger)
        prev = self.store.last_db_id_before(ROOT_BUS_ID, trigger.db_id)
        prev_line = f"prev_msg_id: {prev}\n" if prev is not None else ""
        db_id = trigger.db_id or "?"
        return (
            f"=== CURRENT MESSAGE (db_id: {db_id}, message_id: {db_id}, bus_id: {ROOT_BUS_ID}) ===\n"
            f"{prev_line}"
            "=== END HEADER ===\n\n"
            f"{text}"
        )

    def _synthetic_history(self, user_message: str, history: list[MessageEvent]) -> str:
        lines: list[str] = []
        total = 0
        for event in reversed(history):
            line = _history_line(event)
            total += len(line)
            if total > MODEL_HISTORY_MAX_CHARS:
                break
            lines.append(line)
        lines.reverse()
        if not lines:
            return user_message
        return "\n".join(["=== HISTORY (db_id - date - message) ===", *lines, "=== HISTORY END ===", "", user_message])

    def _persist_and_deliver(self, text: str) -> MessageEvent | None:
        parsed = parse_prefixed_messages(text)
        if not parsed:
            parsed = [(ROOT_BUS_ID, text)]

        last_event: MessageEvent | None = None
        for bus_id, content in parsed:
            if not content.strip():
                continue
            if bus_id.startswith(("telegram-", "gmail-", "email-")) or bus_id in {
                "call",
                "email",
                "telegram-search",
                "telegram-resolve",
            }:
                self.deliver(bus_id, content)
                continue
            event = MessageEvent(
                source=ROOT_BUS_ID,
                bus_id=ROOT_BUS_ID,
                sender="assistant",
                text=content if bus_id == ROOT_BUS_ID else f"{bus_id}:{content}",
                timestamp=utc_now(),
                outbound=False,
            )
            self.store.append(event)
            last_event = event
        return last_event

    def _display_script_blocks(self, blocks: list[ScriptBlock], script_round: int) -> None:
        for block in blocks:
            self._observe_script(
                "script",
                {
                    "round": script_round,
                    "index": block.index,
                    "language": block.language,
                    "code": block.code,
                    "executable": False,
                },
            )

    def _execute_script_blocks(self, blocks: list[ScriptBlock], script_round: int) -> list[tuple[ScriptBlock, ScriptExecution | None]]:
        results: list[tuple[ScriptBlock, ScriptExecution | None]] = []
        for block in blocks:
            self._observe_script(
                "script",
                {
                    "round": script_round,
                    "index": block.index,
                    "language": block.language,
                    "code": block.code,
                    "executable": block.executable,
                },
            )
            if not block.executable:
                self._observe_script(
                    "script_result",
                    {
                        "round": script_round,
                        "index": block.index,
                        "language": block.language,
                        "ok": False,
                        "stdout": "",
                        "stderr": "",
                        "error": f"{block.language} blocks are displayed but not executed. Use [yaaia=python]...[/yaaia].",
                        "duration_seconds": 0,
                    },
                )
                results.append((block, None))
                continue
            execution = execute_python_script(
                block.code,
                history=self._history_snapshot(),
                buses=self.store.list_buses(),
                home=self.home,
                database_path=self.store.path,
            )
            self._observe_script(
                "script_result",
                {
                    "round": script_round,
                    "index": block.index,
                    "language": block.language,
                    "ok": execution.ok,
                    "stdout": execution.stdout,
                    "stderr": execution.stderr,
                    "error": execution.error,
                    "duration_seconds": execution.duration_seconds,
                    "timed_out": execution.timed_out,
                    "routes": execution.routes,
                },
            )
            route_results: list[str] = []
            for route in execution.routes:
                delivered = self.deliver(route["bus_id"], route["content"])
                if delivered:
                    route_results.append(f"{route['bus_id']} result: {delivered}")
            if route_results:
                execution = replace(
                    execution,
                    stdout="\n".join(part for part in [execution.stdout.strip(), *route_results] if part),
                )
            results.append((block, execution))
        return results

    def _history_snapshot(self) -> list[dict[str, Any]]:
        return [
            {
                "db_id": event.db_id,
                "source": event.source,
                "bus_id": event.bus_id,
                "sender": event.sender,
                "text": event.text,
                "timestamp": event.timestamp_iso,
                "outbound": event.outbound,
            }
            for event in self.store.recent(500)
        ]

    def _observe_script(self, event_type: str, payload: dict[str, Any]) -> None:
        if self.script_observer:
            self.script_observer(event_type, payload)


def load_agent_config(home: Path) -> AgentConfig:
    config = AgentConfig()
    for path in [home / "appData" / "config.json", home / "agent-config.json"]:
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(data, dict):
                _merge_config_dict(config, data)
    _merge_config_dict(
        config,
        {
            "aiProvider": os.getenv("YAAIA_AI_PROVIDER"),
            "claudeApiKey": os.getenv("YAAIA_CLAUDE_API_KEY"),
            "claudeModel": os.getenv("YAAIA_CLAUDE_MODEL"),
            "openrouterApiKey": os.getenv("YAAIA_OPENROUTER_API_KEY"),
            "openrouterModel": os.getenv("YAAIA_OPENROUTER_MODEL"),
            "openaiApiKey": os.getenv("YAAIA_OPENAI_API_KEY"),
            "openaiModel": os.getenv("YAAIA_OPENAI_MODEL"),
            "codexModel": os.getenv("YAAIA_CODEX_MODEL"),
        },
    )
    if config.provider not in {"openrouter", "claude", "codex", "openai"}:
        config.provider = "openrouter"
    return config


def save_agent_config(home: Path, config: AgentConfig) -> None:
    path = home / "appData" / "config.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    data: dict[str, Any] = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, json.JSONDecodeError):
            data = {}
    data.update(
        {
            "aiProvider": config.provider,
            "claudeApiKey": config.claude_api_key,
            "claudeModel": config.claude_model,
            "openrouterApiKey": config.openrouter_api_key,
            "openrouterModel": config.openrouter_model,
            "openaiApiKey": config.openai_api_key,
            "openaiModel": config.openai_model,
            "codexModel": config.codex_model,
        }
    )
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def prompt_agent_config(home: Path, current: AgentConfig | None = None) -> AgentConfig:
    config = current or load_agent_config(home)
    provider = input(f"AI provider (openrouter, claude, codex) [{config.provider}]: ").strip().lower() or config.provider
    if provider not in {"openrouter", "claude", "codex"}:
        provider = "openrouter"
    config.provider = provider
    if provider == "openrouter":
        key = getpass.getpass("OpenRouter API key [keep existing]: ").strip()
        if key:
            config.openrouter_api_key = key
        model = input(f"OpenRouter model [{config.openrouter_model}]: ").strip()
        if model:
            config.openrouter_model = model
    elif provider == "claude":
        key = getpass.getpass("Claude API key [keep existing]: ").strip()
        if key:
            config.claude_api_key = key
        model = input(f"Claude model [{config.claude_model}]: ").strip()
        if model:
            config.claude_model = model
    else:
        if not _load_codex_auth(home):
            print("Codex auth is missing. Use OpenRouter/Claude for now or restore ~/yaaia/codex-auth.json.")
        model = input(f"Codex model [{config.codex_model}]: ").strip()
        if model:
            config.codex_model = model
    return config


def parse_prefixed_messages(text: str) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    current_bus: str | None = None
    current_parts: list[str] = []
    for line in text.splitlines():
        bus_id, content = _split_bus_line(line)
        if bus_id:
            if current_bus and current_parts:
                result.append((current_bus, "\n".join(current_parts).strip()))
            current_bus = bus_id
            current_parts = [content] if content else []
        elif current_bus:
            current_parts.append(line)
    if current_bus and current_parts:
        result.append((current_bus, "\n".join(current_parts).strip()))
    return [(bus, content) for bus, content in result if content]


def _merge_config_dict(config: AgentConfig, data: dict[str, Any]) -> None:
    if data.get("aiProvider"):
        config.provider = str(data["aiProvider"]).strip().lower()
    if data.get("claudeApiKey"):
        config.claude_api_key = str(data["claudeApiKey"])
    if data.get("claudeModel"):
        config.claude_model = str(data["claudeModel"])
    if data.get("openrouterApiKey"):
        config.openrouter_api_key = str(data["openrouterApiKey"])
    if data.get("openrouterModel"):
        config.openrouter_model = str(data["openrouterModel"])
    if data.get("openaiApiKey"):
        config.openai_api_key = str(data["openaiApiKey"])
    if data.get("openaiModel"):
        config.openai_model = str(data["openaiModel"])
    if data.get("codexModel"):
        config.codex_model = str(data["codexModel"])


def _system_prompt() -> str:
    return """You are YAAIA, a bus-routed assistant.

Every assistant message must use prefix routing:
- root:<message> for the console/root chat.
- telegram-<chat_id>:<message> to send a Telegram text message.
- telegram-@username:<message> is also allowed; the app resolves it before sending.
- email:<to> | <subject> | <body> to send a new Gmail message.
- gmail-<bus_id>:<message> to reply to the latest inbound Gmail message on that bus.
- call:<command> to control Telegram calls when explicitly requested.

Do not attempt VM control or persistent memory APIs.
You see root history as `db_id - date - message`; messages from other buses are mirrored into root as `<bus_id>:<message>`.
When replying to a remote bus, include the remote bus prefix. When replying to the console user, use `root:`.
For email, use header form when needed:
email:
to: user@example.com
cc: optional@example.com
bcc: hidden@example.com
subject: Subject text
attachments: /absolute/path/file.pdf

Plain-text body here
Use `html: true` when the body is HTML, or `html: <p>HTML body</p>` plus a plain body. Do not send email unless the user asked for an email or you are directly replying to an inbound email.
If a Telegram voice call is active on a `telegram-<chat_id>` bus, replying to that Telegram bus is spoken into the call via TTS and may also be sent as text. Keep voice-call replies brief: one or two short spoken sentences unless the user explicitly asks for detail.
Available call commands are: `call:status`, `call:check`, `call:start telegram-<chat_id>`, `call:accept telegram-<chat_id>`, `call:hangup [telegram-<chat_id>]`, `call:reject [telegram-<chat_id>]`, and `call:say telegram-<chat_id> <text>`.
Only forget a bus when the user explicitly asks; forgetting deletes local bus messages, root mirrors, and contact bus links.
For Telegram contacts you do not know, use `telegram_search(query, limit=20)` or `telegram_resolve("@username")` in Python first; search results are returned in execution output with `telegram-<chat_id>` bus ids.
For schedules, use Python helpers. Due schedules are injected into root as scheduled tasks and should be completed when received.

If you need local computation, write Python in a bbtag block:
[yaaia=python]
print("diagnostic output")
root("optional root message")
[/yaaia]
The app executes Python with the same interpreter/environment as YAAIA and displays the script plus stdout/stderr in root.
Available helpers inside Python: history(bus_id="root", limit=50), buses(), send(bus_id, content), root(content), call(command), email(to, subject, body, cc="", bcc="", html="", attachments=[]), reply_email(bus_id, body, subject="", cc="", bcc="", html="", attachments=[]), telegram_search(query, limit=20), telegram_resolve(target), schedule_create(title, instructions, at, repeat="", bus_id="root"), schedules_list(include_disabled=True), schedule_update(id, **updates), schedule_delete(id), schedule_run_due(), forget_bus(bus_id, reason="script"), restore_bus(bus_id), forgotten_buses().
Addressbook helpers: contacts_list(), contacts_search(query), contact_get(id_or_identifier), contact_create(name, identifier, trust_level="normal", bus_ids=[], notes=""), contact_update(id_or_identifier, **updates), contact_delete(id_or_identifier), contact_is_trusted(bus_id, sender_email=None).
Secrets helpers: secrets_list(), secret_get(description_or_uuid, raw=False), secret_set(description, type, value, force=False), secret_delete(description_or_uuid). Use secret_get only when the task requires the secret value.
After execution results are returned, provide a final bus-prefixed answer. Do not use TypeScript or vm-bash.
"""


def _active_model(config: AgentConfig) -> str:
    if config.provider == "claude":
        return config.claude_model
    if config.provider == "codex":
        return config.codex_model
    if config.provider == "openai":
        return config.openai_model
    return config.openrouter_model


def _prefix_for_model(event: MessageEvent) -> str:
    if event.text.startswith(f"{ROOT_BUS_ID}:") or _split_bus_line(event.text)[0]:
        return event.text
    return f"{event.bus_id}:{event.text}"


def _history_line(event: MessageEvent) -> str:
    text = _prefix_for_model(event).replace("\r\n", "\n").replace("\n", " ").strip()
    return f"{event.db_id or '?'} - {event.timestamp_iso} - {text}"


def _split_bus_line(line: str) -> tuple[str | None, str]:
    head, sep, tail = line.partition(":")
    if not sep or not _is_valid_bus_id(head.strip()):
        return None, line
    if tail.startswith("wait:"):
        tail = tail.removeprefix("wait:").lstrip()
    return head.strip(), tail.lstrip()


def _is_valid_bus_id(bus_id: str) -> bool:
    return (
        bus_id == ROOT_BUS_ID
        or bus_id == "email"
        or bus_id in {"telegram-search", "telegram-resolve"}
        or bus_id.startswith("telegram-")
        or bus_id.startswith("gmail-")
        or bus_id.startswith("calendar-")
        or bus_id.startswith("email-")
        or bus_id == "call"
    )


def _merge_messages(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    merged: list[dict[str, str]] = []
    for message in messages:
        role = message["role"]
        content = message["content"]
        if merged and merged[-1]["role"] == role:
            merged[-1]["content"] += "\n\n" + content
        else:
            merged.append({"role": role, "content": content})
    return merged


def _trim_session(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    total = 0
    for message in reversed(messages):
        length = len(message["content"])
        if total + length > SESSION_ROLLING_MAX_CHARS:
            break
        out.insert(0, message)
        total += length
    while out and out[0]["role"] == "assistant":
        out.pop(0)
    return out


def _script_results_for_model(results: list[tuple[ScriptBlock, ScriptExecution | None]]) -> str:
    parts = ["=== PYTHON EXECUTION RESULTS ==="]
    for block, execution in results:
        parts.append(f"--- block {block.index} ({block.language}) ---")
        if execution is None:
            parts.append(f"Unsupported block type: {block.language}. Use [yaaia=python]...[/yaaia].")
            continue
        parts.append(f"ok: {execution.ok}")
        parts.append(f"duration_seconds: {execution.duration_seconds:.3f}")
        if execution.stdout.strip():
            parts.append("stdout:")
            parts.append(execution.stdout.strip())
        if execution.stderr.strip():
            parts.append("stderr:")
            parts.append(execution.stderr.strip())
        if execution.error:
            parts.append("error:")
            parts.append(execution.error.strip())
        if execution.routes:
            parts.append("sent_messages:")
            for route in execution.routes:
                parts.append(f"{route['bus_id']}:{route['content']}")
    parts.append("=== END PYTHON EXECUTION RESULTS ===")
    parts.append("Now continue with a final bus-prefixed response. Use another [yaaia=python] block only if more local computation is required.")
    return "\n".join(parts)


def _stream_openrouter(config: AgentConfig, system_prompt: str, messages: list[dict[str, str]]) -> Iterable[str]:
    payload = {
        "model": config.openrouter_model,
        "messages": [{"role": "system", "content": system_prompt}, *messages],
        "max_tokens": config.max_tokens,
        "stream": True,
        "reasoning": {"enabled": True},
    }
    headers = {
        "Authorization": f"Bearer {config.openrouter_api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://yaaia.local",
        "X-Title": "YAAIA",
    }
    yield from _iter_sse_json(OPENROUTER_URL, headers, payload, _openrouter_delta)


def _stream_anthropic(config: AgentConfig, system_prompt: str, messages: list[dict[str, str]]) -> Iterable[str]:
    payload = {
        "model": config.claude_model,
        "max_tokens": min(max(config.max_tokens, 1024), 16384),
        "system": system_prompt,
        "messages": messages,
        "stream": True,
    }
    headers = {
        "x-api-key": config.claude_api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    yield from _iter_sse_json(ANTHROPIC_URL, headers, payload, _anthropic_delta)


def _stream_openai(config: AgentConfig, system_prompt: str, messages: list[dict[str, str]]) -> Iterable[str]:
    payload = {
        "model": config.openai_model,
        "instructions": system_prompt,
        "input": messages,
        "stream": True,
    }
    headers = {
        "Authorization": f"Bearer {config.openai_api_key}",
        "Content-Type": "application/json",
    }
    yield from _iter_sse_json(OPENAI_RESPONSES_URL, headers, payload, _openai_delta)


def _stream_codex(
    home: Path,
    config: AgentConfig,
    system_prompt: str,
    messages: list[dict[str, str]],
    last_reasoning: str | None,
    set_reasoning: Callable[[str], None],
) -> Iterable[str]:
    auth = _ensure_codex_auth(home)
    if not auth:
        raise RuntimeError("Codex auth missing or expired. Restore ~/yaaia/codex-auth.json or run agent setup with OpenRouter/Claude.")
    account_id = _codex_account_id(auth["access"])
    if not account_id:
        raise RuntimeError("Could not read ChatGPT account id from Codex token.")
    input_items = []
    for index, message in enumerate(messages):
        item: dict[str, Any] = {
            "type": "message",
            "role": message["role"],
            "content": [{"type": "input_text", "text": message["content"]}],
        }
        if index == len(messages) - 1 and message["role"] == "assistant" and last_reasoning:
            item["reasoning"] = {"encrypted_content": last_reasoning}
        input_items.append(item)
    payload = {
        "model": config.codex_model,
        "store": False,
        "stream": True,
        "instructions": system_prompt,
        "input": input_items,
        "reasoning": {"effort": "medium", "summary": "auto"},
        "text": {"verbosity": "medium"},
        "include": ["reasoning.encrypted_content"],
    }
    def on_event(data: dict[str, Any]) -> str | None:
        if data.get("type") == "response.output_text.delta" and isinstance(data.get("delta"), str):
            return data["delta"]
        if data.get("type") in {"response.done", "response.completed"}:
            response = data.get("response") if isinstance(data.get("response"), dict) else {}
            response_reasoning = response.get("reasoning") if isinstance(response.get("reasoning"), dict) else {}
            if isinstance(response_reasoning.get("encrypted_content"), str):
                set_reasoning(response_reasoning["encrypted_content"])
        return None

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {auth['access']}",
        "chatgpt-account-id": account_id,
        "OpenAI-Beta": "responses=experimental",
        "originator": "codex_cli_rs",
        "accept": "text/event-stream",
    }
    yield from _iter_sse_json(CODEX_RESPONSES_URL, headers, payload, on_event)


def _iter_sse_json(
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    extract_delta: Callable[[dict[str, Any]], str | None],
) -> Iterable[str]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310 - user-configured HTTPS APIs
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                parsed = json.loads(data)
                delta = extract_delta(parsed)
                if delta:
                    yield delta
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"AI provider error {exc.code}: {body[:800]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"AI provider connection failed: {exc}") from exc


def _openrouter_delta(data: dict[str, Any]) -> str | None:
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    choice = choices[0]
    if not isinstance(choice, dict):
        return None
    delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else choice.get("message")
    if not isinstance(delta, dict):
        return None
    content = delta.get("content")
    return content if isinstance(content, str) else None


def _anthropic_delta(data: dict[str, Any]) -> str | None:
    if data.get("type") != "content_block_delta":
        return None
    delta = data.get("delta")
    if not isinstance(delta, dict):
        return None
    text = delta.get("text")
    return text if isinstance(text, str) else None


def _openai_delta(data: dict[str, Any]) -> str | None:
    if data.get("type") == "response.output_text.delta" and isinstance(data.get("delta"), str):
        return data["delta"]
    return None


def _load_codex_auth(home: Path) -> dict[str, Any] | None:
    path = home / "codex-auth.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if isinstance(data, dict) and data.get("access") and data.get("refresh") and isinstance(data.get("expires"), int):
        return data
    return None


def _ensure_codex_auth(home: Path) -> dict[str, Any] | None:
    auth = _load_codex_auth(home)
    if not auth:
        return None
    if int(auth["expires"]) > int(time.time() * 1000) + 60_000:
        return auth
    request = urllib.request.Request(
        CODEX_TOKEN_URL,
        data=urllib.parse.urlencode(
            {
                "grant_type": "refresh_token",
                "refresh_token": auth["refresh"],
                "client_id": CODEX_CLIENT_ID,
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            data = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None
    if not data.get("access_token") or not data.get("refresh_token") or not data.get("expires_in"):
        return None
    refreshed = {
        "access": data["access_token"],
        "refresh": data["refresh_token"],
        "expires": int(time.time() * 1000) + int(data["expires_in"]) * 1000,
    }
    (home / "codex-auth.json").write_text(json.dumps(refreshed, indent=2) + "\n", encoding="utf-8")
    return refreshed


def _codex_account_id(access_token: str) -> str | None:
    try:
        payload = access_token.split(".")[1]
        padded = payload + "=" * (-len(payload) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except Exception:
        return None
    claim = decoded.get("https://api.openai.com/auth")
    if isinstance(claim, dict) and isinstance(claim.get("chatgpt_account_id"), str):
        return claim["chatgpt_account_id"]
    return None
