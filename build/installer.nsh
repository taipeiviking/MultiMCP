; Custom NSIS hooks for Google Workspace Manager.
;
; Problem this solves: the app runs as a background TRAY app (and can autostart at
; login). If it is running when the user installs/updates, the .exe is locked and
; the install silently fails — leaving the OLD version in place. We forcibly close
; any running instance BEFORE files are written, and surface DETAILED progress text
; in the installer's "Show details" log so the user can see what's happening.
;
; Hooks electron-builder honors (defined as macros here):
;   customInit              - very early in .onInit (UI/details panel not up yet)
;   customCheckAppRunning   - REPLACES the built-in "app is running" check; runs in
;                             the install Section, where DetailPrint is VISIBLE.
;   customUnInit            - early in un.onInit (uninstall side)
;
; Detection note: we do NOT parse tasklist text directly (its output is truncated to
; the column width — "Google Workspace Manager." — and the "no tasks" line is
; localized on non-English Windows). Instead we pipe tasklist through find and read
; the EXIT CODE: find returns 0 when the name matches (app running), 1 otherwise.
; This is locale-independent and survives the name truncation. taskkill's own exit
; code is unreliable here (a graceful /T returns 128 even when the app is running,
; because Electron's child processes refuse a non-forced close).

; electron-builder's common.nsh sets `ShowInstDetails nevershow`, which HIDES the
; install log entirely (the user only sees a progress animation). Override it so our
; progress messages are actually shown. customHeader is injected at top level, after
; common.nsh, so this wins.
!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro GWM_StopApp
  ; IMPORTANT: electron-builder's installSection.nsh runs `SetDetailsPrint none`
  ; just before this check, which would SWALLOW our DetailPrint messages. Turn
  ; printing back on for our messages, then restore `none` so the rest of the
  ; template behaves exactly as it expects.
  SetDetailsPrint both

  DetailPrint "Checking whether Google Workspace Manager is running..."

  nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq Google Workspace Manager.exe" /NH | find /I "Google Workspace Manager"'
  Pop $0 ; 0 = found (running); non-zero = not running

  ${If} $0 == 0
    DetailPrint "Google Workspace Manager is running - terminating app before install..."
    nsExec::ExecToLog 'taskkill /IM "Google Workspace Manager.exe" /T'
    Sleep 800

    ; Force-kill anything still alive (Electron children resist a graceful close),
    ; so no file stays locked during extraction.
    DetailPrint "Ensuring all processes have stopped (force terminating)..."
    nsExec::ExecToLog 'taskkill /F /IM "Google Workspace Manager.exe" /T'
    Sleep 500

    DetailPrint "Google Workspace Manager has been closed - continuing installation."
  ${Else}
    DetailPrint "Google Workspace Manager is not running - continuing installation."
  ${EndIf}

  SetDetailsPrint lastused ; restore the template's expected (quiet) state
!macroend

; ---- INSTALL: replace the built-in running-app check with our own (visible) -----
!macro customCheckAppRunning
  !insertmacro GWM_StopApp
!macroend

; Belt-and-suspenders: an early (pre-UI) force close. DetailPrint isn't visible this
; early, so we stay silent here; the visible messaging happens in customCheckAppRunning.
!macro customInit
  nsExec::Exec 'taskkill /F /IM "Google Workspace Manager.exe" /T'
  Sleep 300
!macroend

; ---- UNINSTALL: make sure the app isn't running before removing files -----------
!macro customUnInit
  DetailPrint "Closing Google Workspace Manager before uninstalling..."
  nsExec::ExecToLog 'taskkill /F /IM "Google Workspace Manager.exe" /T'
  Sleep 400
!macroend
