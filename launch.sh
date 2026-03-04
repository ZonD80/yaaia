#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "[launch] Building YAAIA..."
cd yaaia-app
npm install
npm run build

echo "[launch] Launching YAAIA..."
exec npx electron .
