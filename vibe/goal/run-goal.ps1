<#
.SYNOPSIS
  Autonomous goal loop for the Vibecodium build (ADR-0006).

.DESCRIPTION
  Each iteration starts a fresh `codex exec` session in the trunk worktree with
  vibe/goal/continue.prompt.md. The session does one task slice and records state in the repo.
  The loop stops when docs/vibe/STATUS.md says "Goal state: complete" or "Goal state: blocked",
  when the daily iteration cap is reached, or after repeated failures.
  A lock file prevents concurrent runs. Designed to run hidden (see Register-GoalRunner.ps1).

  Isolation (docs/vibe/GOVERNANCE.md §5 "Enforcement"):
  - Root is a dedicated clone used only by the loop. Codex may write only inside Root and its
    sibling task-worktree folder "<Root>.worktrees"; every other checkout and file is read-only to it.
  - Secret-looking environment variables are removed before Codex starts, so API keys on this
    machine are not visible to the agent. GitHub access uses GH_TOKEN from VIBECODIUM_GH_TOKEN
    (a fine-grained token scoped to ynotfins/vibecodium) when that variable exists.

.PARAMETER Root
  Dedicated clone of ynotfins/vibecodium, checked out on vibe/main.
#>
param(
  [Parameter(Mandatory)] [string]$Root,
  [string]$LogDir = (Join-Path $env:LOCALAPPDATA 'Vibecodium\goal-runner'),
  [int]$MaxIterationsPerDay = 24,
  [int]$IterationTimeoutMinutes = 180,
  [int]$MaxConsecutiveFailures = 3,
  [string]$Codex = '',
  # Print the session command line and the environment check, then exit without starting Codex.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path $Root).Path.TrimEnd('\')
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$log = Join-Path $LogDir ("run-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
function Write-Log([string]$m) { Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format 's'), $m) }

try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch { }

# npm installs codex as .ps1/.cmd shims; Start-Process needs the .cmd (or a real .exe).
if (-not $Codex) {
  $cmd = Get-Command codex.cmd -ErrorAction SilentlyContinue
  $Codex = if ($cmd) { $cmd.Source } else { (Get-Command codex -ErrorAction Stop).Source }
}

# Inside the Codex sandbox the Windows TLS store and credential manager are unavailable.
# Use OpenSSL and the GitHub CLI as git credential helper for this process tree only (no git config change).
$env:GIT_CONFIG_COUNT = '3'
$env:GIT_CONFIG_KEY_0 = 'http.sslBackend'; $env:GIT_CONFIG_VALUE_0 = 'openssl'
$env:GIT_CONFIG_KEY_1 = 'credential.helper'; $env:GIT_CONFIG_VALUE_1 = ''
$env:GIT_CONFIG_KEY_2 = 'credential.helper'; $env:GIT_CONFIG_VALUE_2 = '!gh auth git-credential'

# Single instance.
$lockFile = Join-Path $LogDir 'runner.lock'
if (Test-Path $lockFile) {
  $old = Get-Content $lockFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($old -and (Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue)) { exit 0 }
}
Set-Content -Path $lockFile -Value $PID

# Remove secret-looking environment variables from this process (children inherit the reduced set).
# Values are kept in memory only, to redact them from the short summaries the runner writes.
$secretPattern = 'KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|_AUTH|AUTH_|DATABASE_URL|_DSN$'
$script:SecretValues = @{}
$scopedGh = $env:VIBECODIUM_GH_TOKEN
foreach ($e in @(Get-ChildItem Env:)) {
  if ($e.Name -match $secretPattern -and $e.Name -notmatch '^GIT_CONFIG_') {
    if ($e.Value -and $e.Value.Length -ge 8) { $script:SecretValues[$e.Name] = $e.Value }
    Remove-Item -LiteralPath "Env:$($e.Name)"
  }
}
if ($scopedGh) { $env:GH_TOKEN = $scopedGh }
else { Write-Log "VIBECODIUM_GH_TOKEN is not set; GitHub access falls back to the owner's gh login (broader scope)" }

# Replace every known secret value with its variable name.
function Protect-Text([string]$text) {
  foreach ($k in $script:SecretValues.Keys) { $text = $text.Replace($script:SecretValues[$k], "[REDACTED:$k]") }
  return $text
}

# Retention: 14 days of runner logs.
Get-ChildItem $LogDir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) -and $_.Name -ne 'runner.lock' } | Remove-Item -Force -ErrorAction SilentlyContinue

function Get-GoalState {
  $status = Join-Path $Root 'docs\vibe\STATUS.md'
  if (-not (Test-Path $status)) { return 'missing' }
  $m = Select-String -Path $status -Pattern '^Goal state: (active|complete|blocked)\s*$' | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value } else { return 'missing' }
}

