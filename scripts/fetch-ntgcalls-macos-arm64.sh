#!/usr/bin/env bash
# Downloads official NTgCalls macOS arm64 static libs from GitHub releases and
# installs them under yaaia-app/native/ntgcalls/macos-arm64/.
# Also copies ntgcalls.h into ntgcalls/examples/go/ntgcalls/ for CGO.
#
# Release: https://github.com/pytgcalls/ntgcalls/releases
# Use the *static* asset: ntgcalls.macos-arm64-static_libs.zip (not the shared zip).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${NTGCALLS_VERSION:-v2.1.0}"
ASSET="ntgcalls.macos-arm64-static_libs.zip"
URL="https://github.com/pytgcalls/ntgcalls/releases/download/${VERSION}/${ASSET}"
DEST="${ROOT}/yaaia-app/native/ntgcalls/macos-arm64"
HEADER_GO="${ROOT}/ntgcalls/examples/go/ntgcalls/ntgcalls.h"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching ${URL}"
curl -fsSL -o "${TMP}/${ASSET}" "${URL}"

rm -rf "${DEST}"
mkdir -p "${DEST}"
unzip -q "${TMP}/${ASSET}" -d "${DEST}"

if [[ ! -f "${DEST}/include/ntgcalls.h" ]] || [[ ! -f "${DEST}/lib/libntgcalls.a" ]]; then
  echo "Unexpected zip layout; expected include/ntgcalls.h and lib/libntgcalls.a under ${DEST}" >&2
  exit 1
fi

mkdir -p "$(dirname "${HEADER_GO}")"
cp -f "${DEST}/include/ntgcalls.h" "${HEADER_GO}"
echo "Installed to ${DEST} and synced ${HEADER_GO}"
