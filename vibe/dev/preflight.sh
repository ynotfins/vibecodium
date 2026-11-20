#!/usr/bin/env bash
# Vibecodium build preflight. Checks the toolchain VSCodium's dev/build.sh needs
# (docs/howto-build.md) and prints a PASS/FAIL table. Never prints secrets.
#
# Optional overrides (portable, no hard-coded machine paths):
#   VIBE_NODE_HOME   folder containing node(.exe) matching .nvmrc
#   VIBE_PYTHON      python 3.11 executable
#   VIBE_7Z_HOME     folder containing 7z(.exe)
# Usage: source vibe/dev/preflight.sh   (exports PATH fixes)   or   bash vibe/dev/preflight.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
want_node="$(tr -d '[:space:]' < "${ROOT}/.nvmrc")"
fail=0

[[ -n "${VIBE_NODE_HOME:-}" ]] && export PATH="${VIBE_NODE_HOME}:${PATH}"
[[ -n "${VIBE_7Z_HOME:-}" ]] && export PATH="${VIBE_7Z_HOME}:${PATH}"
if [[ -z "${VIBE_7Z_HOME:-}" && -d "/c/Program Files/7-Zip" ]]; then export PATH="/c/Program Files/7-Zip:${PATH}"; fi
[[ -d "${HOME}/.cargo/bin" ]] && export PATH="${HOME}/.cargo/bin:${PATH}"

check() { # name, ok(0/1), detail
  if [[ "$2" == 0 ]]; then printf 'PASS  %-10s %s\n' "$1" "$3"; else printf 'FAIL  %-10s %s\n' "$1" "$3"; fail=1; fi
}

v="$(node --version 2>/dev/null | sed 's/^v//')"; [[ "$v" == "$want_node" ]]; check node $? "have=${v:-none} want=${want_node} (set VIBE_NODE_HOME)"
py="${VIBE_PYTHON:-}"
if [[ -z "$py" ]]; then
  if command -v py >/dev/null 2>&1 && py -3.11 --version >/dev/null 2>&1; then py="py -3.11"; else py="python3"; fi
fi
pv="$($py --version 2>&1 | awk '{print $2}')"; [[ "$pv" == 3.11.* ]]; check python $? "have=${pv:-none} want=3.11.x (set VIBE_PYTHON)"
for t in jq git cargo rustc; do command -v "$t" >/dev/null 2>&1; check "$t" $? "$(command -v "$t" 2>/dev/null || echo missing)"; done
command -v 7z >/dev/null 2>&1; check 7z $? "$(command -v 7z 2>/dev/null || echo missing)"
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  vsw="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
  bt="$("$vsw" -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property displayName 2>/dev/null | head -1)"
  [[ -n "$bt" ]]; check msvc $? "${bt:-no VS C++ build tools found}"
  sp="$("$vsw" -products '*' -requires Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre -property installationPath 2>/dev/null | head -1)"
  [[ -n "$sp" ]]; check spectre $? "${sp:-missing: add component Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre (needs admin; see docs/vibe/dev/BUILD.md)}"
fi
[[ "$fail" == 0 ]] && echo "PREFLIGHT: PASS" || echo "PREFLIGHT: FAIL"
return "$fail" 2>/dev/null || exit "$fail"
