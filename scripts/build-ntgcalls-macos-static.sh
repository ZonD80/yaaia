#!/usr/bin/env bash
# Build libntgcalls.a from the ntgcalls/ source tree (CMake via setup.py).
# Requires: git, cmake (3.27+), Python 3 with venv, Xcode/CLT, network for deps download.
# Output: ntgcalls/static-output/{include,lib}/
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

python setup.py build_lib --static

echo "Built: ${NTG}/static-output/lib/libntgcalls.a"

if [[ "${INSTALL_TO_YAAIA:-}" == "1" ]]; then
  DEST="${ROOT}/yaaia-app/native/ntgcalls/macos-arm64"
  mkdir -p "${DEST}/lib" "${DEST}/include"
  cp -f static-output/lib/libntgcalls.a "${DEST}/lib/"
  cp -f static-output/include/ntgcalls.h "${DEST}/include/"
  mkdir -p "${ROOT}/ntgcalls/examples/go/ntgcalls"
  cp -f static-output/include/ntgcalls.h "${ROOT}/ntgcalls/examples/go/ntgcalls/ntgcalls.h"
  echo "Installed to ${DEST} and synced examples/go/ntgcalls/ntgcalls.h"
fi
