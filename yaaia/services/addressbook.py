from __future__ import annotations

import json
import re
import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT_BUS_ID = "root"
DEFAULT_IDENTIFIER = "user"
MAX_IDENTIFIER_LEN = 200


@dataclass(frozen=True, slots=True)
class Contact:
    id: str
    name: str
    identifier: str
    trust_level: str
    bus_ids: list[str]
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "identifier": self.identifier,
            "trust_level": self.trust_level,
            "bus_ids": self.bus_ids,
            "notes": self.notes,
        }


class AddressBookStore:
    def __init__(self, database_path: Path, home: Path) -> None:
        self.database_path = database_path
        self.home = home
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.database_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()
        self._migrate_legacy_contacts()

    def close(self) -> None:
        self._conn.close()

    def _init_schema(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                identifier TEXT NOT NULL,
                bus_ids TEXT NOT NULL,
                trust_level TEXT NOT NULL DEFAULT 'normal' CHECK (trust_level IN ('normal', 'root')),
                notes TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_contacts_identifier ON contacts(identifier);
            """
        )
        self._conn.commit()

    def _migrate_legacy_contacts(self) -> None:
        if self.list():
            return
        legacy_path = self.home / "storage" / "history.db"
        if not legacy_path.exists() or legacy_path.resolve() == self.database_path.resolve():
            return
        try:
            legacy = sqlite3.connect(legacy_path)
            legacy.row_factory = sqlite3.Row
            rows = legacy.execute(
                "SELECT id, name, identifier, bus_ids, trust_level, notes FROM contacts"
            ).fetchall()
        except sqlite3.Error:
            return
        finally:
            try:
                legacy.close()
            except Exception:
                pass
        for row in rows:
            self._insert_raw(
                Contact(
                    id=str(row["id"]),
                    name=str(row["name"]),
                    identifier=sanitize_identifier(str(row["identifier"])),
                    bus_ids=parse_bus_ids(str(row["bus_ids"])),
                    trust_level=_sanitize_trust(str(row["trust_level"])),
                    notes=str(row["notes"] or ""),
                )
            )

    def list(self) -> list[Contact]:
        rows = self._conn.execute(
            "SELECT id, name, identifier, bus_ids, trust_level, notes FROM contacts ORDER BY name COLLATE NOCASE"
        ).fetchall()
        return [_row_to_contact(row) for row in rows]

    def search(self, query: str) -> list[Contact]:
        q = f"%{query.strip()}%"
        rows = self._conn.execute(
            """
            SELECT id, name, identifier, bus_ids, trust_level, notes
            FROM contacts
            WHERE name LIKE ? OR identifier LIKE ? OR notes LIKE ?
            ORDER BY name COLLATE NOCASE
            """,
            (q, q, q),
        ).fetchall()
        return [_row_to_contact(row) for row in rows]

    def get(self, id_or_identifier: str) -> Contact | None:
        key = id_or_identifier.strip()
        row = self._conn.execute(
            """
            SELECT id, name, identifier, bus_ids, trust_level, notes
            FROM contacts
            WHERE id = ? OR identifier = ?
            LIMIT 1
            """,
            (key, sanitize_identifier(key)),
        ).fetchone()
        return _row_to_contact(row) if row else None

    def create(
        self,
        *,
        name: str,
        identifier: str,
        trust_level: str = "normal",
        bus_ids: list[str] | None = None,
        notes: str = "",
    ) -> str:
        identifier = sanitize_identifier(identifier)
        if self.get(identifier):
            raise ValueError(f'Contact with identifier "{identifier}" already exists.')
        contact = Contact(
            id=str(uuid.uuid4()),
            name=name.strip() or identifier,
            identifier=identifier,
            trust_level=_sanitize_trust(trust_level),
            bus_ids=[bus_id.strip() for bus_id in (bus_ids or []) if bus_id.strip()],
            notes=notes.strip(),
        )
        self._insert_raw(contact)
        return contact.id

    def update(self, id_or_identifier: str, **updates: Any) -> None:
        current = self.get(id_or_identifier)
        if not current:
            raise ValueError(f"Contact not found: {id_or_identifier}")
        identifier = current.identifier
        if updates.get("identifier") is not None:
            new_identifier = sanitize_identifier(str(updates["identifier"]))
            existing = self.get(new_identifier)
            if existing and existing.id != current.id:
                raise ValueError(f'Identifier "{new_identifier}" already in use.')
            identifier = new_identifier
        name = str(updates.get("name", current.name)).strip() or identifier
        trust_level = _sanitize_trust(str(updates.get("trust_level", current.trust_level)))
        bus_ids_raw = updates.get("bus_ids", current.bus_ids)
        if isinstance(bus_ids_raw, str):
            bus_ids = _split_bus_ids(bus_ids_raw)
        else:
            bus_ids = [str(bus_id).strip() for bus_id in bus_ids_raw if str(bus_id).strip()]
        notes = str(updates.get("notes", current.notes))
        self._conn.execute(
            """
            UPDATE contacts
            SET name = ?, identifier = ?, bus_ids = ?, trust_level = ?, notes = ?
            WHERE id = ?
            """,
            (name, identifier, json.dumps(bus_ids), trust_level, notes, current.id),
        )
        self._conn.commit()

    def delete(self, id_or_identifier: str) -> bool:
        contact = self.get(id_or_identifier)
        if not contact:
            return False
        cur = self._conn.execute("DELETE FROM contacts WHERE id = ?", (contact.id,))
        self._conn.commit()
        return cur.rowcount > 0

    def remove_bus(self, bus_id: str) -> int:
        bus_id = bus_id.strip()
        if not bus_id:
            return 0
        updated = 0
        for contact in self.list():
            if bus_id not in contact.bus_ids:
                continue
            bus_ids = [item for item in contact.bus_ids if item != bus_id]
            self._conn.execute(
                "UPDATE contacts SET bus_ids = ? WHERE id = ?",
                (json.dumps(bus_ids), contact.id),
            )
            updated += 1
        if updated:
            self._conn.commit()
        return updated

    def resolve(self, bus_id: str, sender_email: str | None = None) -> Contact | None:
        contacts = self.list()
        if bus_id == ROOT_BUS_ID:
            return next((contact for contact in contacts if contact.identifier == DEFAULT_IDENTIFIER), None)
        if bus_id.startswith("telegram-"):
            return next((contact for contact in contacts if bus_id in contact.bus_ids), None)
        if bus_id.startswith(("email-", "gmail-")) and sender_email:
            normalized = sender_email.strip().lower()
            return next(
                (
                    contact
                    for contact in contacts
                    if contact.identifier == normalized and bus_id in contact.bus_ids
                ),
                None,
            )
        return next((contact for contact in contacts if bus_id in contact.bus_ids), None)

    def trust_level_for_bus(self, bus_id: str, sender_email: str | None = None) -> str:
        contact = self.resolve(bus_id, sender_email)
        return contact.trust_level if contact else "normal"

    def is_trusted(self, bus_id: str, sender_email: str | None = None) -> bool:
        return self.trust_level_for_bus(bus_id, sender_email) == "root"

    def _insert_raw(self, contact: Contact) -> None:
        self._conn.execute(
            """
            INSERT OR IGNORE INTO contacts (id, name, identifier, bus_ids, trust_level, notes)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                contact.id,
                contact.name,
                contact.identifier,
                json.dumps(contact.bus_ids),
                contact.trust_level,
                contact.notes,
            ),
        )
        self._conn.commit()


def sanitize_identifier(value: str) -> str:
    sanitized = re.sub(r"[^a-z0-9@._-]", "_", value.strip().lower())[:MAX_IDENTIFIER_LEN]
    return sanitized or "unnamed"


def parse_bus_ids(raw: str) -> list[str]:
    try:
        loaded = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return _split_bus_ids(raw)
    if not isinstance(loaded, list):
        return []
    return [str(item).strip() for item in loaded if str(item).strip()]


def _split_bus_ids(raw: str) -> list[str]:
    return [part.strip() for part in re.split(r"[, ]+", raw.strip()) if part.strip()]


def _sanitize_trust(value: str) -> str:
    return "root" if value.strip().lower() == "root" else "normal"


def _row_to_contact(row: sqlite3.Row) -> Contact:
    return Contact(
        id=str(row["id"]),
        name=str(row["name"]),
        identifier=str(row["identifier"]),
        bus_ids=parse_bus_ids(str(row["bus_ids"])),
        trust_level=_sanitize_trust(str(row["trust_level"])),
        notes=str(row["notes"] or ""),
    )
