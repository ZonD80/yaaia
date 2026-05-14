from __future__ import annotations

import base64
import mimetypes
import re
import threading
from collections.abc import Callable, Sequence
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import getaddresses, parseaddr
from pathlib import Path
from typing import Any

from ..config import GoogleConfig
from ..events import MessageEvent, parse_timestamp, utc_now
from ..storage import MessageStore

Emit = Callable[[MessageEvent], None]
Log = Callable[[str], None]

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
]


class GoogleWorkspaceService:
    def __init__(self, config: GoogleConfig, store: MessageStore, emit: Emit, log: Log) -> None:
        self.config = config
        self.store = store
        self.emit = emit
        self.log = log
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_error: str | None = None

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    @property
    def last_error(self) -> str | None:
        return self._last_error

    def start(self) -> None:
        if not self.config.enabled:
            self.log("Google disabled. Put credentials at ~/yaaia/google/credentials.json or set YAAIA_GOOGLE_ENABLED=1.")
            return
        if not self.config.credentials_path.exists() and not self.config.token_path.exists():
            self.log(f"Google not started: missing credentials file {self.config.credentials_path}.")
            return
        if not self.is_authorized():
            self.log("Google not authorized. Run command: google auth")
            return
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._poll_loop, name="yaaia-google-poll", daemon=True)
        self._thread.start()
        self.log(f"Google polling started every {self.config.poll_seconds}s.")

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)

    def is_authorized(self) -> bool:
        return self.config.token_path.exists()

    def authorize(self) -> None:
        try:
            from google_auth_oauthlib.flow import InstalledAppFlow
        except ImportError as exc:
            raise RuntimeError(f"Google OAuth libraries are not installed: {exc}") from exc
        if not self.config.credentials_path.exists():
            raise RuntimeError(f"Google credentials file not found: {self.config.credentials_path}")

        self.config.token_path.parent.mkdir(parents=True, exist_ok=True)
        if self.config.token_path.exists():
            self.config.token_path.unlink()
        flow = InstalledAppFlow.from_client_secrets_file(str(self.config.credentials_path), SCOPES)
        self.log("Opening Google OAuth in your browser. If it does not open, copy the printed URL.")
        creds = flow.run_local_server(
            port=0,
            authorization_prompt_message="Open this URL to authorize YAAIA:\n{url}\n",
            success_message="YAAIA Google authorization complete. You can close this tab.",
            open_browser=True,
            access_type="offline",
            prompt="consent",
        )
        self.config.token_path.write_text(creds.to_json(), encoding="utf-8")
        self.log(f"Google token saved to {self.config.token_path}.")

    def poll_once(self) -> None:
        creds = self._credentials()
        if self.config.gmail_enabled:
            self._poll_gmail(creds)
        if self.config.calendar_enabled:
            self._poll_calendar(creds)

    def send_email(
        self,
        to: str | Sequence[str],
        subject: str,
        body: str,
        *,
        cc: str | Sequence[str] | None = None,
        bcc: str | Sequence[str] | None = None,
        html_body: str | None = None,
        attachments: Sequence[Path] | None = None,
        thread_id: str | None = None,
        in_reply_to: str | None = None,
        references: str | None = None,
        bus_id: str | None = None,
    ) -> str:
        from googleapiclient.discovery import build

        creds = self._credentials()
        service = build("gmail", "v1", credentials=creds)
        message = _build_email_message(
            to=to,
            subject=subject,
            body=body,
            cc=cc,
            bcc=bcc,
            html_body=html_body,
            attachments=attachments,
            in_reply_to=in_reply_to,
            references=references,
        )
        encoded = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")
        payload: dict[str, Any] = {"raw": encoded}
        if thread_id:
            payload["threadId"] = thread_id
        sent = service.users().messages().send(userId="me", body=payload).execute()
        message_id = str(sent.get("id") or "")
        to_display = _address_header(to)
        self.emit(
            MessageEvent(
                source="gmail",
                bus_id=bus_id or f"gmail-{_sanitize(to_display)}",
                sender="me",
                text=f"[Sent email] To: {to_display} | Subject: {subject}",
                timestamp=utc_now(),
                external_id=f"sent:{message_id}" if message_id else None,
                outbound=True,
                meta={
                    "to": to_display,
                    "cc": _address_header(cc) if cc else "",
                    "subject": subject,
                    "thread_id": str(sent.get("threadId") or thread_id or ""),
                    "has_html": bool(html_body),
                    "attachments": [path.name for path in attachments or []],
                },
            )
        )
        return message_id

    def reply_to_last_email(
        self,
        bus_id: str,
        body: str,
        *,
        subject: str | None = None,
        cc: str | Sequence[str] | None = None,
        bcc: str | Sequence[str] | None = None,
        html_body: str | None = None,
        attachments: Sequence[Path] | None = None,
    ) -> str:
        event = self._last_incoming_email(bus_id)
        if event is None:
            raise RuntimeError(f"No inbound Gmail message found for {bus_id}. Use email:<to> | <subject> | <body>.")
        reply_to = _reply_address(event)
        if not reply_to:
            raise RuntimeError(f"Could not determine reply recipient for {bus_id}.")
        original_subject = str(event.meta.get("subject") or _subject_from_text(event.text) or "")
        message_id_header = str(event.meta.get("message_id_header") or "")
        references = _reply_references(str(event.meta.get("references") or ""), message_id_header)
        return self.send_email(
            reply_to,
            subject or _reply_subject(original_subject),
            body,
            cc=cc,
            bcc=bcc,
            html_body=html_body,
            attachments=attachments,
            thread_id=str(event.meta.get("thread_id") or "") or None,
            in_reply_to=message_id_header or None,
            references=references or None,
            bus_id=bus_id,
        )

    def list_connected_buses(self, limit: int = 50) -> list[dict[str, Any]]:
        from googleapiclient.discovery import build

        creds = self._credentials()
        buses: list[dict[str, Any]] = []
        if self.config.gmail_enabled:
            service = build("gmail", "v1", credentials=creds)
            profile = service.users().getProfile(userId="me").execute()
            email = profile.get("emailAddress") or "me"
            buses.append(
                {
                    "bus_id": f"gmail-{_sanitize(email)}",
                    "source": "gmail",
                    "title": f"Gmail: {email}",
                    "state": "polling" if self.running else "authorized",
                }
            )
        if self.config.calendar_enabled:
            service = build("calendar", "v3", credentials=creds)
            calendars = service.calendarList().list(maxResults=max(1, min(limit, 250))).execute().get("items", [])
            for calendar in calendars:
                calendar_id = calendar.get("id")
                if not calendar_id:
                    continue
                buses.append(
                    {
                        "bus_id": f"calendar-{_sanitize(calendar_id)}",
                        "source": "calendar",
                        "title": f"Calendar: {calendar.get('summary') or calendar_id}",
                        "state": "polling" if self.running else "authorized",
                    }
                )
        return buses

    def _credentials(self) -> Any:
        try:
            from google.auth.transport.requests import Request
            from google.oauth2.credentials import Credentials
        except ImportError as exc:
            raise RuntimeError(f"Google API libraries are not installed: {exc}") from exc

        if not self.config.token_path.exists():
            raise RuntimeError("Google is not authorized. Run command: google auth")
        creds = Credentials.from_authorized_user_file(str(self.config.token_path), SCOPES)
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                self.config.token_path.write_text(creds.to_json(), encoding="utf-8")
            except Exception as exc:  # noqa: BLE001 - normalize auth failure for TUI
                self.config.token_path.unlink(missing_ok=True)
                raise RuntimeError(f"Google token refresh failed. Run `google auth` to reauthorize in the browser. {exc}") from exc
        if not creds or not creds.valid:
            raise RuntimeError("Google token is invalid. Run command: google auth")
        return creds

    def _poll_loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.poll_once()
                self._last_error = None
            except Exception as exc:  # noqa: BLE001 - service boundary reports failures to TUI
                self._last_error = str(exc)
                self.log(f"Google poll failed: {exc}")
            self._stop.wait(max(10, self.config.poll_seconds))

    def _poll_gmail(self, creds: Any) -> None:
        from googleapiclient.discovery import build

        service = build("gmail", "v1", credentials=creds)
        profile = service.users().getProfile(userId="me").execute()
        email = profile.get("emailAddress") or "me"
        bus_id = f"gmail-{_sanitize(email)}"
        result = (
            service.users()
            .messages()
            .list(userId="me", labelIds=["INBOX"], maxResults=50)
            .execute()
        )
        for item in result.get("messages", []):
            message_id = item.get("id")
            if not message_id or self.store.seen("gmail", bus_id, message_id):
                continue
            full = (
                service.users()
                .messages()
                .get(
                    userId="me",
                    id=message_id,
                    format="metadata",
                    metadataHeaders=["From", "Reply-To", "Subject", "Date", "Message-ID", "References", "To", "Cc"],
                )
                .execute()
            )
            headers = {
                h.get("name", "").lower(): h.get("value", "")
                for h in (full.get("payload") or {}).get("headers", [])
            }
            sender = headers.get("from") or "Gmail"
            subject = headers.get("subject") or "(no subject)"
            snippet = (full.get("snippet") or "").replace("\n", " ").strip()
            timestamp = _gmail_timestamp(full)
            self.emit(
                MessageEvent(
                    source="gmail",
                    bus_id=bus_id,
                    sender=sender,
                    text=f"[Email] {subject} | {snippet}",
                    timestamp=timestamp,
                    external_id=message_id,
                    meta={
                        "subject": subject,
                        "from": sender,
                        "reply_to": headers.get("reply-to") or "",
                        "to": headers.get("to") or "",
                        "cc": headers.get("cc") or "",
                        "message_id_header": headers.get("message-id") or "",
                        "references": headers.get("references") or "",
                        "thread_id": str(full.get("threadId") or ""),
                        "gmail_message_id": message_id,
                    },
                )
            )

    def _last_incoming_email(self, bus_id: str) -> MessageEvent | None:
        for event in reversed(self.store.recent_bus(bus_id, 100)):
            if event.source == "gmail" and not event.outbound:
                return event
        return None

    def _poll_calendar(self, creds: Any) -> None:
        from googleapiclient.discovery import build

        service = build("calendar", "v3", credentials=creds)
        now = datetime.now(timezone.utc)
        time_min = (now - timedelta(hours=12)).isoformat()
        time_max = (now + timedelta(days=30)).isoformat()
        calendars = service.calendarList().list().execute().get("items", [])
        for calendar in calendars:
            calendar_id = calendar.get("id")
            if not calendar_id:
                continue
            summary = calendar.get("summary") or calendar_id
            bus_id = f"calendar-{_sanitize(calendar_id)}"
            events = (
                service.events()
                .list(
                    calendarId=calendar_id,
                    timeMin=time_min,
                    timeMax=time_max,
                    singleEvents=True,
                    orderBy="startTime",
                    maxResults=50,
                )
                .execute()
                .get("items", [])
            )
            for event in events:
                event_id = event.get("id")
                if not event_id or self.store.seen("calendar", bus_id, event_id):
                    continue
                start = (event.get("start") or {}).get("dateTime") or (event.get("start") or {}).get("date") or ""
                end = (event.get("end") or {}).get("dateTime") or (event.get("end") or {}).get("date") or ""
                title = event.get("summary") or "(no title)"
                location = event.get("location") or ""
                suffix = f" | Location: {location}" if location else ""
                self.emit(
                    MessageEvent(
                        source="calendar",
                        bus_id=bus_id,
                        sender=summary,
                        text=f"[Calendar] {title} | Start: {start} | End: {end}{suffix}",
                        timestamp=parse_timestamp(event.get("updated") or event.get("created")),
                        external_id=event_id,
                        meta={"calendar_id": calendar_id, "event_id": event_id},
                    )
                )


