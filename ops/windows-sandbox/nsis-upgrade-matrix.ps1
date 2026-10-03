$ErrorActionPreference = 'Stop'

$artifactDirectory = 'C:\Installers'
$outputDirectory = 'C:\TestOutput'
$legacyPayloadDirectory = 'C:\LegacyPayload'
$applicationId = '56dc736c-fb34-5eb0-a341-bbb1656dcc84'
$finalVersion = '1.1.1'
$installKeyPath = "HKCU:\Software\$applicationId"
$uninstallKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$applicationId"
$userDataRoot = Join-Path $env:APPDATA 'novda-hisob-kitob'
$sqlitePath = Join-Path $userDataRoot 'NovdaData\companies\comp_novda\hisob.sqlite'
$credentialMarkerPath = Join-Path $userDataRoot 'credentials\comp_novda.enc.json'
$fixturePath = Join-Path $outputDirectory 'nsis-upgrade-fixture.sqlite'
$reportPath = Join-Path $outputDirectory 'nsis-upgrade-matrix.json'
$results = [System.Collections.Generic.List[object]]::new()

function Get-InstallState {
  $install = Get-ItemProperty -LiteralPath $installKeyPath -ErrorAction SilentlyContinue
  $uninstall = Get-ItemProperty -LiteralPath $uninstallKeyPath -ErrorAction SilentlyContinue
  $uninstallerPath = $null
  if ($uninstall.UninstallString -match '^"(?<path>[^"]+)"') {
    $uninstallerPath = $Matches.path
  }

  $installLocation = $install.InstallLocation
  $executablePath = if ($installLocation) { Join-Path $installLocation 'Novda-hisob-kitob.exe' } else { $null }
  $asarPath = if ($installLocation) { Join-Path $installLocation 'resources\app.asar' } else { $null }

  [pscustomobject]@{
    InstallRegistryPath = $installKeyPath
    UninstallRegistryPath = $uninstallKeyPath
    InstallLocation = $installLocation
    DisplayName = $uninstall.DisplayName
    DisplayVersion = $uninstall.DisplayVersion
    UninstallString = $uninstall.UninstallString
    QuietUninstallString = $uninstall.QuietUninstallString
    UninstallerPath = $uninstallerPath
    UninstallerExists = [bool]($uninstallerPath -and (Test-Path -LiteralPath $uninstallerPath))
    UninstallerProductVersion = if ($uninstallerPath -and (Test-Path -LiteralPath $uninstallerPath)) {
      (Get-Item -LiteralPath $uninstallerPath).VersionInfo.ProductVersion
    } else { $null }
    UninstallerSha256 = if ($uninstallerPath -and (Test-Path -LiteralPath $uninstallerPath)) {
      (Get-FileHash -LiteralPath $uninstallerPath -Algorithm SHA256).Hash
    } else { $null }
    ExecutablePath = $executablePath
    ExecutableProductVersion = if ($executablePath -and (Test-Path -LiteralPath $executablePath)) {
      (Get-Item -LiteralPath $executablePath).VersionInfo.ProductVersion
    } else { $null }
    AsarPath = $asarPath
    AsarSha256 = if ($asarPath -and (Test-Path -LiteralPath $asarPath)) {
      (Get-FileHash -LiteralPath $asarPath -Algorithm SHA256).Hash
    } else { $null }
  }
}

function Get-InstallDirectoryProcesses([string]$installLocation) {
  if (-not $installLocation) { return @() }
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installLocation, [StringComparison]::OrdinalIgnoreCase)
  } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine)
}

function Get-Shortcuts([string]$installLocation) {
  $searchRoots = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
  )
  $shell = New-Object -ComObject WScript.Shell
  $shortcuts = foreach ($root in $searchRoots) {
    if (Test-Path -LiteralPath $root) {
      Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'Novda|Hisob' } |
        ForEach-Object {
          $shortcut = $shell.CreateShortcut($_.FullName)
          [pscustomobject]@{ Path = $_.FullName; TargetPath = $shortcut.TargetPath }
        }
    }
  }
  @($shortcuts | Where-Object { $_.TargetPath -eq (Join-Path $installLocation 'Novda-hisob-kitob.exe') })
}

