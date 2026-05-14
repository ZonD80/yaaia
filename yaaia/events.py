from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_timestamp(value: str | None) -> datetime:
    if not value:
        return utc_now()
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return utc_now()


@dataclass(slots=True)
class MessageEvent:
    source: str
    bus_id: str
    sender: str
    text: str
    timestamp: datetime = field(default_factory=utc_now)
    external_id: str | None = None
    outbound: bool = False
    meta: dict[str, Any] = field(default_factory=dict)
    db_id: int | None = None

    @property
    def timestamp_iso(self) -> str:
        return self.timestamp.astimezone(timezone.utc).isoformat()

    @property
    def direction(self) -> str:
        return "out" if self.outbound else "in"
