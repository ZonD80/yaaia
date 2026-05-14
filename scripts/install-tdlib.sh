#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${YAAIA_TDLIB_SRC:-/private/tmp/yaaia-td}"
BUILD_DIR="${SRC_DIR}/build"
PREFIX="${YAAIA_TDLIB_PREFIX:-${HOME}/yaaia/tdlib}"
JOBS="${YAAIA_TDLIB_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
XCODE_TOOLCHAIN="/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin"
ENV_PATH="${ROOT}/.env"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required." >&2
  exit 1
fi

if ! command -v cmake >/dev/null 2>&1; then
  echo "cmake is required. Install it with Homebrew or your system package manager." >&2
  exit 1
fi

if [[ -d "${XCODE_TOOLCHAIN}" ]]; then
  export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
  export CC="${XCODE_TOOLCHAIN}/clang"
  export CXX="${XCODE_TOOLCHAIN}/clang++"
  export PATH="${XCODE_TOOLCHAIN}:${PATH}"
fi

if [[ ! -d "${SRC_DIR}/.git" ]]; then
  echo "[tdlib] Cloning tdlib/td into ${SRC_DIR}"
  git clone --depth 1 https://github.com/tdlib/td "${SRC_DIR}"
else
  echo "[tdlib] Updating ${SRC_DIR}"
  git -C "${SRC_DIR}" pull --ff-only
fi

OPENSSL_ROOT="${OPENSSL_ROOT_DIR:-}"
if [[ -z "${OPENSSL_ROOT}" ]] && command -v brew >/dev/null 2>&1; then
  OPENSSL_ROOT="$(brew --prefix openssl@3 2>/dev/null || true)"
fi

cmake_args=(-DCMAKE_BUILD_TYPE=Release)
if [[ -n "${OPENSSL_ROOT}" ]]; then
  cmake_args+=("-DOPENSSL_ROOT_DIR=${OPENSSL_ROOT}")
fi

mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

echo "[tdlib] Configuring"
cmake "${cmake_args[@]}" ..

echo "[tdlib] Building tdjson with ${JOBS} jobs"
cmake --build . --target tdjson -j "${JOBS}"

echo "[tdlib] Installing to ${PREFIX}"
install -d "${PREFIX}"
install -m 755 "${BUILD_DIR}/libtdjson.dylib" "${PREFIX}/libtdjson.dylib"

if [[ -f "${ENV_PATH}" ]]; then
  tmp_env="${ENV_PATH}.tmp"
  awk -v value="${PREFIX}/libtdjson.dylib" '
    BEGIN { done = 0 }
    /^YAAIA_TDLIB_LIBRARY_PATH=/ {
      print "YAAIA_TDLIB_LIBRARY_PATH=" value
      done = 1
      next
    }
    { print }
    END {
      if (!done) {
        print "YAAIA_TDLIB_LIBRARY_PATH=" value
      }
    }
  ' "${ENV_PATH}" > "${tmp_env}"
  mv "${tmp_env}" "${ENV_PATH}"
else
  printf 'YAAIA_TDLIB_LIBRARY_PATH=%s/libtdjson.dylib\n' "${PREFIX}" > "${ENV_PATH}"
fi

echo "[tdlib] Ready: ${PREFIX}/libtdjson.dylib"
