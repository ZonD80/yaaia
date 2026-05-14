from __future__ import annotations

import re
from pathlib import Path

TDLIB_TOO_OLD_FOR_LOGIN = (1, 8, 0)

_VERSION_RE = re.compile(rb"\b1\.8\.(\d{1,3})\b")


def tdlib_version_from_library(path: str | Path | None) -> tuple[int, int, int] | None:
    if not path:
        return None
    library_path = Path(path).expanduser()
    if not library_path.exists():
        return None
    try:
        data = library_path.read_bytes()
    except OSError:
        return None
    versions = {(1, 8, int(match.group(1))) for match in _VERSION_RE.finditer(data)}
    return max(versions) if versions else None


def is_tdlib_too_old_for_login(version: tuple[int, int, int] | None) -> bool:
    return bool(version and version <= TDLIB_TOO_OLD_FOR_LOGIN)


def format_tdlib_version(version: tuple[int, int, int] | None) -> str:
    if not version:
        return "unknown"
    return ".".join(str(part) for part in version)
