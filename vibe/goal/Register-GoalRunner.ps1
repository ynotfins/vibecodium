<#
.SYNOPSIS
  Registers (or removes) the hidden scheduled task that keeps the Vibecodium goal loop running.

.DESCRIPTION
  Task "Vibecodium Goal Runner": at logon and every 30 minutes, start run-goal.ps1 if it is not
  already running. The runner exits immediately when another instance holds the lock or the goal
  is complete or blocked, so idle cost is one short process start per 30 minutes.
  Silent by construction: conhost.exe --headless wrapping pwsh -WindowStyle Hidden, task Hidden=true,
  below-normal priority, no focus changes.
#>
param(
  [Parameter(Mandatory)] [string]$Root,
  [switch]$Unregister,
  [string]$TaskName = 'Vibecodium Goal Runner'
)

$ErrorActionPreference = 'Stop'
if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "Removed scheduled task '$TaskName'."
  return
}

$Root = (Resolve-Path $Root).Path
$runner = Join-Path $Root 'vibe\goal\run-goal.ps1'
if (-not (Test-Path $runner)) { throw "runner not found: $runner" }
# Only register for a genuine Vibecodium trunk checkout whose governance lock passes.
$origin = git -C $Root remote get-url origin 2>$null
if ($origin -notmatch 'github\.com[/:]ynotfins/vibecodium(\.git)?$') { throw "origin is not ynotfins/vibecodium: $origin" }
if ((git -C $Root branch --show-current) -ne 'vibe/main') { throw 'Root must be a worktree on branch vibe/main' }
if (-not (Select-String -Path (Join-Path $Root 'AGENTS.md') -Pattern 'Vibecodium' -Quiet)) { throw 'AGENTS.md does not look like Vibecodium' }
& node (Join-Path $Root 'vibe\tools\governance.mjs') check | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'governance check failed; refusing to register' }
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$conhost = Join-Path $env:WINDIR 'System32\conhost.exe'

# -ExecutionPolicy Bypass is required by this workstation's silent-automation policy for unsigned
# task scripts. Mitigations: the runner, its prompt and this script are governance-locked files, and
# the runner refuses to start a session when the governance check fails.
$argLine = "--headless `"$pwsh`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Root `"$Root`""
$action = New-ScheduledTaskAction -Execute $conhost -Argument $argLine -WorkingDirectory $Root
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)
$settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 72) -Priority 7
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atLogon, $repeat) -Settings $settings `
  -Principal $principal -Description 'Autonomous Vibecodium build loop (vibe/goal/run-goal.ps1). Silent; logs to %LOCALAPPDATA%\Vibecodium\goal-runner.' -Force | Out-Null
Write-Output "Registered scheduled task '$TaskName' for $Root"
