#!/usr/bin/env bash
# Build libntgcalls.dylib from ntgcalls/ (CMake via setup.py, shared).
# Requires: git, cmake (3.27+), Python venv deps, Xcode/CLT, network.
# Output: ntgcalls/shared-output/{include,lib}/
#
# Optional: INSTALL_TO_YAAIA=1 copies into yaaia-app/native/ntgcalls/macos-arm64/ and syncs ntgcalls.h for Go CGO.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NTG="${ROOT}/ntgcalls"
cd "${NTG}"

git submodule update --init --recursive

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
# shellcheck source=/dev/null
source .venv/bin/activate
pip install -q setuptools

rm -rf build_lib shared-output
python setup.py build_lib

echo "Built: ${NTG}/shared-output/lib/libntgcalls.dylib"
otool -D "${NTG}/shared-output/lib/libntgcalls.dylib" || true

if [[ "${INSTALL_TO_YAAIA:-}" == "1" ]]; then
  DEST="${ROOT}/yaaia-app/native/ntgcalls/macos-arm64"
  mkdir -p "${DEST}/lib" "${DEST}/include"
  cp -f shared-output/lib/libntgcalls.dylib "${DEST}/lib/"
  cp -f shared-output/include/ntgcalls.h "${DEST}/include/"
  mkdir -p "${ROOT}/ntgcalls/examples/go/ntgcalls"
  cp -f shared-output/include/ntgcalls.h "${ROOT}/ntgcalls/examples/go/ntgcalls/ntgcalls.h"
  echo "Installed to ${DEST} and synced examples/go/ntgcalls/ntgcalls.h"
fi