function Invoke-Installer([string]$version, [string]$label) {
  $installerPath = Join-Path $artifactDirectory "Novda-hisob-kitob-Setup-$version-win10-11-x64.exe"
  if (-not (Test-Path -LiteralPath $installerPath)) { throw "Missing installer: $installerPath" }

  $process = Start-Process -FilePath $installerPath -ArgumentList '/S' -PassThru
  $childCommands = [System.Collections.Generic.List[object]]::new()
  $deadline = [DateTime]::UtcNow.AddMinutes(8)
  while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Get-CimInstance Win32_Process | Where-Object {
      $_.CommandLine -and $_.CommandLine -match 'old-uninstaller\.exe|_\?='
    } | ForEach-Object {
      $entry = [pscustomobject]@{
        ObservedAt = [DateTime]::UtcNow.ToString('o')
        ProcessId = $_.ProcessId
        ParentProcessId = $_.ParentProcessId
        ExecutablePath = $_.ExecutablePath
        CommandLine = $_.CommandLine
      }
      if (-not ($childCommands | Where-Object { $_.ProcessId -eq $entry.ProcessId -and $_.CommandLine -eq $entry.CommandLine })) {
        $childCommands.Add($entry)
      }
    }
    Start-Sleep -Milliseconds 125
    $process.Refresh()
  }

  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Installer timed out during $($label): $installerPath"
  }

  [pscustomobject]@{
    Label = $label
    InstallerPath = $installerPath
    InstallerCommandLine = "`"$installerPath`" /S"
    ExitCode = $process.ExitCode
    NsIsTextLogAvailable = $false
    LogNote = 'The shipped NSIS binary is not debug-logging-enabled; process and registry evidence was captured.'
    UninstallerProcessObservations = @($childCommands)
  }
}

function Reset-Install([switch]$ClearTestUserData) {
  $state = Get-InstallState
  if ($state.InstallLocation -and (Test-Path -LiteralPath $state.InstallLocation)) {
    Get-InstallDirectoryProcesses $state.InstallLocation | ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $state.InstallLocation -Recurse -Force
  }
  Remove-Item -LiteralPath $installKeyPath -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $uninstallKeyPath -Recurse -Force -ErrorAction SilentlyContinue
  if ($ClearTestUserData) {
    Remove-Item -LiteralPath $userDataRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Add-Scenario([string]$name, $installerResult, $preState, $postState, $processesBefore, $processesAfter, [bool]$userDataPreserved) {
  $shortcuts = if ($postState.InstallLocation) { @(Get-Shortcuts $postState.InstallLocation) } else { @() }
  $pass = $installerResult.ExitCode -eq 0 `
    -and $postState.DisplayVersion -eq $finalVersion `
    -and $postState.ExecutableProductVersion -eq "$finalVersion.0" `
    -and $postState.UninstallerProductVersion -eq $finalVersion `
    -and $postState.UninstallerExists `
    -and $processesAfter.Count -eq 0 `
    -and $shortcuts.Count -ge 1

  $results.Add([pscustomobject]@{
    Name = $name
    Pass = $pass
    Installer = $installerResult
    PreInstallState = $preState
    PostInstallState = $postState
    ProcessesBeforeInstaller = @($processesBefore)
    ProcessesAfterInstaller = @($processesAfter)
    FinalShortcutsTargetingInstalledExe = $shortcuts
    UserDataPreservedByteForByte = $userDataPreserved
  })

  if (-not $pass) { throw "Installer matrix scenario failed: $name" }
}

function Install-OldAndSeedUserData {
  $oldInstall = Invoke-Installer '1.7.12' 'fixture install 1.7.12'
  if ($oldInstall.ExitCode -ne 0) { throw 'The isolated 1.7.12 fixture install failed.' }
  $oldState = Get-InstallState
  if (-not $oldState.InstallLocation -or -not $oldState.UninstallerExists) {
    throw 'The 1.7.12 fixture install did not register its location and uninstaller.'
  }

  New-Item -ItemType Directory -Path (Split-Path -Parent $sqlitePath) -Force | Out-Null
  New-Item -ItemType Directory -Path (Split-Path -Parent $credentialMarkerPath) -Force | Out-Null
  Copy-Item -LiteralPath $fixturePath -Destination $sqlitePath -Force
  [System.IO.File]::WriteAllText($credentialMarkerPath, 'sandbox-only DPAPI credential preservation marker')

  [pscustomobject]@{
    Installer = $oldInstall
    State = Get-InstallState
    SQLiteSha256 = (Get-FileHash -LiteralPath $sqlitePath -Algorithm SHA256).Hash
    CredentialMarkerSha256 = (Get-FileHash -LiteralPath $credentialMarkerPath -Algorithm SHA256).Hash
  }
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Remove-Item -LiteralPath $reportPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $outputDirectory 'nsis-error-code-2-diagnostics.log') -Force -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $fixturePath)) { throw "Missing synthetic SQLite fixture: $fixturePath" }
if (-not (Test-Path -LiteralPath (Join-Path $legacyPayloadDirectory 'Novda-hisob-kitob.exe'))) {
  throw "Missing preserved 1.7.13 unpacked payload: $legacyPayloadDirectory"
}

$testProfile = [pscustomobject]@{ UserProfile = $env:USERPROFILE; AppData = $env:APPDATA; Networking = 'Disabled by Windows Sandbox configuration' }

# A. Exact 1.7.12 to final version upgrade.
$seedA = Install-OldAndSeedUserData
$beforeA = Get-InstallState
$processesA = @(Get-InstallDirectoryProcesses $beforeA.InstallLocation)
$upgradeA = Invoke-Installer $finalVersion '1.7.12 to final'
$afterA = Get-InstallState
$processesAfterA = @(Get-InstallDirectoryProcesses $afterA.InstallLocation)
$dataPreservedA = (Test-Path -LiteralPath $sqlitePath) `
  -and (Get-FileHash -LiteralPath $sqlitePath -Algorithm SHA256).Hash -eq $seedA.SQLiteSha256 `
  -and (Get-FileHash -LiteralPath $credentialMarkerPath -Algorithm SHA256).Hash -eq $seedA.CredentialMarkerSha256
Add-Scenario 'A: 1.7.12 to final version' $upgradeA $beforeA $afterA $processesA $processesAfterA $dataPreservedA

# B. Recreate the overlaid 1.7.13 layout while keeping its 1.7.12 uninstall registration.
Reset-Install
$seedB = Install-OldAndSeedUserData
$stateBeforeOverlay = Get-InstallState
Copy-Item -Path (Join-Path $legacyPayloadDirectory '*') -Destination $stateBeforeOverlay.InstallLocation -Recurse -Force
$stateAfterOverlay = Get-InstallState
if ($stateAfterOverlay.DisplayVersion -ne '1.7.12' -or $stateAfterOverlay.UninstallerProductVersion -ne '1.7.12' `
  -or $stateAfterOverlay.ExecutableProductVersion -ne '1.7.13.0') {
  throw 'The overlaid 1.7.13 scenario did not retain the expected 1.7.12 registry and uninstaller.'
}
$processesB = @(Get-InstallDirectoryProcesses $stateAfterOverlay.InstallLocation)
$upgradeB = Invoke-Installer $finalVersion 'overlaid 1.7.13 payload to final'
$afterB = Get-InstallState
$processesAfterB = @(Get-InstallDirectoryProcesses $afterB.InstallLocation)
$dataPreservedB = (Test-Path -LiteralPath $sqlitePath) `
  -and (Get-FileHash -LiteralPath $sqlitePath -Algorithm SHA256).Hash -eq $seedB.SQLiteSha256 `
  -and (Get-FileHash -LiteralPath $credentialMarkerPath -Algorithm SHA256).Hash -eq $seedB.CredentialMarkerSha256
