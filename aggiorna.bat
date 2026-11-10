@echo off
rem Scarica da GitHub l'ultima versione di JARVIS Foto (impostazioni e foto restano)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installa.ps1" -Aggiorna
pause
