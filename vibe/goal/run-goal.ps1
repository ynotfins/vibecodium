<#
.SYNOPSIS
  Autonomous goal loop for the Vibecodium build (ADR-0008).

.DESCRIPTION
  Each iteration starts a fresh agent session in the dedicated clone. The harness depends on the
  chosen provider (vibe/goal/models.json): OmniRoute (forced unless unavailable) runs Codex BYOK
  with the OS sandbox; the fallbacks (Morph direct, DeepInfra) run OpenCode, because Codex does not
  support their API format. Guardians are sub-agents; each gets the model for its model_class.
  The Morph tools (WarpGrep, Fast Apply, GitHub search) are configured for both harnesses.

  The loop stops when docs/vibe/STATUS.md says "Goal state: complete" or "Goal state: blocked",
  when the daily iteration cap is reached, when no provider answers, after repeated failures, or
  when this script changes on trunk (the scheduler then starts the new version).
  A lock file prevents concurrent runs. Designed to run hidden (see Register-GoalRunner.ps1).

  Isolation (docs/vibe/GOVERNANCE.md §5 "Enforcement"):
  - Root is a dedicated clone used only by the loop.
  - Every secret-looking environment variable is removed before the agent starts, except the model
    provider keys in $AllowedProviderKeys and GH_TOKEN. GH_TOKEN comes from VIBECODIUM_GH_TOKEN
    (a fine-grained token scoped to ynotfins/vibecodium) when it exists.
  - Codex runs with its own home folder (no subscription login, no user config) and writes limited
    to the clone and its .worktrees folder; OpenCode runs with its own config and data folders and
    a hard-stop deny list. Neither can see the owner's normal agent setup.

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
  [string]$OpenCode = '',
  # Use this provider from vibe/goal/models.json instead of health-checking (tests, manual runs).
  [string]$Provider = '',
  # Print the session command line, the chosen provider and the environment check, then exit.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path $Root).Path.TrimEnd('\')
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$log = Join-Path $LogDir ("run-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
function Write-Log([string]$m) { Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format 's'), $m) }

try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch { }

if (-not $Codex) { $Codex = (Get-Command codex.cmd -ErrorAction Stop).Source }
if (-not $OpenCode) { $OpenCode = (Get-Command opencode -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }

# Git uses the GitHub CLI (and therefore GH_TOKEN) as its credential helper, for this process tree
# only. OpenSSL is used because the elevated Codex sandbox cannot use Windows certificate channels.
$env:GIT_CONFIG_COUNT = '3'
$env:GIT_CONFIG_KEY_0 = 'credential.helper'; $env:GIT_CONFIG_VALUE_0 = ''
$env:GIT_CONFIG_KEY_1 = 'credential.helper'; $env:GIT_CONFIG_VALUE_1 = '!gh auth git-credential'
$env:GIT_CONFIG_KEY_2 = 'safe.directory'; $env:GIT_CONFIG_VALUE_2 = '*'
$env:GIT_SSL_BACKEND = 'openssl'

# Single instance.
$lockFile = Join-Path $LogDir 'runner.lock'
if (Test-Path $lockFile) {
  $old = Get-Content $lockFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($old -and (Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue)) { exit 0 }
}
Set-Content -Path $lockFile -Value $PID

# Remove secret-looking environment variables (children inherit the reduced set). Values are kept in
# memory only: provider keys are restored below, the rest are used only to redact summaries.
$AllowedProviderKeys = @('OMNIROUTE_API_KEY', 'MORPH_API_KEY', 'DEEPINFRA_API_KEY')
$secretPattern = 'KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|_AUTH|AUTH_|DATABASE_URL|_DSN$'
$script:SecretValues = @{}
foreach ($e in @(Get-ChildItem Env:)) {
  if ($e.Name -match $secretPattern -and $e.Name -notmatch '^GIT_CONFIG_') {
    if ($e.Value -and $e.Value.Length -ge 8) { $script:SecretValues[$e.Name] = $e.Value }
    Remove-Item -LiteralPath "Env:$($e.Name)"
  }
}
foreach ($k in $AllowedProviderKeys) { if ($script:SecretValues.ContainsKey($k)) { Set-Item -LiteralPath "Env:$k" -Value $script:SecretValues[$k] } }
$ghSource = @('VIBECODIUM_GH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN') | Where-Object { $script:SecretValues.ContainsKey($_) } | Select-Object -First 1
if ($ghSource) { $env:GH_TOKEN = $script:SecretValues[$ghSource] }
if ($ghSource -ne 'VIBECODIUM_GH_TOKEN') { Write-Log "VIBECODIUM_GH_TOKEN is not set; GitHub access uses $(if ($ghSource) { $ghSource } else { 'nothing' }) (broader scope)" }

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

function Get-TreeIds([int]$RootId) {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootId)
  do {
    $added = $false
    foreach ($x in $all) { if ($ids.Contains([int]$x.ParentProcessId) -and $ids.Add([int]$x.ProcessId)) { $added = $true } }
  } while ($added)
  return $ids
}

