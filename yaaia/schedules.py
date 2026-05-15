from __future__ import annotations

import calendar
import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .events import parse_timestamp, utc_now

DEFAULT_STARTUP_TASK = {
    "title": "On duty",
    "instructions": (
        "Get my identity, connect to telegram, check new mail, report to user that i'm on duty. "
        "If any scheduled tasks were due while the app was closed, resume and complete them first."
    ),
}

REPEAT_NONE = {"", "none", "off", "false", "0"}


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


def create_schedule(
    home: Path,
    *,
    title: str,
    instructions: str,
    at: str | datetime,
    repeat: str = "",
    bus_id: str = "root",
) -> dict[str, Any]:
    data = _load_file(home)
    now = utc_now()
    item = {
        "id": str(uuid.uuid4()),
        "title": title.strip() or "Scheduled task",
        "instructions": instructions.strip(),
        "at": parse_schedule_time(at, now=now).isoformat(),
        "repeat": _normalize_repeat(repeat),
        "bus_id": bus_id.strip() or "root",
        "enabled": True,
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
    }
    data["items"] = [*_items(data), item]
    _save_file(home, data)
    return dict(item)


def list_schedules(home: Path, *, include_disabled: bool = True) -> list[dict[str, Any]]:
    items = _items(_load_file(home))
    if not include_disabled:
        items = [item for item in items if bool(item.get("enabled", True))]
    return sorted(items, key=lambda item: str(item.get("at") or ""))


def update_schedule(home: Path, schedule_id: str, **updates: Any) -> dict[str, Any]:
    data = _load_file(home)
    items = _items(data)
    now = utc_now()
    for item in items:
        if str(item.get("id")) != schedule_id:
            continue
        if updates.get("title") is not None:
            item["title"] = str(updates["title"]).strip() or item.get("title") or "Scheduled task"
        if updates.get("instructions") is not None:
            item["instructions"] = str(updates["instructions"]).strip()
        if updates.get("at") is not None:
            item["at"] = parse_schedule_time(updates["at"], now=now).isoformat()
        if updates.get("repeat") is not None:
            item["repeat"] = _normalize_repeat(str(updates["repeat"]))
        if updates.get("bus_id") is not None:
            item["bus_id"] = str(updates["bus_id"]).strip() or "root"
        if updates.get("enabled") is not None:
            item["enabled"] = _coerce_bool(updates["enabled"])
        item["updated_at"] = now.isoformat()
        data["items"] = items
        _save_file(home, data)
        return dict(item)
    raise ValueError(f"Schedule not found: {schedule_id}")


def delete_schedule(home: Path, schedule_id: str) -> bool:
    data = _load_file(home)
    items = _items(data)
    kept = [item for item in items if str(item.get("id")) != schedule_id]
    if len(kept) == len(items):
        return False
    data["items"] = kept
    _save_file(home, data)
    return True


def consume_due_schedules(home: Path) -> list[dict[str, Any]]:
    data = _load_file(home)
    due = _due_schedules(data)
    if not due:
        return []
    now = utc_now()
    due_ids = {str(item.get("id")) for item in due if item.get("id") is not None}
    next_items: list[dict[str, Any]] = []
    for item in _items(data):
        if str(item.get("id")) not in due_ids:
            next_items.append(item)
            continue
        repeat = _normalize_repeat(str(item.get("repeat") or ""))
        if repeat.lower() in REPEAT_NONE:
            continue
        next_at = _next_repeat_at(parse_timestamp(str(item.get("at") or "")), repeat, now)
        item = {**item, "at": next_at.isoformat(), "updated_at": now.isoformat(), "last_run_at": now.isoformat()}
        next_items.append(item)
    data["items"] = next_items
    _save_file(home, data)
    return due


def build_schedule_message(schedules: list[dict[str, Any]]) -> str:
    now = utc_now().isoformat()
    if len(schedules) == 1:
        schedule = schedules[0]
        return "\n".join(
            [
                "[Scheduled task]",
                "",
                f"Current time: {now}",
                f"Scheduled for: {schedule.get('at', '')}",
                f"Repeat: {schedule.get('repeat', '') or 'none'}",
                f"Bus: {schedule.get('bus_id', 'root')}",
                "",
                f"Title: {schedule.get('title', '')}",
                f"Instructions: {schedule.get('instructions', '')}",
            ]
        )
    lines = [
        "[Scheduled tasks]",
        "",
        f"Current time: {now}",
        "",
    ]
    for index, schedule in enumerate(schedules, start=1):
        lines.extend(
            [
                f"--- Task {index} ---",
                f"Scheduled for: {schedule.get('at', '')}",
                f"Repeat: {schedule.get('repeat', '') or 'none'}",
                f"Bus: {schedule.get('bus_id', 'root')}",
                f"Title: {schedule.get('title', '')}",
                f"Instructions: {schedule.get('instructions', '')}",
                "",
            ]
        )
    return "\n".join(lines).rstrip()


def parse_schedule_time(value: str | datetime, *, now: datetime | None = None) -> datetime:
    current = now or utc_now()
    if isinstance(value, datetime):
        parsed = value
    else:
        raw = str(value).strip()
        relative = _parse_relative_time(raw, current)
        if relative is not None:
            return relative
        parsed = _parse_absolute_time(raw)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.now().astimezone().tzinfo)
    return parsed.astimezone(timezone.utc)


