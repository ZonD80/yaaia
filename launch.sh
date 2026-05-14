#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

if [[ -f "${ROOT}/.env" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "${key}" || "${key}" =~ ^[[:space:]]*# ]] && continue
    [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ -z "${!key+x}" ]]; then
      value="${value%$'\r'}"
      value="${value#\"}"
      value="${value%\"}"
      value="${value#\'}"
      value="${value%\'}"
      value="${value/#\~/${HOME}}"
      export "${key}=${value}"
    fi
  done < "${ROOT}/.env"
fi

ENV_PREFIX="${YAAIA_CONDA_PREFIX:-${ROOT}/.conda}"

if [[ ! -x "${ENV_PREFIX}/bin/python" ]]; then
  "${ROOT}/scripts/setup-conda.sh"
fi

exec conda run --no-capture-output -p "${ENV_PREFIX}" python -m yaaia
