#!/bin/bash
# Build and package YAAIA for macOS.
# See launch.sh for dev build/run flow.
set -e
cd "$(dirname "$0")"

ARCH=$(uname -m)
echo "[build] Building YAAIA for macOS ${ARCH}..."

cd yaaia-app

echo "[build] Cleaning previous build artifacts..."
rm -rf dist dist-electron release

echo "[build] Installing dependencies..."
npm install

echo "[build] Building Electron app..."
npm run build

echo "[build] Copying resources for packaging..."
mkdir -p dist-electron/resources
cp -f resources/agent-browser-placeholder.html dist-electron/resources/

echo "[build] Packaging with electron-builder (no code signing)..."
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac

echo "[build] Done. Output in yaaia-app/release/"
