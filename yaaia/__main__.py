from __future__ import annotations

import sys

from .app import run
from .setup import run_setup_cli


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "setup":
        return run_setup_cli(sys.argv[2:])
    return run()


if __name__ == "__main__":
    sys.exit(main())