Add-Scenario 'B: 1.7.13 overlaid files with 1.7.12 uninstall metadata to final' $upgradeB $stateAfterOverlay $afterB $processesB $processesAfterB $dataPreservedB

# G. Force the previous uninstaller to return the observed exit code 2.
Reset-Install
$seedG = Install-OldAndSeedUserData
$stateBeforeFault = Get-InstallState
$faultUninstaller = Join-Path $outputDirectory 'forced-uninstaller-exit-2.exe'
if (-not (Test-Path -LiteralPath $faultUninstaller)) { throw "Missing exit-code-2 uninstaller fixture: $faultUninstaller" }
$diagnosticLog = Join-Path $env:TEMP 'Novda-hisob-kitob-NSIS-upgrade.log'
Remove-Item -LiteralPath $diagnosticLog -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $faultUninstaller -Destination $stateBeforeFault.UninstallerPath -Force
$faultUninstallerSha256 = (Get-FileHash -LiteralPath $stateBeforeFault.UninstallerPath -Algorithm SHA256).Hash
$processesG = @(Get-InstallDirectoryProcesses $stateBeforeFault.InstallLocation)
$upgradeG = Invoke-Installer $finalVersion 'exit-code-2 uninstaller recovery'
$afterG = Get-InstallState
$processesAfterG = @(Get-InstallDirectoryProcesses $afterG.InstallLocation)
$diagnosticText = if (Test-Path -LiteralPath $diagnosticLog) { Get-Content -LiteralPath $diagnosticLog -Raw } else { '' }
$diagnosticCopy = Join-Path $outputDirectory 'nsis-error-code-2-diagnostics.log'
if ($diagnosticText) { Set-Content -LiteralPath $diagnosticCopy -Value $diagnosticText -Encoding UTF8 }
$fallbackProven = $diagnosticText.Contains('OldUninstallerExitCode=2') `
  -and $diagnosticText.Contains('ProcessDetectionExitCode=1') `
  -and $diagnosticText.Contains('RecoveryDecision=continue-with-in-place-file-replacement')
