#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
ENV_PREFIX="${YAAIA_CONDA_PREFIX:-$(pwd)/.conda}"

./scripts/setup-conda.sh
conda run --no-capture-output -p "${ENV_PREFIX}" python -m compileall -q yaaia

echo "[build] Python sources compiled successfully."
