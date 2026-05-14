from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import struct
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


@dataclass(frozen=True, slots=True)
class SecretEntry:
    uuid: str
    description: str
    type: str
    value: str

    def public_dict(self) -> dict[str, str]:
        return {
            "uuid": self.uuid,
            "description": self.description,
            "type": self.type,
        }

    def full_dict(self) -> dict[str, str]:
        return {
            **self.public_dict(),
            "value": self.value,
        }


class SecretsStore:
    def __init__(self, home: Path) -> None:
        self.home = home
        self.path = home / "passwords.json"

    def list(self) -> list[dict[str, str]]:
        return [entry.public_dict() for entry in self._load()]

    def list_full(self) -> list[dict[str, str]]:
        return [entry.full_dict() for entry in self._load()]

    def get(self, description_or_uuid: str, *, raw: bool = False) -> str | None:
        entry = self._find(description_or_uuid)
        if not entry:
            return None
        if entry.type == "totp" and not raw:
            try:
                return generate_totp(entry.value)
            except Exception:
                return entry.value
        return entry.value

    def set(
        self,
        *,
        description: str,
        type: str,
        value: str,
        force: bool = False,
        update_uuid: str | None = None,
    ) -> str:
        description = description.strip()
        if not description:
            raise ValueError("description is required")
        secret_type = "totp" if type.strip().lower() == "totp" else "string"
        items = self._load()
        existing_by_uuid = next((entry for entry in items if update_uuid and entry.uuid == update_uuid), None)
        existing_by_desc = next(
            (entry for entry in items if entry.description == description and entry.uuid != update_uuid),
            None,
        )
        if existing_by_desc and not force:
            raise ValueError(f'Secret "{description}" already exists. Use force=true to overwrite.')
        new_uuid = existing_by_uuid.uuid if existing_by_uuid else str(uuid.uuid4())
        entry = SecretEntry(
            uuid=new_uuid,
            description=description,
            type=secret_type,
            value=value.strip(),
        )
        remove = {new_uuid}
        if existing_by_desc:
            remove.add(existing_by_desc.uuid)
        rest = [item for item in items if item.uuid not in remove]
        self._save([*rest, entry])
        return entry.uuid

    def delete(self, description_or_uuid: str) -> bool:
        entry = self._find(description_or_uuid)
        if not entry:
            return False
        self._save([item for item in self._load() if item.uuid != entry.uuid])
        return True

    def wipe(self) -> None:
        self._save([])

    def _find(self, description_or_uuid: str) -> SecretEntry | None:
        key = description_or_uuid.strip()
        items = self._load()
        if UUID_RE.match(key):
            return next((entry for entry in items if entry.uuid == key), None)
        return next((entry for entry in items if entry.description == key), None)

    def _load(self) -> list[SecretEntry]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return []
        items = raw.get("items") if isinstance(raw, dict) else None
        if not isinstance(items, list):
            return []
        entries = [_coerce_entry(item) for item in items if isinstance(item, dict)]
        if raw.get("v") != 2:
            self._save(entries)
        return entries

    def _save(self, items: list[SecretEntry]) -> None:
        self.home.mkdir(parents=True, exist_ok=True)
        data: dict[str, Any] = {"v": 2, "items": [entry.full_dict() for entry in items]}
        self.path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def generate_totp(secret: str, *, digits: int = 6, period: int = 30, at: int | None = None) -> str:
    clean = re.sub(r"\s+", "", secret).upper()
    clean += "=" * (-len(clean) % 8)
    key = base64.b32decode(clean, casefold=True)
    counter = int((time.time() if at is None else at) // period)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(code % (10**digits)).zfill(digits)


def _coerce_entry(item: dict[str, Any]) -> SecretEntry:
    secret_type = "totp" if item.get("type") == "totp" else "string"
    secret_uuid = str(item.get("uuid") or "")
    if not UUID_RE.match(secret_uuid):
        secret_uuid = str(uuid.uuid4())
    return SecretEntry(
        uuid=secret_uuid,
        description=str(item.get("description") or "unnamed").strip() or "unnamed",
        type=secret_type,
        value=str(item.get("value") or ""),
    )