$dataPreservedG = (Test-Path -LiteralPath $sqlitePath) `
  -and (Get-FileHash -LiteralPath $sqlitePath -Algorithm SHA256).Hash -eq $seedG.SQLiteSha256 `
  -and (Get-FileHash -LiteralPath $credentialMarkerPath -Algorithm SHA256).Hash -eq $seedG.CredentialMarkerSha256
Add-Scenario 'G: exit code 2 with no running app repairs through in-place replacement' $upgradeG $stateBeforeFault $afterG $processesG $processesAfterG $dataPreservedG
$results[$results.Count - 1] | Add-Member -NotePropertyName FaultUninstallerSha256 -NotePropertyValue $faultUninstallerSha256
$results[$results.Count - 1] | Add-Member -NotePropertyName RecoveryDiagnosticLogPath -NotePropertyValue $diagnosticCopy
$results[$results.Count - 1] | Add-Member -NotePropertyName RecoveryFallbackProven -NotePropertyValue $fallbackProven
if (-not $fallbackProven) { throw 'The exit-code-2 recovery did not log the no-process decision.' }

# H. The same old-uninstaller exit code must abort if the app process remains.
Reset-Install -ClearTestUserData
$seedH = Install-OldAndSeedUserData
$stateBeforeH = Get-InstallState
Copy-Item -LiteralPath $faultUninstaller -Destination $stateBeforeH.UninstallerPath -Force
Remove-Item -LiteralPath $diagnosticLog -Force -ErrorAction SilentlyContinue
$processesBeforeH = @(Get-InstallDirectoryProcesses $stateBeforeH.InstallLocation)
$runningAppH = Start-Process -FilePath $stateBeforeH.ExecutablePath -PassThru
Start-Sleep -Seconds 4
$processesBeforeH = @(Get-InstallDirectoryProcesses $stateBeforeH.InstallLocation)
if ($processesBeforeH.Count -eq 0) { throw 'The app process did not remain running for the code-2 fail-closed test.' }
$blockedUpgradeH = Invoke-Installer $finalVersion 'exit-code-2 uninstaller while app remains running'
$stateAfterH = Get-InstallState
$processesAfterH = @(Get-InstallDirectoryProcesses $stateBeforeH.InstallLocation)
$dataPreservedH = (Test-Path -LiteralPath $sqlitePath) `
  -and (Get-FileHash -LiteralPath $sqlitePath -Algorithm SHA256).Hash -eq $seedH.SQLiteSha256 `
  -and (Get-FileHash -LiteralPath $credentialMarkerPath -Algorithm SHA256).Hash -eq $seedH.CredentialMarkerSha256