function Set-TreeBelowNormal([int]$RootId) {
  foreach ($id in (Get-TreeIds $RootId)) {
    try {
      $pr = Get-Process -Id $id -ErrorAction Stop
      if ($pr.PriorityClass -notin 'BelowNormal', 'Idle') { $pr.PriorityClass = 'BelowNormal' }
    } catch { }
  }
}

function Get-TodayCount {
  $f = Join-Path $LogDir ("count-{0}.txt" -f (Get-Date -Format 'yyyyMMdd'))
  if (Test-Path $f) { return [int](Get-Content $f) } else { return 0 }
}
function Add-TodayCount {
  $f = Join-Path $LogDir ("count-{0}.txt" -f (Get-Date -Format 'yyyyMMdd'))
  Set-Content -Path $f -Value ((Get-TodayCount) + 1)
}

function Get-Models {
  $models = Get-Content -Raw (Join-Path $Root 'vibe\goal\models.json') | ConvertFrom-Json
  foreach ($name in $models.order) {
    $p = $models.providers.$name
    if ($p.keyEnv -notin $AllowedProviderKeys) { throw "models.json: provider '$name' uses key '$($p.keyEnv)', which the runner does not allow" }
    if ($p.harness -notin 'codex', 'opencode') { throw "models.json: provider '$name' must set harness to 'codex' or 'opencode'" }
    if ($p.harness -eq 'codex' -and $name -ne 'omniroute') { throw "models.json: '$name' cannot use the codex harness; Codex does not support its API format (OmniRoute only)" }
  }
  return $models
}

# First provider in models.order whose /models endpoint answers. OmniRoute is forced unless down.
function Select-Provider($models) {
  if ($Provider) { return $Provider }
  foreach ($name in $models.order) {
    $p = $models.providers.$name
    $key = $script:SecretValues[$p.keyEnv]
    if (-not $key) { Write-Log "provider $name skipped: $($p.keyEnv) is not set"; continue }
    try {
      $r = Invoke-WebRequest -Uri ($p.baseURL.TrimEnd('/') + '/models') -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 15 -UseBasicParsing
      if ($r.StatusCode -eq 200) { return $name }
    } catch { Write-Log "provider $name unavailable: $(Protect-Text $_.Exception.Message)" }
  }
  return $null
}

# Hard-stop shell commands are denied in the OpenCode fallback (docs/vibe/GOVERNANCE.md §5).
$DeniedCommands = @(
  'git push --force*', 'git push -f*', 'git push * --force*', 'git push * -f*', 'git push --delete*', 'git push * --delete*', 'git push * :*',
  'git config --global*', 'git config --system*',
  'gh release create*', 'gh release edit*', 'gh release delete*', 'gh release upload*',
  'gh repo delete*', 'gh repo edit*', 'gh repo archive*', 'gh secret*', 'gh variable*', 'gh auth*',
  'gh api * -X DELETE*', 'gh api * --method DELETE*', 'gh api -X DELETE*', 'gh api --method DELETE*',
  'npm publish*', 'pnpm publish*', 'yarn publish*', 'winget *', 'choco *',
  'env', 'printenv*', 'set', 'Get-ChildItem Env:*', 'gci env:*', 'dir env:*', 'ls env:*', '*GetEnvironmentVariable*',
  'schtasks*', '*Register-ScheduledTask*', 'reg add*', 'reg delete*', 'format *', 'diskpart*',
  'rm -rf /*', 'rm -rf ~*', 'rm -rf C:*', 'rm -rf /c*', 'rm -rf /d*', 'Remove-Item * -Recurse* C:\*'
)

