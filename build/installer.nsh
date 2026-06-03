; Custom NSIS hooks for Google Workspace Manager.
;
; Problem this solves: the app runs as a background TRAY app (and can autostart at
; login). If it is running when the user launches the installer, the .exe is locked
; and the install fails. These macros forcibly close any running instance BEFORE
; files are written (install) and before removal (uninstall).
;
; electron-builder calls these macros if defined:
;   customInit         - very early, before the one-instance/older-version checks
;   customInstall      - during install, after files are laid down
;   customUnInstall    - during uninstall
; We do the kill in customInit (install side) and at the start of un.onInit too.

!macro killRunningApp
  ; Try a graceful close first, then force. taskimage is the produced exe name.
  ; /T also kills child processes (Electron spawns helper processes).
  nsExec::Exec 'taskkill /IM "Google Workspace Manager.exe" /T'
  Sleep 600
  nsExec::Exec 'taskkill /F /IM "Google Workspace Manager.exe" /T'
  Sleep 400
!macroend

; ---- INSTALL side: run before the installer does its version/instance checks ----
!macro customInit
  !insertmacro killRunningApp
!macroend

; ---- UNINSTALL side: ensure the app isn't running before we remove files ----
!macro customUnInit
  !insertmacro killRunningApp
!macroend
