#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "[launch] Building YAAIA..."
cd yaaia-app
npm install
npm run build
npm run build:vm
npm run build:vm-agent

echo "[launch] Launching YAAIA..."
export DEBUG="${DEBUG:-yaaia:*,tsdav:*}"
export YAAIA_IMAP_DEBUG="${YAAIA_IMAP_DEBUG:-1}"
exec npx electron .