# Mechanical hard-stop guard for both harnesses. The OpenCode config denies these patterns directly;
# Codex has no deny rules, so a guard folder is put first on PATH with shims for the commands that can
# cross a hard stop. Shims forward to the real executable after checking the same pattern list.
function Write-GuardShims([string]$dir) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Set-Content -Path (Join-Path $dir 'deny.txt') -Value ($DeniedCommands | ConvertTo-Json) -Encoding utf8NoBOM
  $guardPs1 = @'
param([string]$Cmd, [string]$Real, [string]$Mode, [Parameter(ValueFromRemainingArguments = $true)] [string[]]$Rest)
$line = (@($Cmd) + $Rest) -join ' '
if ($Mode -eq 'always') { [Console]::Error.WriteLine("Vibecodium guard: '$Cmd' is blocked in the build loop"); exit 1 }
foreach ($p in (Get-Content -Raw (Join-Path $PSScriptRoot 'deny.txt') | ConvertFrom-Json)) {
  if ($line -like $p) { [Console]::Error.WriteLine("Vibecodium guard: blocked hard-stop command: $line"); exit 1 }
}
& $Real @Rest
exit $LASTEXITCODE
'@
  Set-Content -Path (Join-Path $dir 'guard.ps1') -Value $guardPs1 -Encoding utf8NoBOM
  # Resolve the real programs before this folder joins PATH.
  $targets = [ordered]@{
    git = @{ mode = 'check' }; gh = @{ mode = 'check' }; npm = @{ mode = 'check' }; pnpm = @{ mode = 'check' }; yarn = @{ mode = 'check' }
    winget = @{ mode = 'always' }; choco = @{ mode = 'always' }; schtasks = @{ mode = 'always' }; reg = @{ mode = 'always' }; diskpart = @{ mode = 'always' }
  }
  $pwshPath = (Get-Process -Id $PID).Path
  foreach ($name in $targets.Keys) {
    $real = $null
    foreach ($ext in '.exe', '.cmd', '.bat') {
      $c = Get-Command ($name + $ext) -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike "$dir*" } | Select-Object -First 1
      if ($c) { $real = $c.Source; break }
    }
    if (-not $real -and $targets[$name].mode -eq 'check') { continue }
    $shim = "@echo off`r`n`"$pwshPath`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"%~dp0guard.ps1`" $name `"$real`" $($targets[$name].mode) %*`r`n"
    Set-Content -Path (Join-Path $dir "$name.cmd") -Value $shim -Encoding ascii
  }
  return $dir
}

function Get-AgentDefs {
  $defs = @()
  foreach ($f in Get-ChildItem (Join-Path $Root '.vibe\agents') -Filter *.md) {
    $t = Get-Content -Raw $f.FullName
    $defs += [pscustomobject]@{
      name = $f.BaseName
      model_class = ([regex]::Match($t, '(?m)^model_class:\s*(\w+)')).Groups[1].Value
      sandbox = ([regex]::Match($t, '(?m)^sandbox:\s*(\S+)')).Groups[1].Value
      description = ([regex]::Match($t, '(?m)^description:\s*(.+)$')).Groups[1].Value.Trim()
      body = ([regex]::Match($t, '(?s)---.*?---\s*(.+)$')).Groups[1].Value.Trim()
    }
  }
  return $defs
}

# Codex gets its own home folder: no subscription login (auth.json can never exist there), no user
# config, generated agents TOML with the model for each class, the Morph tools through cmd (npx is a
# .cmd script on Windows), writes limited to the clone and its .worktrees folder.
function Write-CodexConfig($models, [string]$chosen, [string]$codexHome) {
  $defs = Get-AgentDefs
  $p = $models.providers.$chosen
  $classes = $p.classes
  $rootToml = $Root -replace '\\', '/'
  $worktrees = $rootToml + '.worktrees'
  New-Item -ItemType Directory -Force -Path (Join-Path $codexHome 'agents') | Out-Null
  $cfg = @"
model_provider = "$chosen"
model = "$($classes.standard)"
approval_policy = "never"
sandbox_mode = "workspace-write"
web_search = "disabled"

[sandbox_workspace_write]
network_access = true
writable_roots = ["$rootToml", "$worktrees"]

[windows]
sandbox = "elevated"

[model_providers.$chosen]
name = "$($p.name)"
base_url = "$($p.baseURL)"
wire_api = "responses"
env_key = "$($p.keyEnv)"
requires_openai_auth = false

[mcp_servers.morph]
command = "cmd"
args = ["/c", "npx", "-y", "@morphllm/morphmcp@$($models.morphMcpVersion)"]
env_vars = ["MORPH_API_KEY"]
startup_timeout_sec = 60
"@
  Set-Content -Path (Join-Path $codexHome 'config.toml') -Value $cfg -Encoding utf8NoBOM
  foreach ($a in $defs) {
    $toml = @"
name = "$($a.name)"
description = "$($a.description.Replace('"', '\"'))"
model = "$($classes.($a.model_class))"
sandbox_mode = "$(if ($a.sandbox -eq 'read-only') { 'read-only' } else { 'workspace-write' })"
developer_instructions = '''
$($a.body)
'''
"@
    Set-Content -Path (Join-Path $codexHome "agents\$($a.name).toml") -Value $toml -Encoding utf8NoBOM
  }
  return $codexHome
}

# Generated OpenCode config (fallback harness): our providers, per-agent models, Morph tools, denies.
function Write-OpenCodeConfig($models, [string]$chosen, [string]$configDir) {
  $providers = [ordered]@{}
  foreach ($name in $models.order) {
    $p = $models.providers.$name
    $m = [ordered]@{}
    foreach ($id in ($p.classes.PSObject.Properties.Value | Sort-Object -Unique)) { $m[$id] = @{ name = $id } }
    $providers[$name] = [ordered]@{ npm = '@ai-sdk/openai-compatible'; name = $p.name; options = [ordered]@{ baseURL = $p.baseURL; apiKey = "{env:$($p.keyEnv)}" }; models = $m }
  }
  $classes = $models.providers.$chosen.classes
  $agents = [ordered]@{}
  foreach ($a in (Get-AgentDefs)) { $agents[$a.name] = @{ model = "$chosen/$($classes.($a.model_class))" } }
  $agents['compaction'] = @{ model = "$chosen/$($classes.cheap)" }
  $bash = [ordered]@{ '*' = 'allow' }
  foreach ($d in $DeniedCommands) { $bash[$d] = 'deny' }
  $cfg = [ordered]@{
    '$schema' = 'https://opencode.ai/config.json'
    model = "$chosen/$($classes.standard)"
    small_model = "$chosen/$($classes.cheap)"
    autoupdate = $false
    share = 'disabled'
    provider = $providers
    agent = $agents
    mcp = @{ morph = [ordered]@{ type = 'local'; command = @('cmd', '/c', 'npx', '-y', "@morphllm/morphmcp@$($models.morphMcpVersion)"); environment = @{ MORPH_API_KEY = '{env:MORPH_API_KEY}' }; enabled = $true } }
    permission = [ordered]@{ edit = 'allow'; webfetch = 'allow'; external_directory = 'allow'; doom_loop = 'allow'; bash = $bash }
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $configDir 'opencode') | Out-Null
  $file = Join-Path $configDir 'opencode\opencode.json'
  Set-Content -Path $file -Value ($cfg | ConvertTo-Json -Depth 10) -Encoding utf8NoBOM
  return $file
}

$selfHash = (Get-FileHash -LiteralPath $PSCommandPath).Hash

try {
  $failures = 0
  while ($true) {
    # The runner, its prompt and the governance tool are locked files. Never run a tampered loop.
    & node (Join-Path $Root 'vibe\tools\governance.mjs') check *> $null
    if ($LASTEXITCODE -ne 0) { Write-Log 'governance check failed on trunk; refusing to start a session'; break }
    $state = Get-GoalState
    if ($state -ne 'active') { Write-Log "goal state is '$state'; stopping"; break }
    if ((Get-TodayCount) -ge $MaxIterationsPerDay) { Write-Log "daily cap $MaxIterationsPerDay reached; stopping"; break }

    # Refresh trunk without ever discarding local work.
    if (-not $DryRun) {
      if (git -C $Root status --porcelain) { Write-Log 'trunk has uncommitted changes; not refreshing (work is preserved)' }
      else {
        git -C $Root fetch --quiet origin 2>&1 | Out-Null
        git -C $Root merge --ff-only --quiet origin/vibe/main 2>&1 | Out-Null
      }
    }

    # A merged change to this script takes effect on the next scheduled start, not mid-loop.
    if ((Get-FileHash -LiteralPath $PSCommandPath).Hash -ne $selfHash) {
      Write-Log 'runner script changed on trunk; exiting so the scheduler starts the new version'
      break
    }

    $models = Get-Models
    $chosen = Select-Provider $models
    if (-not $chosen) { Write-Log 'no model provider answered; stopping until the next scheduled start'; break }
    $classes = $models.providers.$chosen.classes
    $harness = $models.providers.$chosen.harness

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "vibe-goal-$stamp"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $promptFile = Join-Path $tmp 'continue.prompt.md'
    Copy-Item (Join-Path $Root 'vibe\goal\continue.prompt.md') $promptFile

    if ($harness -eq 'codex') {
      # Own home folder; auth.json must never exist here (a subscription cannot be used).
      $env:CODEX_HOME = Join-Path $LogDir 'codex-home'
      Write-CodexConfig $models $chosen $env:CODEX_HOME | Out-Null
      if (Test-Path (Join-Path $env:CODEX_HOME 'auth.json')) { Write-Log 'refusing: auth.json in the loop Codex home (would use the subscription)'; break }
      $exe = $Codex
      $cmdArgs = "exec -C `"$Root`" --skip-git-repo-check"
      $stdinFile = $promptFile
      $modelDesc = "$chosen/$($classes.standard) (codex BYOK)"
      Remove-Item Env:XDG_CONFIG_HOME, Env:XDG_DATA_HOME -ErrorAction SilentlyContinue
    } else {
      # Own config and data folders: no user config, MCP servers or session history leak in or out.
      $ocHome = Join-Path $LogDir 'opencode-home'
      $env:XDG_CONFIG_HOME = (Join-Path $ocHome 'config') -replace '\\', '/'
      $env:XDG_DATA_HOME = (Join-Path $ocHome 'data') -replace '\\', '/'
      Write-OpenCodeConfig $models $chosen (Join-Path $ocHome 'config') | Out-Null
      $exe = $OpenCode
      # The message must come before -f: OpenCode's -f takes every following positional as a file.
      $cmdArgs = 'run "Follow the attached file exactly. It is your complete instruction set for this session." ' +
        "--agent vibe-overseer -m $chosen/$($classes.standard) --dir `"$Root`" -f `"$promptFile`""
      $stdinFile = $null
      $modelDesc = "$chosen/$($classes.standard) (opencode)"
    }

    $guardDir = Write-GuardShims (Join-Path $LogDir 'guard')
    $env:PATH = "$guardDir;$env:PATH"

    if (-not $DryRun) { Add-TodayCount }
    Write-Log "iteration start ($stamp) harness=$harness provider=$chosen model=$modelDesc"

    if ($DryRun) {
      $left = @(Get-ChildItem Env: | Where-Object { $_.Name -match $secretPattern -and $_.Name -notmatch '^GIT_CONFIG_' -and $_.Name -notin ($AllowedProviderKeys + 'GH_TOKEN') } | ForEach-Object Name)
      Write-Output "DRYRUN harness=$harness provider=$chosen guard=$guardDir"
      Write-Output "DRYRUN args=$cmdArgs stdin=$stdinFile"
      Write-Output "DRYRUN secrets_removed=$($script:SecretValues.Count) secret_vars_left=$($left.Count) gh_token_source=$ghSource"
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
      break
    }
    $startArgs = @{
      FilePath = $exe
      ArgumentList = $cmdArgs
      WorkingDirectory = $Root
      RedirectStandardOutput = Join-Path $tmp 'out.txt'
      RedirectStandardError = Join-Path $tmp 'err.txt'
      WindowStyle = 'Hidden'
      PassThru = $true
    }
    if ($stdinFile) { $startArgs.RedirectStandardInput = $stdinFile }
    $p = Start-Process @startArgs
    # Keep the whole session tree below normal priority.
    $deadline = (Get-Date).AddMinutes($IterationTimeoutMinutes)
    Start-Sleep -Seconds 5
    Set-TreeBelowNormal $p.Id
    while (-not $p.WaitForExit(30000)) {
      Set-TreeBelowNormal $p.Id
      if ((Get-Date) -gt $deadline) {
        Write-Log "iteration timed out after $IterationTimeoutMinutes min; stopping process tree"
        & taskkill.exe /PID $p.Id /T /F | Out-Null
        break
      }
    }

    # Keep only a short, redacted summary; raw streams never persist.
    $result = if (Test-Path (Join-Path $tmp 'out.txt')) { Get-Content -Raw (Join-Path $tmp 'out.txt') } else { '' }
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
