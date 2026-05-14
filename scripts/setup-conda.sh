#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_PREFIX="${YAAIA_CONDA_PREFIX:-${ROOT}/.conda}"
BASE_PYTHON="${YAAIA_BASE_PYTHON:-$(command -v python)}"

if ! command -v conda >/dev/null 2>&1; then
  echo "conda is required but was not found in PATH." >&2
  exit 1
fi

PYTHON_VERSION="$("${BASE_PYTHON}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"

if [[ ! -x "${ENV_PREFIX}/bin/python" ]]; then
  echo "[setup] Creating conda env at ${ENV_PREFIX} with Python ${PYTHON_VERSION}"
  conda create -y -p "${ENV_PREFIX}" "python=${PYTHON_VERSION}" pip
else
  echo "[setup] Reusing conda env at ${ENV_PREFIX}"
fi

echo "[setup] Installing Python dependencies"
conda run -p "${ENV_PREFIX}" python -m pip install --upgrade pip
conda run -p "${ENV_PREFIX}" python -m pip install -r "${ROOT}/requirements.txt"

CALLS_ENABLED="${YAAIA_INSTALL_VOICE:-${YAAIA_CALLS_ENABLED:-}}"
if [[ -z "${CALLS_ENABLED}" && -f "${ROOT}/.env" ]]; then
  CALLS_ENABLED="$(sed -n 's/^YAAIA_CALLS_ENABLED=//p' "${ROOT}/.env" | tail -n 1 | tr '[:upper:]' '[:lower:]')"
fi
if [[ "${CALLS_ENABLED}" =~ ^(1|true|yes|on)$ ]]; then
  echo "[setup] Installing optional voice/call dependencies"
  conda run -p "${ENV_PREFIX}" python -m pip install -r "${ROOT}/requirements-voice.txt"
fi

echo "[setup] Ready. Run: ./launch.sh"
