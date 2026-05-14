from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any

from .events import MessageEvent, parse_timestamp, utc_now

ROOT_BUS_ID = "root"


class MessageStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._init_schema()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT NOT NULL,
                    bus_id TEXT NOT NULL,
                    sender TEXT NOT NULL,
                    text TEXT NOT NULL,
                    received_at TEXT NOT NULL,
                    external_id TEXT,
                    outbound INTEGER NOT NULL DEFAULT 0,
                    metadata_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS idx_messages_received_at
                    ON messages(received_at);
                CREATE INDEX IF NOT EXISTS idx_messages_bus
                    ON messages(source, bus_id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external
                    ON messages(source, bus_id, external_id)
                    WHERE external_id IS NOT NULL;
                CREATE TABLE IF NOT EXISTS forgotten_buses (
                    bus_id TEXT PRIMARY KEY,
                    forgotten_at TEXT NOT NULL,
                    reason TEXT NOT NULL DEFAULT ''
                );
                """
            )
            self._conn.commit()

    def append(self, event: MessageEvent) -> bool:
        import json

        if self.is_bus_forgotten(event.bus_id):
            return False
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT OR IGNORE INTO messages
                    (source, bus_id, sender, text, received_at, external_id, outbound, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event.source,
                    event.bus_id,
                    event.sender,
                    event.text,
                    event.timestamp_iso,
                    event.external_id,
                    1 if event.outbound else 0,
                    json.dumps(event.meta, sort_keys=True),
                ),
            )
            self._conn.commit()
            if cur.rowcount > 0:
                event.db_id = int(cur.lastrowid)
            return cur.rowcount > 0

    def seen(self, source: str, bus_id: str, external_id: str | None) -> bool:
        if self.is_bus_forgotten(bus_id):
            return True
        if not external_id:
            return False
        with self._lock:
            row = self._conn.execute(
                """
                SELECT 1 FROM messages
                WHERE source = ? AND bus_id = ? AND external_id = ?
                LIMIT 1
                """,
                (source, bus_id, external_id),
            ).fetchone()
            return row is not None

    def recent(self, limit: int = 50) -> list[MessageEvent]:
        limit = max(1, min(limit, 500))
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT id, source, bus_id, sender, text, received_at, external_id, outbound, metadata_json
                FROM messages
                ORDER BY received_at DESC, id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [self._row_to_event(row) for row in reversed(rows)]

    def recent_bus(self, bus_id: str = ROOT_BUS_ID, limit: int = 50) -> list[MessageEvent]:
        if self.is_bus_forgotten(bus_id):
            return []
        limit = max(1, min(limit, 500))
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT id, source, bus_id, sender, text, received_at, external_id, outbound, metadata_json
                FROM messages
                WHERE bus_id = ?
                ORDER BY received_at DESC, id DESC
                LIMIT ?
                """,
                (bus_id, limit),
            ).fetchall()
        return [self._row_to_event(row) for row in reversed(rows)]

    def recent_bus_before(self, bus_id: str, before_db_id: int | None, limit: int = 100) -> list[MessageEvent]:
        if self.is_bus_forgotten(bus_id):
            return []
        limit = max(1, min(limit, 500))
        if before_db_id is None:
            return self.recent_bus(bus_id, limit)
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT id, source, bus_id, sender, text, received_at, external_id, outbound, metadata_json
                FROM messages
                WHERE bus_id = ? AND id < ?
                ORDER BY received_at DESC, id DESC
                LIMIT ?
                """,
                (bus_id, before_db_id, limit),
            ).fetchall()
        return [self._row_to_event(row) for row in reversed(rows)]

    def last_db_id_before(self, bus_id: str, before_db_id: int | None) -> int | None:
        if self.is_bus_forgotten(bus_id):
            return None
        if before_db_id is None:
            return None
        with self._lock:
            row = self._conn.execute(
                """
                SELECT id FROM messages
                WHERE bus_id = ? AND id < ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (bus_id, before_db_id),
            ).fetchone()
        return int(row["id"]) if row else None

    def delete_bus_history(self, bus_id: str) -> int:
        with self._lock:
            cur = self._conn.execute("DELETE FROM messages WHERE bus_id = ?", (bus_id,))
            self._conn.commit()
            return int(cur.rowcount if cur.rowcount is not None else 0)

    def wipe_root_history(self) -> int:
        return self.delete_bus_history(ROOT_BUS_ID)

    def forget_bus(self, bus_id: str, *, reason: str = "") -> dict[str, Any]:
        bus_id = bus_id.strip()
        if not bus_id:
            raise ValueError("bus_id is required.")
        if bus_id in {ROOT_BUS_ID, "system"}:
            raise ValueError(f"{bus_id} cannot be forgotten. Use clear chat for root history.")

        import json

        with self._lock:
            already_forgotten = self._conn.execute(
                "SELECT 1 FROM forgotten_buses WHERE bus_id = ? LIMIT 1",
                (bus_id,),
            ).fetchone() is not None

            mirror_ids: list[int] = []
            rows = self._conn.execute(
                """
                SELECT id, text, external_id, metadata_json
                FROM messages
                WHERE bus_id = ?
                """,
                (ROOT_BUS_ID,),
            ).fetchall()
            for row in rows:
                meta: dict[str, Any] = {}
                try:
                    loaded = json.loads(row["metadata_json"] or "{}")
                    if isinstance(loaded, dict):
                        meta = loaded
                except json.JSONDecodeError:
                    pass
                external_id = str(row["external_id"] or "")
                text = str(row["text"] or "")
                is_mirror = (
                    meta.get("mirrored_bus_id") == bus_id
                    or external_id.startswith(f"mirror:") and f":{bus_id}:" in external_id
                    or text.startswith(f"{bus_id}:")
                )
                if is_mirror:
                    mirror_ids.append(int(row["id"]))

            direct = self._conn.execute("DELETE FROM messages WHERE bus_id = ?", (bus_id,))
            mirror_count = 0
            if mirror_ids:
                placeholders = ",".join("?" for _ in mirror_ids)
                mirror = self._conn.execute(f"DELETE FROM messages WHERE id IN ({placeholders})", mirror_ids)
                mirror_count = int(mirror.rowcount if mirror.rowcount is not None else 0)

            if already_forgotten:
                self._conn.execute(
                    "UPDATE forgotten_buses SET forgotten_at = ?, reason = ? WHERE bus_id = ?",
                    (utc_now().isoformat(), reason, bus_id),
                )
            else:
                self._conn.execute(
                    "INSERT INTO forgotten_buses (bus_id, forgotten_at, reason) VALUES (?, ?, ?)",
                    (bus_id, utc_now().isoformat(), reason),
                )
            self._conn.commit()
            return {
                "bus_id": bus_id,
                "already_forgotten": already_forgotten,
                "deleted_messages": int(direct.rowcount if direct.rowcount is not None else 0),
                "deleted_root_mirrors": mirror_count,
            }

    def restore_bus(self, bus_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM forgotten_buses WHERE bus_id = ?", (bus_id.strip(),))
            self._conn.commit()
            return cur.rowcount > 0

    def is_bus_forgotten(self, bus_id: str) -> bool:
        if bus_id in {ROOT_BUS_ID, "system"}:
            return False
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM forgotten_buses WHERE bus_id = ? LIMIT 1",
                (bus_id,),
            ).fetchone()
            return row is not None

    def forgotten_bus_ids(self) -> set[str]:
        with self._lock:
            rows = self._conn.execute("SELECT bus_id FROM forgotten_buses").fetchall()
        return {str(row["bus_id"]) for row in rows}

    def list_forgotten_buses(self) -> list[dict[str, str]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT bus_id, forgotten_at, reason
                FROM forgotten_buses
                ORDER BY forgotten_at DESC, bus_id
                """
            ).fetchall()
        return [
            {
                "bus_id": str(row["bus_id"]),
                "forgotten_at": str(row["forgotten_at"]),
                "reason": str(row["reason"] or ""),
            }
            for row in rows
        ]

    def list_buses(self, *, include_forgotten: bool = False) -> list[dict[str, Any]]:
        forgotten_filter = "" if include_forgotten else "AND bus_id NOT IN (SELECT bus_id FROM forgotten_buses)"
        with self._lock:
            rows = self._conn.execute(
                f"""
                SELECT
                    bus_id,
                    MIN(source) AS source,
                    COUNT(*) AS message_count,
                    MAX(received_at) AS last_received_at
                FROM messages
                WHERE bus_id != 'system'
                {forgotten_filter}
                GROUP BY bus_id
                ORDER BY
                    CASE WHEN bus_id = 'root' THEN 0 ELSE 1 END,
                    MAX(received_at) DESC
                """
            ).fetchall()
        buses = [
            {
                "bus_id": row["bus_id"],
                "source": row["source"],
                "message_count": int(row["message_count"] or 0),
                "last_received_at": row["last_received_at"],
            }
            for row in rows
        ]
        if not any(bus["bus_id"] == ROOT_BUS_ID for bus in buses):
            buses.insert(
                0,
                {
                    "bus_id": ROOT_BUS_ID,
                    "source": ROOT_BUS_ID,
                    "message_count": 0,
                    "last_received_at": None,
                },
            )
        return buses

    def _row_to_event(self, row: sqlite3.Row) -> MessageEvent:
        import json

        try:
            meta = json.loads(row["metadata_json"] or "{}")
        except json.JSONDecodeError:
            meta = {}
        return MessageEvent(
            source=row["source"],
            bus_id=row["bus_id"],
            sender=row["sender"],
            text=row["text"],
            timestamp=parse_timestamp(row["received_at"]),
            external_id=row["external_id"],
            outbound=bool(row["outbound"]),
            meta=meta,
            db_id=int(row["id"]) if "id" in row.keys() else None,
        )
