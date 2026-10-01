!macro customUnInstallCheck
  IfErrors 0 +3
  DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  Return

  StrCpy $R7 $R0
  Push $R5
  Push $R6
  ReadRegStr $R5 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ReadRegStr $R6 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ClearErrors

  StrCpy $R1 "CHECK_FAILED"
  StrCpy $R2 "not-run"
  StrCpy $R9 "not-started"
  ${if} $R0 == 2
    StrCpy $R9 "prepare-result-file"
    IfFileExists "$PLUGINSDIR\Novda-process-check.txt" 0 NovdaProcessCheckNoPreviousResult
      ClearErrors
      Delete "$PLUGINSDIR\Novda-process-check.txt"
      IfErrors NovdaProcessCheckFailed
      IfFileExists "$PLUGINSDIR\Novda-process-check.txt" NovdaProcessCheckFailed 0
    NovdaProcessCheckNoPreviousResult:
    ClearErrors
    StrCpy $R9 "set-environment"
    StrCpy $R3 0
    StrCpy $R4 0
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("NOVDA_NSIS_INSTALL_DIR", "$INSTDIR").R3'
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("NOVDA_NSIS_PROCESS_CHECK_RESULT", "$PLUGINSDIR\Novda-process-check.txt").R4'
    ${if} $R3 == 1
    ${andIf} $R4 == 1
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$ErrorActionPreference = 'Stop'; try { $$root = [Environment]::GetEnvironmentVariable('NOVDA_NSIS_INSTALL_DIR'); $$resultPath = [Environment]::GetEnvironmentVariable('NOVDA_NSIS_PROCESS_CHECK_RESULT'); if ([string]::IsNullOrWhiteSpace($$root) -or [string]::IsNullOrWhiteSpace($$resultPath)) { exit 2 }; $$root = [IO.Path]::GetFullPath($$root).TrimEnd([char]92) + [IO.Path]::DirectorySeparatorChar; $$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and [IO.Path]::GetFullPath($$_.ExecutablePath).StartsWith($$root, [StringComparison]::OrdinalIgnoreCase) }); if ($$processes.Count -eq 0) { [IO.File]::WriteAllText($$resultPath, 'NO_PROCESS', [Text.Encoding]::ASCII); exit 0 }; [IO.File]::WriteAllText($$resultPath, 'PROCESS_RUNNING', [Text.Encoding]::ASCII); exit 0 } catch { try { [IO.File]::WriteAllText($$resultPath, 'CHECK_FAILED', [Text.Encoding]::ASCII) } catch {}; exit 2 }"`
      Pop $R2
      StrCpy $R9 "process-check-returned"
      ${if} $R2 == 0
        StrCpy $R9 "read-process-check-result"
        ClearErrors
        FileOpen $R8 "$PLUGINSDIR\Novda-process-check.txt" r
        IfErrors NovdaProcessCheckFailed
        FileRead $R8 $R1
        IfErrors NovdaProcessCheckReadFailed
        FileClose $R8
        ${if} $R1 == "NO_PROCESS"
          StrCpy $R2 1
        ${endIf}
      ${endIf}
    ${else}
      StrCpy $R2 2
    ${endIf}
  ${endIf}
  Goto NovdaProcessCheckAfter

NovdaProcessCheckFailed:
  StrCpy $R1 "CHECK_FAILED"
  StrCpy $R2 2
  Goto NovdaProcessCheckAfter

NovdaProcessCheckReadFailed:
  FileClose $R8
  StrCpy $R1 "CHECK_FAILED"
  StrCpy $R2 2

NovdaProcessCheckAfter:

  ${if} $R5 != ""
    FileOpen $R8 "$TEMP\Novda-hisob-kitob-NSIS-upgrade.log" a
    ${if} $R8 != ""
      FileWrite $R8 "PreviousUninstallString=$R5$\r$\n"
      FileWrite $R8 "PreviousInstallLocation=$R6$\r$\n"
      FileWrite $R8 "CurrentInstallDirectory=$INSTDIR$\r$\n"
      FileWrite $R8 "OldUninstallerExitCode=$R0$\r$\n"
      FileWrite $R8 "ProcessDetectionExitCode=$R2$\r$\n"
      FileWrite $R8 "ProcessDetectionResult=$R1$\r$\n"
      FileWrite $R8 "ProcessDetectionStage=$R9$\r$\n"
      FileWrite $R8 "InstallDirectoryEnvironmentSet=$R3$\r$\n"
      FileWrite $R8 "ResultPathEnvironmentSet=$R4$\r$\n"
      ${if} $R0 == 2
      ${andIf} $R2 == 1
      ${andIf} $R1 == "NO_PROCESS"
        FileWrite $R8 "RecoveryDecision=continue-with-in-place-file-replacement$\r$\n"
      ${elseif} $R0 == 2
        FileWrite $R8 "RecoveryDecision=abort-process-remains-or-check-failed$\r$\n"
      ${endIf}
      FileClose $R8
    ${endIf}
    ClearErrors
  ${endIf}

  ${if} $R0 == 2
  ${andIf} $R2 == 1
  ${andIf} $R1 == "NO_PROCESS"
    DetailPrint `Previous uninstaller exited with 2; no application process remains. Continuing with in-place file replacement.`
    Pop $R6
    Pop $R5
    Return
  ${endIf}

  StrCpy $R0 $R7
  ${if} $R0 != 0
    IfSilent NovdaProcessCheckSilentAbort
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
  NovdaProcessCheckSilentAbort:
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${endIf}

  Pop $R6
  Pop $R5
!macroend
