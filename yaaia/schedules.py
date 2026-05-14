from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_STARTUP_TASK = {
    "title": "On duty",
    "instructions": (
        "Get my identity, connect to telegram, check new mail, report to user that i'm on duty. "
        "If any scheduled tasks were due while the app was closed, resume and complete them first."
    ),
}


@dataclass(frozen=True, slots=True)
class StartupCommand:
    title: str
    instructions: str
    due_schedules: list[dict[str, Any]]

    @property
    def text(self) -> str:
        content = f"[Startup task]\n\nTitle: {self.title}\nInstructions: {self.instructions}"
        if self.due_schedules:
            content += (
                "\n\n--- Resume: complete these scheduled tasks (were due while the app was closed) ---\n\n"
                f"{build_schedule_message(self.due_schedules)}"
            )
        return content


def schedules_path(home: Path) -> Path:
    return home / "schedules.json"


def get_startup_command(home: Path) -> StartupCommand:
    data = _load_file(home)
    startup = data.get("startup_task") if isinstance(data.get("startup_task"), dict) else DEFAULT_STARTUP_TASK
    return StartupCommand(
        title=str(startup.get("title") or DEFAULT_STARTUP_TASK["title"]),
        instructions=str(startup.get("instructions") or DEFAULT_STARTUP_TASK["instructions"]),
        due_schedules=_due_schedules(data),
    )


def set_startup_command(home: Path, *, title: str, instructions: str) -> None:
    data = _load_file(home)
    data["startup_task"] = {"title": title, "instructions": instructions}
    _save_file(home, data)


def consume_due_schedules(home: Path) -> list[dict[str, Any]]:
    data = _load_file(home)
    due = _due_schedules(data)
    if not due:
        return []
    due_ids = {str(item.get("id")) for item in due if item.get("id") is not None}
    items = data.get("items") if isinstance(data.get("items"), list) else []
    data["items"] = [item for item in items if str(item.get("id")) not in due_ids]
    _save_file(home, data)
    return due


def build_schedule_message(schedules: list[dict[str, Any]]) -> str:
    from .events import utc_now

    now = utc_now().isoformat()
    if len(schedules) == 1:
        schedule = schedules[0]
        return "\n".join(
            [
                "[Scheduled task]",
                "",
                f"Current time: {now}",
                f"Scheduled for: {schedule.get('at', '')}",
                "",
                f"Title: {schedule.get('title', '')}",
                f"Instructions: {schedule.get('instructions', '')}",
            ]
        )
    lines = [
        "[Scheduled tasks - missed while app was closed]",
        "",
        f"Current time: {now}",
        "",
    ]
    for index, schedule in enumerate(schedules, start=1):
        lines.extend(
            [
                f"--- Task {index} ---",
                f"Scheduled for: {schedule.get('at', '')}",
                f"Title: {schedule.get('title', '')}",
                f"Instructions: {schedule.get('instructions', '')}",
                "",
            ]
        )
    return "\n".join(lines).rstrip()


def _load_file(home: Path) -> dict[str, Any]:
    path = schedules_path(home)
    if not path.exists():
        return {"v": 1, "items": [], "startup_task": DEFAULT_STARTUP_TASK}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"v": 1, "items": [], "startup_task": DEFAULT_STARTUP_TASK}
    if not isinstance(raw, dict):
        return {"v": 1, "items": [], "startup_task": DEFAULT_STARTUP_TASK}
    raw.setdefault("v", 1)
    raw.setdefault("items", [])
    raw.setdefault("startup_task", DEFAULT_STARTUP_TASK)
    return raw


def _save_file(home: Path, data: dict[str, Any]) -> None:
    path = schedules_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"v": 1, **data}, indent=2) + "\n", encoding="utf-8")


def _due_schedules(data: dict[str, Any]) -> list[dict[str, Any]]:
    from .events import utc_now

    now = utc_now().isoformat()
    items = data.get("items") if isinstance(data.get("items"), list) else []
    due = [item for item in items if isinstance(item, dict) and str(item.get("at") or "") <= now]
    return sorted(due, key=lambda item: str(item.get("at") or ""))
