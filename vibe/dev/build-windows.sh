#!/usr/bin/env bash
# Wrapper around VSCodium's dev/build.sh for Windows (Git Bash).
# Runs the preflight (PATH fixes for node/python/7z/cargo), pins node-gyp to Python 3.11,
# then forwards all flags to dev/build.sh (e.g. -p to also produce the installer .exe).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
# shellcheck disable=SC1091
source vibe/dev/preflight.sh || { echo "Fix preflight failures first."; exit 1; }
if [[ -z "${VIBE_PYTHON:-}" ]] && command -v py >/dev/null 2>&1; then
  VIBE_PYTHON="$(py -3.11 -c 'import sys; print(sys.executable)')"
fi
export npm_config_python="${VIBE_PYTHON:-python3}"
export PYTHON="${npm_config_python}"
exec ./dev/build.sh "$@"
