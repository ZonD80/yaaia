#!/bin/bash
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"

echo "[launch] Building YAAIA..."
cd yaaia-app
npm install
npm run build
npm run build:vm
npm run build:vm-agent

if [[ "$(uname -s)" == "Darwin" ]]; then
  DYLIB="${ROOT}/yaaia-app/native/ntgcalls/macos-arm64/lib/libntgcalls.dylib"
  if [[ ! -f "$DYLIB" ]]; then
    echo "[launch] No libntgcalls.dylib — building NTgCalls from source (first run: several minutes)..."
    (cd "${ROOT}" && INSTALL_TO_YAAIA=1 ./scripts/build-ntgcalls-macos-shared.sh)
  fi
  echo "[launch] Building Apple STT/TTS helper (yaaia-voip-helper)..."
  npm run build:voip-helper
  echo "[launch] Building VoIP-capable yaaia-tg-gateway (ntgcalls + dylib)..."
  npm run build:telegram-gateway-voip
else
  echo "[launch] Non-macOS: building telegram gateway without ntgcalls VoIP..."
  npm run build:telegram-gateway
fi

echo "[launch] Launching YAAIA..."
export DEBUG="${DEBUG:-yaaia:*,tsdav:*}"
export YAAIA_IMAP_DEBUG="${YAAIA_IMAP_DEBUG:-1}"
exec npx electron .
