@echo off
rem Copia lo script in una cartella temporanea: la cartella del programma deve poter essere cancellata
copy /y "%~dp0disinstalla.ps1" "%TEMP%\jarvis-disinstalla.ps1" >nul
cd /d "%TEMP%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\jarvis-disinstalla.ps1"
pause
