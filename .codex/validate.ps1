# Called by the workstation's Codex Stop hook at the end of every Codex turn in this repo.
# Runs the same checks as CI so drift is caught after every task.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
& node (Join-Path $root 'vibe\tools\verify.mjs')
exit $LASTEXITCODE
