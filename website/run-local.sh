#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
if [[ ! -f public/icon.png ]] && [[ -f "$ROOT/icon.png" ]]; then
  cp -f "$ROOT/icon.png" public/icon.png
fi
if [[ ! -f public/icon.png ]]; then
  echo "Missing public/icon.png — place icon.png in the repo root or website/public/" >&2
  exit 1
fi
npm install
exec npm run dev
