from __future__ import annotations

import html
import re
import threading
from collections.abc import Callable
from typing import Any

from ..config import TelegramConfig
from ..events import MessageEvent, utc_now
from ..tdlib import format_tdlib_version, is_tdlib_too_old_for_login, tdlib_version_from_library

Emit = Callable[[MessageEvent], None]
Log = Callable[[str], None]


class TelegramChatService:
    def __init__(self, config: TelegramConfig, emit: Emit, log: Log) -> None:
        self.config = config
        self.emit = emit
        self.log = log
        self._tg: Any | None = None
        self._lock = threading.RLock()
        self._connected = False
        self._chat_cache: dict[int, str] = {}

    @property
    def connected(self) -> bool:
        return self._connected

    def start(self) -> None:
        if not self.config.enabled:
            self.log("Telegram disabled. Set YAAIA_TELEGRAM_API_ID, YAAIA_TELEGRAM_API_HASH, and phone or bot token.")
            return
        if not self.config.api_id or not self.config.api_hash:
            self.log("Telegram not started: missing YAAIA_TELEGRAM_API_ID or YAAIA_TELEGRAM_API_HASH.")
            return
        if not self.config.phone and not self.config.bot_token:
            self.log("Telegram not started: set YAAIA_TELEGRAM_PHONE or YAAIA_TELEGRAM_BOT_TOKEN.")
            return
        if self.config.tdlib_library_path:
            tdlib_version = tdlib_version_from_library(self.config.tdlib_library_path)
            if tdlib_version:
                self.log(
                    "Using TDLib "
                    f"{format_tdlib_version(tdlib_version)} at {self.config.tdlib_library_path}."
                )
            if is_tdlib_too_old_for_login(tdlib_version):
                self.log(
                    "Telegram not started: this TDLib build is too old for current Telegram login. "
                    "Run `./scripts/install-tdlib.sh`, then restart `./launch.sh`."
                )
                return

        try:
            from telegram.client import Telegram
        except ImportError as exc:
            self.log(f"Telegram not available: {exc}. Run ./scripts/setup-conda.sh.")
            return

        self.config.files_directory.mkdir(parents=True, exist_ok=True)
        kwargs: dict[str, Any] = {
            "api_id": self.config.api_id,
            "api_hash": self.config.api_hash,
            "database_encryption_key": self.config.database_encryption_key,
            "files_directory": str(self.config.files_directory),
        }
        if self.config.tdlib_library_path:
            kwargs["library_path"] = str(self.config.tdlib_library_path)
        if self.config.bot_token:
            kwargs["bot_token"] = self.config.bot_token
        else:
            kwargs["phone"] = self.config.phone

        self.log("Connecting Telegram text client...")
        try:
            tg = Telegram(**kwargs)
            tg.login()
            tg.add_message_handler(self._handle_message_update)
            preload = tg.get_chats()
            preload.wait()
            with self._lock:
                self._tg = tg
                self._connected = True
            self.log("Telegram connected. Incoming text messages will appear in the console.")
        except Exception as exc:  # noqa: BLE001 - service boundary reports failures to TUI
            self._connected = False
            message = str(exc)
            if "incompatible architecture" in message and "libtdjson" in message:
                self.log(
                    "Telegram TDLib is the wrong CPU architecture. Install an arm64 TDLib "
                    "with `./scripts/install-tdlib.sh` and set YAAIA_TDLIB_LIBRARY_PATH, "
                    "or run `python -m yaaia setup`."
                )
            elif "UPDATE_APP_TO_LOGIN" in message:
                self.log(
                    "Telegram connection failed: TDLib is too old for current Telegram login. "
                    "Run `./scripts/install-tdlib.sh`, then restart `./launch.sh`."
                )
            else:
                self.log(f"Telegram connection failed: {exc}")

    def stop(self) -> None:
        with self._lock:
            tg = self._tg
            self._tg = None
            self._connected = False
        if tg is not None:
            try:
                tg.stop()
            except Exception as exc:  # noqa: BLE001
                self.log(f"Telegram stop failed: {exc}")

    def send_text(self, chat_id: int, text: str) -> None:
        tg = self._require_client()
        formatted_text, entities = self._parse_markdown_for_send(tg, text)
        result = tg.send_message(chat_id=chat_id, text=formatted_text, entities=entities)
        result.wait(raise_exc=True)
        update = getattr(result, "update", None)
        external_id = _message_external_id(update)
        title = self._chat_title(chat_id)
        self.emit(
            MessageEvent(
                source="telegram",
                bus_id=f"telegram-{chat_id}",
                sender="me",
                text=text,
                timestamp=utc_now(),
                external_id=external_id,
                outbound=True,
                meta={"chat_title": title},
            )
        )

    def _parse_markdown_for_send(self, tg: Any, text: str) -> tuple[str, list[dict[str, Any]]]:
        try:
            result = tg.parse_text_entities(_common_markdown_to_html(text), parse_mode="HTML")
            result.wait(timeout=5, raise_exc=True)
            update = getattr(result, "update", {}) or {}
            if not isinstance(update, dict):
                return text, []
            parsed_text = update.get("text")
            entities = update.get("entities")
            if isinstance(parsed_text, str) and isinstance(entities, list):
                return parsed_text, entities
        except Exception as exc:  # noqa: BLE001 - invalid Markdown should not block delivery
            self.log(f"Telegram Markdown parse failed, sending plain text: {exc}")
        return text, []

    def send_typing(self, chat_id: int, *, typing: bool = True) -> None:
        action = {"@type": "chatActionTyping"} if typing else None
        self._call_method_safe(
            "sendChatAction",
            {
                "chat_id": chat_id,
                "topic_id": None,
                "business_connection_id": "",
                "action": action,
            },
            timeout=2.0,
        )

    def acknowledge_message(self, chat_id: int, message_id: int) -> None:
        self._call_method_safe(
            "viewMessages",
            {
                "chat_id": chat_id,
                "message_ids": [message_id],
                "source": None,
                "force_read": True,
            },
            timeout=2.0,
        )

    def list_chats(self, limit: int = 30) -> list[dict[str, Any]]:
        tg = self._require_client()
        result = tg.get_chats(limit=max(1, min(limit, 200)))
        result.wait()
        update = getattr(result, "update", {}) or {}
        chat_ids = update.get("chat_ids") or []
        chats: list[dict[str, Any]] = []
        for chat_id in chat_ids:
            try:
                chat = self._get_chat(int(chat_id))
                chats.append(
                    {
                        "id": int(chat_id),
                        "title": chat.get("title") or str(chat_id),
                        "unread_count": chat.get("unread_count", 0),
                    }
                )
            except Exception:
                chats.append({"id": int(chat_id), "title": str(chat_id), "unread_count": 0})
        return chats

    def list_connected_buses(self, limit: int = 50) -> list[dict[str, Any]]:
        return [
            {
                "bus_id": f"telegram-{chat['id']}",
                "source": "telegram",
                "title": chat["title"],
                "state": "connected",
                "unread_count": chat.get("unread_count", 0),
            }
            for chat in self.list_chats(limit)
        ]

    def search_chats(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        query = query.strip()
        if not query:
            return []
        limit = max(1, min(limit, 50))
        results: dict[int, dict[str, Any]] = {}

        for chat in self.list_chats(100):
            title = str(chat.get("title") or "")
            if query.lower() in title.lower():
                chat_id = int(chat["id"])
                results[chat_id] = {
                    "id": chat_id,
                    "bus_id": f"telegram-{chat_id}",
                    "title": title or str(chat_id),
                    "source": "local",
                    "unread_count": chat.get("unread_count", 0),
                }

        for method_name, params in (
            ("searchChats", {"query": query, "limit": limit}),
            ("searchChatsOnServer", {"query": query, "limit": limit}),
            ("searchPublicChats", {"query": query}),
        ):
            try:
                update = self._call_method(method_name, params, timeout=10)
                for chat_id in _extract_chat_ids(update):
                    if chat_id not in results:
                        results[chat_id] = self._chat_search_result(chat_id, source=method_name)
            except Exception as exc:  # noqa: BLE001 - search should degrade across TDLib methods
                self.log(f"Telegram {method_name} failed: {exc}")

        try:
            update = self._call_method("searchContacts", {"query": query, "limit": limit}, timeout=10)
            for user_id in _extract_user_ids(update):
                try:
                    chat = self._create_private_chat(user_id)
                    chat_id = int(chat.get("id"))
                    if chat_id not in results:
                        results[chat_id] = self._chat_search_result(chat_id, source="searchContacts")
                except Exception as exc:  # noqa: BLE001
                    self.log(f"Telegram createPrivateChat failed for user {user_id}: {exc}")
        except Exception as exc:  # noqa: BLE001
            self.log(f"Telegram searchContacts failed: {exc}")

        return list(results.values())[:limit]

    def resolve_chat_id(self, target: str) -> int:
        raw = target.strip()
        if raw.startswith("telegram-"):
            raw = raw.removeprefix("telegram-")
        if raw.lstrip("-").isdigit():
            return int(raw)
        username = raw.removeprefix("@")
        if not username:
            raise ValueError("Telegram target is empty.")
        update = self._call_method("searchPublicChat", {"username": username}, timeout=10)
        chat_id = _extract_single_chat_id(update)
        if chat_id is None:
            matches = self.search_chats(username, limit=1)
            if not matches:
                raise ValueError(f"Telegram chat not found: {target}")
            chat_id = int(matches[0]["id"])
        return chat_id

    def _require_client(self) -> Any:
        with self._lock:
            if self._tg is None or not self._connected:
                raise RuntimeError("Telegram is not connected.")
            return self._tg

    def _handle_message_update(self, update: dict[str, Any]) -> None:
        message = update.get("message") or {}
        chat_id_raw = message.get("chat_id")
        if chat_id_raw is None:
            return
        try:
            chat_id = int(chat_id_raw)
        except (TypeError, ValueError):
            return

        is_outgoing = bool(message.get("is_outgoing"))
        message_id = message.get("id")
        if not is_outgoing and isinstance(message_id, int):
            self.acknowledge_message(chat_id, message_id)

        text = _extract_message_text(message)
        if not text:
            return
        title = self._chat_title(chat_id)
        sender = "me" if is_outgoing else title
        external_id = _message_external_id(message)
        self.emit(
            MessageEvent(
                source="telegram",
                bus_id=f"telegram-{chat_id}",
                sender=sender,
                text=text,
                timestamp=utc_now(),
                external_id=external_id,
                outbound=is_outgoing,
                meta={"chat_title": title, "raw_chat_id": chat_id},
            )
        )

    def _chat_title(self, chat_id: int) -> str:
        if chat_id in self._chat_cache:
            return self._chat_cache[chat_id]
        try:
            chat = self._get_chat(chat_id)
            title = str(chat.get("title") or chat_id)
        except Exception:
            title = str(chat_id)
        self._chat_cache[chat_id] = title
        return title

    def _get_chat(self, chat_id: int) -> dict[str, Any]:
        tg = self._require_client()
        result = tg.get_chat(chat_id)
        result.wait()
        update = getattr(result, "update", {}) or {}
        return update if isinstance(update, dict) else {}

    def _create_private_chat(self, user_id: int) -> dict[str, Any]:
        update = self._call_method("createPrivateChat", {"user_id": user_id, "force": False}, timeout=10)
        return update if isinstance(update, dict) else {}

    def _chat_search_result(self, chat_id: int, *, source: str) -> dict[str, Any]:
        chat = self._get_chat(chat_id)
        title = str(chat.get("title") or chat_id)
        self._chat_cache[chat_id] = title
        return {
            "id": chat_id,
            "bus_id": f"telegram-{chat_id}",
            "title": title,
            "source": source,
            "type": _chat_type(chat),
            "unread_count": chat.get("unread_count", 0),
        }

    def _call_method(self, method_name: str, params: dict[str, Any], *, timeout: float | None = None) -> Any:
        tg = self._require_client()
        result = tg.call_method(method_name, params=params)
        if timeout is not None:
            result.wait(timeout=timeout, raise_exc=True)
        else:
            result.wait(raise_exc=True)
        return getattr(result, "update", None)

    def _call_method_safe(self, method_name: str, params: dict[str, Any], *, timeout: float | None = None) -> None:
        try:
            self._call_method(method_name, params, timeout=timeout)
        except Exception as exc:  # noqa: BLE001 - best-effort UX/read receipt
            self.log(f"Telegram {method_name} failed: {exc}")


def _extract_message_text(message: dict[str, Any]) -> str:
    content = message.get("content") or {}
    if not isinstance(content, dict):
        return ""

    text = content.get("text")
    if isinstance(text, dict):
        body = text.get("text")
        if isinstance(body, str):
            return body.strip()
    if isinstance(text, str):
        return text.strip()

    caption = content.get("caption")
    if isinstance(caption, dict) and isinstance(caption.get("text"), str):
        return caption["text"].strip()

    kind = content.get("@type") or content.get("_") or content.get("type")
    if isinstance(kind, str):
        return f"[{kind}]"
    return ""


def _common_markdown_to_html(text: str) -> str:
    pattern = re.compile(
        r"(\*\*(?P<bold>[\s\S]+?)\*\*)"
        r"|(__(?P<bold_alt>[\s\S]+?)__)"
        r"|(\*(?P<italic>[^*\n]+?)\*)"
        r"|(_(?P<italic_alt>[^_\n]+?)_)"
        r"|(`(?P<code>[^`\n]+?)`)"
        r"|(~~(?P<strike>[\s\S]+?)~~)"
        r"|(\[(?P<link_text>[^\]\n]+?)\]\((?P<link_url>https?://[^)\s]+)\))"
    )
    out: list[str] = []
    index = 0
    for match in pattern.finditer(text):
        out.append(html.escape(text[index : match.start()]))
        index = match.end()
        if match.group("bold") is not None:
            out.append(f"<b>{html.escape(match.group('bold'))}</b>")
        elif match.group("bold_alt") is not None:
            out.append(f"<b>{html.escape(match.group('bold_alt'))}</b>")
        elif match.group("italic") is not None:
            out.append(f"<i>{html.escape(match.group('italic'))}</i>")
        elif match.group("italic_alt") is not None:
            out.append(f"<i>{html.escape(match.group('italic_alt'))}</i>")
        elif match.group("code") is not None:
            out.append(f"<code>{html.escape(match.group('code'))}</code>")
        elif match.group("strike") is not None:
            out.append(f"<s>{html.escape(match.group('strike'))}</s>")
        elif match.group("link_text") is not None and match.group("link_url") is not None:
            label = html.escape(match.group("link_text"))
            url = html.escape(match.group("link_url"), quote=True)
            out.append(f'<a href="{url}">{label}</a>')
    out.append(html.escape(text[index:]))
    return "".join(out)


def _message_external_id(update: Any) -> str | None:
    if isinstance(update, dict):
        message = update.get("message") if isinstance(update.get("message"), dict) else update
        message_id = message.get("id")
        chat_id = message.get("chat_id")
        if message_id is not None and chat_id is not None:
            return f"{chat_id}:{message_id}"
        if message_id is not None:
            return str(message_id)
    return None


def _extract_chat_ids(update: Any) -> list[int]:
    if not isinstance(update, dict):
        return []
    chat_ids = update.get("chat_ids")
    if isinstance(chat_ids, list):
        return [int(chat_id) for chat_id in chat_ids if str(chat_id).lstrip("-").isdigit()]
    chats = update.get("chats")
    if isinstance(chats, list):
        return [
            int(chat["id"])
            for chat in chats
            if isinstance(chat, dict) and str(chat.get("id")).lstrip("-").isdigit()
        ]
    if str(update.get("id")).lstrip("-").isdigit() and str(update.get("@type") or "").lower().endswith("chat"):
        return [int(update["id"])]
    return []


def _extract_single_chat_id(update: Any) -> int | None:
    chat_ids = _extract_chat_ids(update)
    if chat_ids:
        return chat_ids[0]
    if isinstance(update, dict) and str(update.get("id")).lstrip("-").isdigit():
        return int(update["id"])
    return None


def _extract_user_ids(update: Any) -> list[int]:
    if not isinstance(update, dict):
        return []
    user_ids = update.get("user_ids")
    if isinstance(user_ids, list):
        return [int(user_id) for user_id in user_ids if str(user_id).isdigit()]
    users = update.get("users")
    if isinstance(users, list):
        return [
            int(user["id"])
            for user in users
            if isinstance(user, dict) and str(user.get("id")).isdigit()
        ]
    return []


def _chat_type(chat: dict[str, Any]) -> str:
    chat_type = chat.get("type")
    if isinstance(chat_type, dict):
        return str(chat_type.get("@type") or chat_type.get("type") or "")
    return str(chat_type or "")