function Get-TodayCount {
  $f = Join-Path $LogDir ("count-{0}.txt" -f (Get-Date -Format 'yyyyMMdd'))
  if (Test-Path $f) { return [int](Get-Content $f) } else { return 0 }
}
function Add-TodayCount {
  $f = Join-Path $LogDir ("count-{0}.txt" -f (Get-Date -Format 'yyyyMMdd'))
  Set-Content -Path $f -Value ((Get-TodayCount) + 1)
}

try {
  $failures = 0
  while ($true) {
    # The runner, its prompt and the governance tool are locked files. Never run a tampered loop.
    & node (Join-Path $Root 'vibe\tools\governance.mjs') check *> $null
    if ($LASTEXITCODE -ne 0) { Write-Log 'governance check failed on trunk; refusing to start a session'; break }
    $prompt = Get-Content -Raw (Join-Path $Root 'vibe\goal\continue.prompt.md')
    $state = Get-GoalState
    if ($state -ne 'active') { Write-Log "goal state is '$state'; stopping"; break }
    if ((Get-TodayCount) -ge $MaxIterationsPerDay) { Write-Log "daily cap $MaxIterationsPerDay reached; stopping"; break }

    # Refresh trunk without ever discarding local work.
    $dirty = git -C $Root status --porcelain
    if ($DryRun) { }
    elseif ($dirty) { Write-Log 'trunk worktree has uncommitted changes; not refreshing (work is preserved)' }
    else {
      git -C $Root fetch --quiet origin 2>&1 | Out-Null
      git -C $Root merge --ff-only --quiet origin/vibe/main 2>&1 | Out-Null
    }

    if (-not $DryRun) { Add-TodayCount }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "vibe-goal-$stamp"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $last = Join-Path $tmp 'last.txt'
    $promptFile = Join-Path $tmp 'prompt.txt'
    Set-Content -Path $promptFile -Value $prompt -NoNewline
    Write-Log "iteration start ($stamp)"

    # Least privilege: workspace-write sandbox, writes limited to the loop's own clone and its task
    # worktrees, network on (git, gh, package registries, research). No approval prompts because
    # nobody is watching; blocked actions fail closed.
    $taskRoot = "$Root.worktrees"
    New-Item -ItemType Directory -Force -Path $taskRoot | Out-Null
    $roots = '["' + ($Root -replace '\\', '/') + '", "' + ($taskRoot -replace '\\', '/') + '"]'
    $codexArgs = @('exec', '-C', $Root, '--enable', 'goals', '-s', 'workspace-write',
      '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=true',
      '-c', "sandbox_workspace_write.writable_roots=$roots", '-o', $last, '-') |
      ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
    if ($DryRun) {
      $left = @(Get-ChildItem Env: | Where-Object { $_.Name -match $secretPattern -and $_.Name -notmatch '^(GIT_CONFIG_|GH_TOKEN$)' } | ForEach-Object Name)
      Write-Output "DRYRUN args=$($codexArgs -join ' ')"
      Write-Output "DRYRUN secrets_removed=$($script:SecretValues.Count) secret_vars_left=$($left.Count) gh_token_scoped=$([bool]$scopedGh)"
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
      break
    }
    $p = Start-Process -FilePath $Codex -ArgumentList ($codexArgs -join ' ') -RedirectStandardInput $promptFile `
      -RedirectStandardOutput (Join-Path $tmp 'out.txt') -RedirectStandardError (Join-Path $tmp 'err.txt') -WindowStyle Hidden -PassThru
    try { $p.PriorityClass = 'BelowNormal' } catch { }
    if (-not $p.WaitForExit($IterationTimeoutMinutes * 60 * 1000)) {
      Write-Log "iteration timed out after $IterationTimeoutMinutes min; stopping process tree"
      & taskkill.exe /PID $p.Id /T /F | Out-Null
    }

    # Keep only a short, redacted summary; raw streams never persist.
    $result = if (Test-Path $last) { Get-Content -Raw $last } else { '' }
    $slice = if ($result -match 'SLICE_RESULT=(\w+)') { $Matches[1] } else { 'unknown' }
    $errTail = if (Test-Path (Join-Path $tmp 'err.txt')) { (Get-Content (Join-Path $tmp 'err.txt') -Tail 20) -join "`n" } else { '' }
    Write-Log ("iteration end: exit={0} slice={1} state={2}" -f $p.ExitCode, $slice, (Get-GoalState))
    if ($slice -notin 'done', 'parked' -and $errTail) { Write-Log ("stderr tail:`n" + (Protect-Text $errTail)) }
    Set-Content -Path (Join-Path $LogDir "summary-$stamp.txt") -Value (Protect-Text (($result -split "`n" | Select-Object -Last 40) -join "`n"))
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

    if ($slice -in 'done', 'parked') { $failures = 0 } else { $failures++ }
    if ($failures -ge $MaxConsecutiveFailures) { Write-Log "$failures consecutive failed iterations; stopping until next scheduled start"; break }
    Start-Sleep -Seconds 30
  }
} finally {
  Remove-Item $lockFile -ErrorAction SilentlyContinue
}