$runningFaultLog = if (Test-Path -LiteralPath $diagnosticLog) { Get-Content -LiteralPath $diagnosticLog -Raw } else { '' }
$failClosedH = $blockedUpgradeH.ExitCode -eq 2 `
  -and $stateAfterH.DisplayVersion -eq '1.7.12' `
  -and $stateAfterH.ExecutableProductVersion -eq '1.7.12.0' `
  -and $processesAfterH.Count -gt 0 `
  -and $dataPreservedH `
  -and $runningFaultLog.Contains('OldUninstallerExitCode=2') `
  -and $runningFaultLog.Contains('ProcessDetectionResult=PROCESS_RUNNING') `
  -and $runningFaultLog.Contains('RecoveryDecision=abort-process-remains-or-check-failed')
$results.Add([pscustomobject]@{
  Name = 'H: exit code 2 with a running app aborts without replacing files'
  Pass = $failClosedH
  Installer = $blockedUpgradeH
  PreInstallState = $stateBeforeH
  PostInstallState = $stateAfterH
  ProcessesBeforeInstaller = @($processesBeforeH)
  ProcessesAfterInstaller = @($processesAfterH)
  UserDataPreservedByteForByte = $dataPreservedH
  FailClosedRecoveryProven = $failClosedH
})
if (-not $failClosedH) { throw 'The installer did not fail closed while a Novda process remained running.' }
Get-InstallDirectoryProcesses $stateBeforeH.InstallLocation | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Reset-Install -ClearTestUserData

# C. Fresh install on an empty sandbox user profile.
Reset-Install -ClearTestUserData
$freshC = Invoke-Installer $finalVersion 'fresh profile install'
$afterC = Get-InstallState
$processesAfterC = @(Get-InstallDirectoryProcesses $afterC.InstallLocation)
Add-Scenario 'C: fresh install on empty profile' $freshC $null $afterC @() $processesAfterC $true
if (Test-Path -LiteralPath $sqlitePath) { throw 'Fresh install unexpectedly created or imported a company SQLite database.' }

# D. Reinstalling the same final version must remain safe.
$beforeD = Get-InstallState
$processesD = @(Get-InstallDirectoryProcesses $beforeD.InstallLocation)
$reinstallD = Invoke-Installer $finalVersion 'same-version reinstall'
$afterD = Get-InstallState
$processesAfterD = @(Get-InstallDirectoryProcesses $afterD.InstallLocation)
Add-Scenario 'D: same-version reinstall' $reinstallD $beforeD $afterD $processesD $processesAfterD $true

# E. A running app must be closed by the installer before files are replaced.
$appStart = Start-Process -FilePath $afterD.ExecutablePath -PassThru
Start-Sleep -Seconds 4
$processesBeforeE = @(Get-InstallDirectoryProcesses $afterD.InstallLocation)
if ($processesBeforeE.Count -eq 0) { throw 'The packaged app did not remain running for the running-app test.' }
$runningUpgradeE = Invoke-Installer $finalVersion 'upgrade while app is running'
$afterE = Get-InstallState
$processesAfterE = @(Get-InstallDirectoryProcesses $afterE.InstallLocation)
Add-Scenario 'E: app running during installer launch' $runningUpgradeE $afterD $afterE $processesBeforeE $processesAfterE $true

# F. A closed app must not produce a false process-detection retry loop.
$beforeF = Get-InstallState
$processesF = @(Get-InstallDirectoryProcesses $beforeF.InstallLocation)
$closedUpgradeF = Invoke-Installer $finalVersion 'upgrade while app is closed'
$afterF = Get-InstallState
$processesAfterF = @(Get-InstallDirectoryProcesses $afterF.InstallLocation)
Add-Scenario 'F: app already closed' $closedUpgradeF $beforeF $afterF $processesF $processesAfterF $true

$report = [pscustomobject]@{
  CapturedAt = [DateTime]::UtcNow.ToString('o')
  SandboxProfile = $testProfile
  FinalVersion = $finalVersion
  SyntheticSQLitePath = $sqlitePath
  SyntheticSQLiteMarkers = [pscustomobject]@{ sync_bootstrap_complete = '1'; sync_cursor = '0'; workers = 201; models = 18; parties = 42 }
  CredentialMarker = $credentialMarkerPath
  Scenarios = @($results)
  AllScenariosPassed = @($results | Where-Object { -not $_.Pass }).Count -eq 0
}

$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding UTF8
$report | ConvertTo-Json -Depth 12 | Write-Output
