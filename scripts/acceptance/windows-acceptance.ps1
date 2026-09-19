<#
Cinba Windows acceptance checks for a clean standard (non-admin) user account.

Run each phase from a NEW PowerShell window as the test user:
  powershell -ExecutionPolicy Bypass -File .\windows-acceptance.ps1 -Phase pre -Installer .\Cinba-<version>-windows-x64.exe -ExpectedSha256 <sha>
  (run the installer by double-clicking it, keep "Launch Cinba" checked, finish)
  powershell -ExecutionPolicy Bypass -File .\windows-acceptance.ps1 -Phase installed -ExpectedVersion <version>
  powershell -ExecutionPolicy Bypass -File .\windows-acceptance.ps1 -Phase background
  (sign out and sign back in, then:)
  powershell -ExecutionPolicy Bypass -File .\windows-acceptance.ps1 -Phase after-signin
  powershell -ExecutionPolicy Bypass -File .\windows-acceptance.ps1 -Phase uninstall
  (reinstall with the same .exe, then:)
  powershell -ExecutionPolicy Bypass -File .\windows-acceptance.ps1 -Phase reinstalled
  powershell -ExecutionPolicy Bypass -File .\windows-acceptance.ps1 -Phase purge

Results are also appended to cinba-acceptance.log next to this script.
#>
param(
  [Parameter(Mandatory)][ValidateSet('pre', 'installed', 'background', 'after-signin', 'uninstall', 'reinstalled', 'purge')][string]$Phase,
  [string]$Installer,
  [string]$ExpectedSha256,
  [string]$ExpectedVersion
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'cinba-acceptance.log'
$state = Join-Path $PSScriptRoot 'cinba-acceptance-state'
New-Item -ItemType Directory -Force $state | Out-Null
$programDir = Join-Path $env:LOCALAPPDATA 'Programs\Cinba'
$launcher = Join-Path $programDir 'bin\cinba.exe'
$dataDir = Join-Path $env:LOCALAPPDATA 'Cinba\Data'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Cinba'
$startMenuLink = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Cinba.lnk'
$script:failures = 0
$versionPattern = if ($ExpectedVersion) { "^Cinba $([regex]::Escape($ExpectedVersion)) " } else { '^Cinba \d+\.\d+\.\d+ ' }

function Write-Result([string]$status, [string]$message) {
  $line = "{0} [{1}] {2,-5} {3}" -f (Get-Date -Format 'HH:mm:ss'), $Phase, $status, $message
  $color = @{ PASS = 'Green'; FAIL = 'Red'; INFO = 'Gray'; WARN = 'Yellow' }[$status]
  Write-Host $line -ForegroundColor $color
  Add-Content -Path $log -Value $line
  if ($status -eq 'FAIL') { $script:failures++ }
}
function Check([bool]$condition, [string]$message) { Write-Result ($(if ($condition) { 'PASS' } else { 'FAIL' })) $message }
function Info([string]$message) { Write-Result 'INFO' $message }
function Fresh-Path { [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Resolve-Cinba { $env:Path = Fresh-Path; (Get-Command cinba -ErrorAction SilentlyContinue).Source }
function Run-Cinba([string[]]$arguments) { $out = & $launcher @arguments 2>&1 | Out-String; [pscustomobject]@{ Code = $LASTEXITCODE; Text = $out.Trim() } }
function Core-Task { Get-ScheduledTask -TaskPath '\Cinba\' -TaskName 'Core' -ErrorAction SilentlyContinue }
function Port-Owner([int]$port) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { (Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)").ExecutablePath }
}
function Data-Snapshot {
  if (-not (Test-Path $dataDir)) { return @() }
  Get-ChildItem $dataDir -Recurse -File | Where-Object { $_.Name -ne 'config.json' } | Get-FileHash |
    ForEach-Object { "$($_.Hash) $($_.Path.Substring($dataDir.Length))" } | Sort-Object
}
function Installed-Checks {
  Check (Test-Path $launcher) "launcher exists at $launcher"
  Check (Test-Path $uninstallKey) 'registered in Installed apps (HKCU)'
  if (Test-Path $uninstallKey) {
    $k = Get-ItemProperty $uninstallKey
    Info "Installed apps entry: $($k.DisplayName) $($k.DisplayVersion) / $($k.Publisher)"
  }
  Check (Test-Path $startMenuLink) 'Start Menu shortcut exists'
  $desktopLinks = @(Get-ChildItem ([Environment]::GetFolderPath('Desktop')), (Join-Path $env:PUBLIC 'Desktop') -Filter '*Cinba*' -ErrorAction SilentlyContinue)
  Check ($desktopLinks.Count -eq 0) 'no desktop shortcut created'
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';'
  Check ([bool]($userPath -match [regex]::Escape((Join-Path $programDir 'bin')))) 'user PATH contains the Cinba launcher directory'
  Check (-not ([Environment]::GetEnvironmentVariable('Path', 'Machine') -match 'Cinba')) 'system PATH untouched'
  $resolved = Resolve-Cinba
  Check ($resolved -eq $launcher) "new shell resolves 'cinba' to the installed launcher ($resolved)"
}

switch ($Phase) {
  'pre' {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Check (-not $isAdmin) 'current user is a standard (non-admin) user'
    foreach ($tool in 'node', 'npm', 'git', 'pi') { Check (-not (Get-Command $tool -ErrorAction SilentlyContinue)) "no $tool on PATH" }
    Check (-not (Test-Path $programDir)) 'Cinba is not installed yet'
    Check (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'Cinba'))) 'no Cinba data yet'
    Info "Windows: $((Get-CimInstance Win32_OperatingSystem).Caption) build $([Environment]::OSVersion.Version.Build)"
    if ($Installer) {
      $hash = (Get-FileHash $Installer -Algorithm SHA256).Hash.ToLower()
      if ($ExpectedSha256) { Check ($hash -eq $ExpectedSha256.ToLower()) "installer SHA-256 matches ($hash)" } else { Info "installer SHA-256 $hash" }
      $zone = Get-Content $Installer -Stream Zone.Identifier -ErrorAction SilentlyContinue
      Info "installer Zone.Identifier: $(if ($zone) { ($zone -join ' ') } else { 'none (SmartScreen may not prompt)' })"
      Info "signature: $((Get-AuthenticodeSignature $Installer).Status)"
    }
    [Environment]::GetEnvironmentVariable('Path', 'User') | Set-Content (Join-Path $state 'path-before.txt')
    Write-Host "`nNow double-click the installer. Note whether SmartScreen appears and whether it matches the release notes ('More info' -> 'Run anyway'). Note whether any UAC prompt appears (it must not)." -ForegroundColor Cyan
  }
  'installed' {
    Installed-Checks
    $version = Run-Cinba @('version'); Check ($version.Code -eq 0 -and $version.Text -match $versionPattern) "cinba version: $($version.Text)"
    $doctor = Run-Cinba @('doctor'); Check ($doctor.Code -eq 0) 'cinba doctor reports ready'; Info $doctor.Text
    Check (-not (Core-Task)) 'no Background task registered after first launch'
    $owner = Port-Owner 4517; Info "port 4517 owner: $(if ($owner) { $owner } else { 'none' })"
    Write-Host "`nManual checks now: open Cinba from the Start Menu; open a new terminal and run 'cinba' (TUI) and send one message; confirm the Desktop connects." -ForegroundColor Cyan
  }
  'background' {
    $set = Run-Cinba @('core', 'mode', 'background'); Check ($set.Code -eq 0) "switch Core to background: $($set.Text -replace "`r?`n", ' | ')"
    Start-Sleep 5
    $task = Core-Task; Check ([bool]$task) 'scheduled task \Cinba\Core registered'
    if ($task) {
      Check ($task.State -eq 'Running') "task state is Running ($($task.State))"
      Check ($task.Principal.RunLevel -eq 'Limited') 'task runs without elevation (Limited)'
      Check ($task.Principal.LogonType -eq 'Interactive') 'task uses the interactive token (no stored password)'
      Check ($task.Actions[0].Execute -eq $launcher) 'task points at the stable launcher'
    }
    $owner = Port-Owner 4517; Check ($owner -and $owner -notlike '*\desktop\*') "port 4517 held by the service, not Desktop ($owner)"
    Write-Host "`nClose Desktop completely (tray -> Quit Cinba), confirm Core still runs, then sign out and sign back in and run -Phase after-signin." -ForegroundColor Cyan
  }
  'after-signin' {
    Start-Sleep 10
    $owner = Port-Owner 4517; Check ([bool]$owner) "Core running after sign-in ($owner)"
    $mode = Run-Cinba @('core', 'mode'); Check ($mode.Text -match 'background' -and $mode.Text -match 'healthy') "mode: $($mode.Text -replace "`r?`n", ' | ')"
    $back = Run-Cinba @('core', 'mode', 'on-demand'); Check ($back.Code -eq 0) 'switch back to on-demand'
    Start-Sleep 3
    Check (-not (Core-Task)) 'scheduled task removed after switching back'
  }
  'uninstall' {
    $marker = Join-Path $dataDir 'acceptance-marker.txt'
    Set-Content $marker "acceptance $(Get-Date -Format o)"
    Data-Snapshot | Set-Content (Join-Path $state 'data-before.txt')
    Info 'running ordinary uninstall (the same command the Installed apps entry runs)'
    & $launcher uninstall
    for ($i = 0; $i -lt 60 -and (Test-Path $programDir); $i++) { Start-Sleep 2 }
    Check (-not (Test-Path $programDir)) 'program directory removed'
    Check (-not (Test-Path $uninstallKey)) 'Installed apps entry removed'
    Check (-not (Test-Path $startMenuLink)) 'Start Menu shortcut removed'
    Check (-not (Core-Task)) 'no scheduled task left'
    Check (-not ([Environment]::GetEnvironmentVariable('Path', 'User') -match 'Programs\\Cinba')) 'user PATH entry removed'
    $diff = Compare-Object (Get-Content (Join-Path $state 'data-before.txt')) (Data-Snapshot)
    Check (-not $diff) 'persistent data kept unchanged'
    Check (@(Get-ChildItem $env:TEMP -Directory -Filter 'cinba-uninstall-*').Count -eq 0) 'no uninstall helper left in %TEMP%'
    Write-Host "`nNow reinstall with the same installer, then run -Phase reinstalled." -ForegroundColor Cyan
  }
  'reinstalled' {
    Installed-Checks
    Check (Test-Path (Join-Path $dataDir 'acceptance-marker.txt')) 'data from before the uninstall is back'
    $diff = Compare-Object (Get-Content (Join-Path $state 'data-before.txt')) (Data-Snapshot)
    Check (-not $diff) 'restored data matches the snapshot'
  }
  'purge' {
    Write-Host 'Interactive purge: first type something else to confirm it is refused, then run this phase again and type the exact phrase.' -ForegroundColor Cyan
    & $launcher uninstall --purge
    for ($i = 0; $i -lt 60 -and (Test-Path $programDir); $i++) { Start-Sleep 2 }
    if (Test-Path $programDir) {
      Check (Test-Path $dataDir) 'refused purge left program and data in place'
    } else {
      Check (-not (Test-Path $dataDir)) 'purge removed all Cinba data'
      Check (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'Cinba'))) 'no empty Cinba data root left'
      Check (-not (Test-Path $uninstallKey)) 'Installed apps entry removed'
      $before = Get-Content (Join-Path $state 'path-before.txt') -ErrorAction SilentlyContinue
      Check ($before -eq [Environment]::GetEnvironmentVariable('Path', 'User')) 'user PATH identical to before install'
    }
  }
}

$summary = if ($script:failures -eq 0) { 'all checks passed' } else { "$($script:failures) check(s) FAILED" }
Write-Result ($(if ($script:failures -eq 0) { 'PASS' } else { 'FAIL' })) "phase summary: $summary"