def _gmail_timestamp(message: dict[str, Any]) -> datetime:
    raw = message.get("internalDate")
    if raw:
        try:
            return datetime.fromtimestamp(int(raw) / 1000, tz=timezone.utc)
        except (TypeError, ValueError):
            pass
    return utc_now()


def _sanitize(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in value)
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-") or "default"


def _build_email_message(
    *,
    to: str | Sequence[str],
    subject: str,
    body: str,
    cc: str | Sequence[str] | None = None,
    bcc: str | Sequence[str] | None = None,
    html_body: str | None = None,
    attachments: Sequence[Path] | None = None,
    in_reply_to: str | None = None,
    references: str | None = None,
) -> EmailMessage:
    if not _address_header(to):
        raise ValueError("Email recipient is required.")
    message = EmailMessage()
    message["To"] = _address_header(to)
    if cc:
        message["Cc"] = _address_header(cc)
    if bcc:
        message["Bcc"] = _address_header(bcc)
    message["Subject"] = subject.strip() or "(no subject)"
    if in_reply_to:
        message["In-Reply-To"] = in_reply_to.strip()
    if references:
        message["References"] = references.strip()

    if html_body:
        message.set_content(body.strip() or _html_to_text(html_body))
        message.add_alternative(html_body, subtype="html")
    else:
        message.set_content(body)

    for path in attachments or []:
        expanded = path.expanduser()
        if not expanded.exists() or not expanded.is_file():
            raise FileNotFoundError(expanded)
        ctype, _ = mimetypes.guess_type(str(expanded))
        maintype, subtype = (ctype or "application/octet-stream").split("/", 1)
        message.add_attachment(expanded.read_bytes(), maintype=maintype, subtype=subtype, filename=expanded.name)
    return message


def _address_header(value: str | Sequence[str] | None) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return ", ".join(str(item).strip() for item in value if str(item).strip())


def _reply_address(event: MessageEvent) -> str:
    raw = str(event.meta.get("reply_to") or event.meta.get("from") or event.sender or "")
    addresses = getaddresses([raw])
    for _, address in addresses:
        if address:
            return address
    return parseaddr(raw)[1] or raw.strip()


def _reply_subject(subject: str) -> str:
    subject = subject.strip() or "(no subject)"
    return subject if subject.lower().startswith("re:") else f"Re: {subject}"


def _reply_references(existing: str, message_id_header: str) -> str:
    parts = [part for part in existing.split() if part]
    if message_id_header and message_id_header not in parts:
        parts.append(message_id_header)
    return " ".join(parts)


def _subject_from_text(text: str) -> str:
    match = re.match(r"\[Email\]\s*(.*?)\s*\|", text)
    return match.group(1).strip() if match else ""


def _html_to_text(value: str) -> str:
    text = re.sub(r"<(br|p|div|li)\b[^>]*>", "\n", value, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()
