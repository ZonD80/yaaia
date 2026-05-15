from __future__ import annotations

import ast
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import time
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MAX_SCRIPT_OUTPUT_CHARS = 50_000


@dataclass(frozen=True, slots=True)
class ScriptBlock:
    language: str
    code: str
    boundary: str
    index: int

    @property
    def executable(self) -> bool:
        return self.language in {"python", "py"}


@dataclass(frozen=True, slots=True)
class ScriptExecution:
    ok: bool
    stdout: str
    stderr: str
    error: str | None
    routes: list[dict[str, str]]
    duration_seconds: float
    timed_out: bool = False


def extract_script_blocks(text: str) -> list[ScriptBlock]:
    blocks: list[ScriptBlock] = []
    pattern = re.compile(r"\[([a-zA-Z0-9_-]+)=([^\]\n]+)\]([\s\S]*?)\[/\1\]")
    for match in pattern.finditer(text):
        language = _normalize_language(match.group(2))
        if not language:
            continue
        blocks.append(
            ScriptBlock(
                language=language,
                code=match.group(3).strip(),
                boundary=match.group(1),
                index=len(blocks) + 1,
            )
        )
    return blocks


def execute_python_script(
    code: str,
    *,
    history: list[dict[str, Any]],
    buses: list[dict[str, Any]],
    home: Path,
    database_path: Path,
    timeout_seconds: int = 120,
) -> ScriptExecution:
    payload = {
        "code": code,
        "history": history,
        "buses": buses,
        "home": str(home),
        "database_path": str(database_path),
    }
    started = time.monotonic()
    try:
        completed = subprocess.run(
            [sys.executable, "-m", "yaaia.services.script_runner"],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        stdout = _truncate(exc.stdout or "")
        stderr = _truncate(exc.stderr or "")
        return ScriptExecution(
            ok=False,
            stdout=stdout,
            stderr=stderr,
            error=f"Python script timed out after {timeout_seconds}s.",
            routes=[],
            duration_seconds=time.monotonic() - started,
            timed_out=True,
        )

    duration = time.monotonic() - started
    try:
        data = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError:
        return ScriptExecution(
            ok=False,
            stdout=_truncate(completed.stdout),
            stderr=_truncate(completed.stderr),
            error=f"Python runner returned invalid JSON with exit code {completed.returncode}.",
            routes=[],
            duration_seconds=duration,
        )
    if completed.returncode != 0 and not data.get("error"):
        data["error"] = completed.stderr or f"Python runner exited with code {completed.returncode}."
        data["ok"] = False
    routes = data.get("routes") if isinstance(data.get("routes"), list) else []
    clean_routes = [
        {"bus_id": str(route.get("bus_id")), "content": str(route.get("content"))}
        for route in routes
        if isinstance(route, dict) and route.get("bus_id") and route.get("content") is not None
    ]
    return ScriptExecution(
        ok=bool(data.get("ok")),
        stdout=_truncate(str(data.get("stdout") or "")),
        stderr=_truncate(str(data.get("stderr") or "")),
        error=str(data["error"]) if data.get("error") else None,
        routes=clean_routes,
        duration_seconds=duration,
    )


def _normalize_language(raw: str) -> str | None:
    language = raw.strip().lower()
    if language in {"python", "py", "ts", "typescript", "javascript", "js", "bash", "sh"}:
        return language
    if language.startswith("vm-bash:"):
        return "vm-bash"
    if language.startswith("bash:"):
        return "bash"
    return None


def _run_payload(payload: dict[str, Any]) -> dict[str, Any]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    routes: list[dict[str, str]] = []
    history_items = payload.get("history") if isinstance(payload.get("history"), list) else []
    bus_items = payload.get("buses") if isinstance(payload.get("buses"), list) else []
    home = Path(str(payload.get("home") or Path.home() / "yaaia")).expanduser()
    database_path = Path(str(payload.get("database_path") or home / "data" / "messages.sqlite3")).expanduser()

    from ..schedules import consume_due_schedules, create_schedule, delete_schedule, list_schedules, update_schedule
    from ..storage import MessageStore
    from .addressbook import AddressBookStore
    from .secrets import SecretsStore

    message_store = MessageStore(database_path)
    addressbook = AddressBookStore(database_path, home)
    secrets = SecretsStore(home)

    def send(bus_id: str, content: object) -> None:
        route = {"bus_id": str(bus_id), "content": str(content)}
        routes.append(route)
        print(f"{route['bus_id']}:{route['content']}")

    def root(content: object) -> None:
        send("root", content)

    def call(command: object) -> None:
        send("call", command)

    def email(
        to: object,
        subject: object,
        body: object,
        cc: object = "",
        bcc: object = "",
        html: object = "",
        attachments: object = "",
    ) -> None:
        send("email", _email_route_payload(to, subject, body, cc=cc, bcc=bcc, html=html, attachments=attachments))

    def reply_email(
        bus_id: object,
        body: object,
        subject: object = "",
        cc: object = "",
        bcc: object = "",
        html: object = "",
        attachments: object = "",
    ) -> None:
        send(str(bus_id), _email_route_payload("", subject, body, cc=cc, bcc=bcc, html=html, attachments=attachments))

    def telegram_search(query: object, limit: int = 20) -> None:
        send("telegram-search", f"{query} | {limit}")

    def telegram_resolve(target: object) -> None:
        send("telegram-resolve", target)

    def history(bus_id: str = "root", limit: int = 50) -> list[dict[str, Any]]:
        selected = [item for item in history_items if isinstance(item, dict) and item.get("bus_id") == bus_id]
        return selected[-max(1, min(int(limit), 500)) :]

    def buses() -> list[dict[str, Any]]:
        return [item for item in bus_items if isinstance(item, dict)]

    def forgotten_buses() -> list[dict[str, str]]:
        return message_store.list_forgotten_buses()

    def forget_bus(bus_id: str, reason: str = "script") -> dict[str, Any]:
        result = message_store.forget_bus(bus_id, reason=reason)
        result["contacts_updated"] = addressbook.remove_bus(bus_id)
        return result

    def restore_bus(bus_id: str) -> bool:
        return message_store.restore_bus(bus_id)

    def schedule_create(
        title: str,
        instructions: str,
        at: str,
        repeat: str = "",
        bus_id: str = "root",
    ) -> dict[str, Any]:
        return create_schedule(home, title=title, instructions=instructions, at=at, repeat=repeat, bus_id=bus_id)

    def schedules_list(include_disabled: bool = True) -> list[dict[str, Any]]:
        return list_schedules(home, include_disabled=include_disabled)

    def schedule_update(schedule_id: str, **updates: Any) -> dict[str, Any]:
        return update_schedule(home, schedule_id, **updates)

    def schedule_delete(schedule_id: str) -> bool:
        return delete_schedule(home, schedule_id)

    def schedule_run_due() -> list[dict[str, Any]]:
        return consume_due_schedules(home)

    def contacts_list() -> list[dict[str, Any]]:
        return [contact.to_dict() for contact in addressbook.list()]

    def contacts_search(query: str) -> list[dict[str, Any]]:
        return [contact.to_dict() for contact in addressbook.search(query)]

    def contact_get(id_or_identifier: str) -> dict[str, Any] | None:
        contact = addressbook.get(id_or_identifier)
        return contact.to_dict() if contact else None

    def contact_create(
        name: str,
        identifier: str,
        trust_level: str = "normal",
        bus_ids: list[str] | None = None,
        notes: str = "",
    ) -> str:
        return addressbook.create(
            name=name,
            identifier=identifier,
            trust_level=trust_level,
            bus_ids=bus_ids or [],
            notes=notes,
        )

    def contact_update(id_or_identifier: str, **updates: Any) -> None:
        addressbook.update(id_or_identifier, **updates)

    def contact_delete(id_or_identifier: str) -> bool:
        return addressbook.delete(id_or_identifier)

    def contact_is_trusted(bus_id: str, sender_email: str | None = None) -> bool:
        return addressbook.is_trusted(bus_id, sender_email)

    def secrets_list() -> list[dict[str, str]]:
        return secrets.list()

    def secret_get(description_or_uuid: str, raw: bool = False) -> str | None:
        return secrets.get(description_or_uuid, raw=raw)

    def secret_set(description: str, type: str, value: str, force: bool = False) -> str:
        return secrets.set(description=description, type=type, value=value, force=force)

    def secret_delete(description_or_uuid: str) -> bool:
        return secrets.delete(description_or_uuid)

    namespace: dict[str, Any] = {
        "__name__": "__yaaia_script__",
        "buses": buses,
        "call": call,
        "contact_create": contact_create,
        "contact_delete": contact_delete,
        "contact_get": contact_get,
        "contact_is_trusted": contact_is_trusted,
        "contact_update": contact_update,
        "contacts_list": contacts_list,
        "contacts_search": contacts_search,
        "datetime": datetime,
        "email": email,
        "forget_bus": forget_bus,
        "forgotten_buses": forgotten_buses,
        "history": history,
        "json": json,
        "os": os,
        "Path": Path,
        "re": re,
        "root": root,
        "reply_email": reply_email,
        "restore_bus": restore_bus,
        "schedule_create": schedule_create,
        "schedule_delete": schedule_delete,
        "schedule_run_due": schedule_run_due,
        "schedule_update": schedule_update,
        "schedules_list": schedules_list,
        "secret_delete": secret_delete,
        "secret_get": secret_get,
        "secret_set": secret_set,
        "secrets_list": secrets_list,
        "send": send,
        "timezone": timezone,
        "telegram_resolve": telegram_resolve,
        "telegram_search": telegram_search,
    }

    started = time.monotonic()
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            _exec_with_last_expression(str(payload.get("code") or ""), namespace)
        ok = True
        error = None
    except Exception as exc:  # noqa: BLE001 - returned to agent as execution result
        ok = False
        error = f"{exc}\n{traceback.format_exc()}"
    try:
        return {
            "ok": ok,
            "stdout": _truncate(stdout.getvalue()),
            "stderr": _truncate(stderr.getvalue()),
            "error": _truncate(error or ""),
            "routes": routes,
            "duration_seconds": time.monotonic() - started,
        }
    finally:
        message_store.close()
        addressbook.close()


def _exec_with_last_expression(code: str, namespace: dict[str, Any]) -> None:
    tree = ast.parse(code, filename="<yaaia-python>", mode="exec")
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last_expr = ast.Expression(tree.body.pop().value)
        ast.fix_missing_locations(tree)
        ast.fix_missing_locations(last_expr)
        if tree.body:
            exec(compile(tree, "<yaaia-python>", "exec"), namespace, namespace)
        value = eval(compile(last_expr, "<yaaia-python>", "eval"), namespace, namespace)
        if value is not None:
            print(repr(value))
        return
    exec(compile(tree, "<yaaia-python>", "exec"), namespace, namespace)


def _truncate(value: str, limit: int = MAX_SCRIPT_OUTPUT_CHARS) -> str:
    if len(value) <= limit:
        return value
    omitted = len(value) - limit
    return value[:limit] + f"\n... <truncated {omitted} chars>"


def _email_route_payload(
    to: object,
    subject: object,
    body: object,
    *,
    cc: object = "",
    bcc: object = "",
    html: object = "",
    attachments: object = "",
) -> str:
    lines: list[str] = []
    if str(to).strip():
        lines.append(f"to: {to}")
    if str(cc).strip():
        lines.append(f"cc: {cc}")
    if str(bcc).strip():
        lines.append(f"bcc: {bcc}")
    if str(subject).strip():
        lines.append(f"subject: {subject}")
    if str(html).strip():
        lines.append(f"html: {html}")
    attachment_text = _email_attachment_text(attachments)
    if attachment_text:
        lines.append(f"attachments: {attachment_text}")
    lines.append("")
    lines.append(str(body))
    return "\n".join(lines).strip()


def _email_attachment_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple, set)):
        return ", ".join(str(item) for item in value if str(item).strip())
    return str(value).strip()


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if not isinstance(payload, dict):
            raise ValueError("Payload must be an object.")
        result = _run_payload(payload)
    except Exception as exc:  # noqa: BLE001
        result = {
            "ok": False,
            "stdout": "",
            "stderr": "",
            "error": f"{exc}\n{traceback.format_exc()}",
            "routes": [],
            "duration_seconds": 0,
        }
    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