def _load_file(home: Path) -> dict[str, Any]:
    path = schedules_path(home)
    if not path.exists():
        return {"v": 2, "items": [], "startup_task": DEFAULT_STARTUP_TASK}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"v": 2, "items": [], "startup_task": DEFAULT_STARTUP_TASK}
    if not isinstance(raw, dict):
        return {"v": 2, "items": [], "startup_task": DEFAULT_STARTUP_TASK}
    raw.setdefault("v", 2)
    raw.setdefault("items", [])
    raw.setdefault("startup_task", DEFAULT_STARTUP_TASK)
    raw["items"] = [_normalize_item(item) for item in raw.get("items", []) if isinstance(item, dict)]
    return raw


def _save_file(home: Path, data: dict[str, Any]) -> None:
    path = schedules_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"v": 2, **data}, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _items(data: dict[str, Any]) -> list[dict[str, Any]]:
    items = data.get("items") if isinstance(data.get("items"), list) else []
    return [_normalize_item(item) for item in items if isinstance(item, dict)]


def _normalize_item(item: dict[str, Any]) -> dict[str, Any]:
    schedule_id = str(item.get("id") or uuid.uuid4())
    at = parse_timestamp(str(item.get("at") or utc_now().isoformat())).isoformat()
    return {
        "id": schedule_id,
        "title": str(item.get("title") or "Scheduled task"),
        "instructions": str(item.get("instructions") or ""),
        "at": at,
        "repeat": _normalize_repeat(str(item.get("repeat") or "")),
        "bus_id": str(item.get("bus_id") or "root"),
        "enabled": _coerce_bool(item.get("enabled", True)),
        "created_at": str(item.get("created_at") or utc_now().isoformat()),
        "updated_at": str(item.get("updated_at") or item.get("created_at") or utc_now().isoformat()),
        **({"last_run_at": str(item["last_run_at"])} if item.get("last_run_at") else {}),
    }


def _due_schedules(data: dict[str, Any]) -> list[dict[str, Any]]:
    now = utc_now()
    due = [
        item
        for item in _items(data)
        if bool(item.get("enabled", True)) and parse_timestamp(str(item.get("at") or "")) <= now
    ]
    return sorted(due, key=lambda item: str(item.get("at") or ""))


def _normalize_repeat(value: str) -> str:
    repeat = value.strip().lower()
    if repeat in REPEAT_NONE:
        return ""
    aliases = {
        "hour": "hourly",
        "1h": "hourly",
        "day": "daily",
        "1d": "daily",
        "week": "weekly",
        "1w": "weekly",
        "month": "monthly",
        "1mo": "monthly",
    }
    repeat = aliases.get(repeat, repeat)
    if repeat in {"hourly", "daily", "weekly", "monthly"}:
        return repeat
    if _parse_duration(repeat) is not None:
        return repeat
    raise ValueError("repeat must be empty, hourly, daily, weekly, monthly, or a duration like 6h/2d/30m")


def _next_repeat_at(previous: datetime, repeat: str, now: datetime) -> datetime:
    next_at = previous
    while next_at <= now:
        if repeat == "hourly":
            next_at += timedelta(hours=1)
        elif repeat == "daily":
            next_at += timedelta(days=1)
        elif repeat == "weekly":
            next_at += timedelta(weeks=1)
        elif repeat == "monthly":
            next_at = _add_month(next_at)
        else:
            duration = _parse_duration(repeat)
            if duration is None:
                raise ValueError(f"Invalid repeat: {repeat}")
            next_at += duration
    return next_at


def _add_month(value: datetime) -> datetime:
    month = value.month + 1
    year = value.year + (month - 1) // 12
    month = ((month - 1) % 12) + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return value.replace(year=year, month=month, day=day)


def _parse_relative_time(raw: str, now: datetime) -> datetime | None:
    match = re.fullmatch(r"(?:in\s+)?(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)", raw, re.I)
    if not match:
        return None
    amount = int(match.group(1))
    unit = match.group(2).lower()
    if unit.startswith(("second", "sec", "s")):
        return now + timedelta(seconds=amount)
    if unit.startswith(("minute", "min", "m")):
        return now + timedelta(minutes=amount)
    if unit.startswith(("hour", "hr", "h")):
        return now + timedelta(hours=amount)
    if unit.startswith(("day", "d")):
        return now + timedelta(days=amount)
    return now + timedelta(weeks=amount)


def _parse_absolute_time(raw: str) -> datetime:
    normalized = raw.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                return datetime.strptime(raw, fmt)
            except ValueError:
                continue
    raise ValueError("Use ISO time, `YYYY-MM-DD HH:MM`, or relative time like `in 10m`.")


def _parse_duration(raw: str) -> timedelta | None:
    match = re.fullmatch(r"(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)", raw, re.I)
    if not match:
        return None
    amount = int(match.group(1))
    unit = match.group(2).lower()
    if unit.startswith(("second", "sec", "s")):
        return timedelta(seconds=amount)
    if unit.startswith(("minute", "min", "m")):
        return timedelta(minutes=amount)
    if unit.startswith(("hour", "hr", "h")):
        return timedelta(hours=amount)
    if unit.startswith(("day", "d")):
        return timedelta(days=amount)
    return timedelta(weeks=amount)


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in {"0", "false", "no", "off", "disabled"}
