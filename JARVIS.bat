@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title J.A.R.V.I.S. - Archivio foto
cd /d "%~dp0"

rem Node.js incluso nel pacchetto (cartella node), altrimenti quello installato sul PC
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" (
  set "NODE=node"
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo  Node.js non trovato. Installa JARVIS con installa.bat oppure Node.js LTS da https://nodejs.org
    echo.
    pause
    exit /b 1
  )
  if not exist node_modules (
    echo  Prima installazione dei componenti...
    call npm install --omit=dev --no-audit --no-fund
  )
)

rem Trascinando una cartella o uno zip sopra JARVIS.bat parte subito l'importazione
if not "%~1"=="" (
  "%NODE%" src\cli.js importa "%~1"
  pause
  exit /b
)

:menu
cls
echo.
echo    J.A.R.V.I.S.  -  Archivio foto personale
echo    ----------------------------------------
echo    1  Importa da chiavetta / scheda / telefono
echo    2  Importa da una cartella o da uno zip
echo    3  Backup su hard disk esterno
echo    4  Verifica il backup
echo    G  Galleria: sfoglia l'archivio
echo    5  Apri il pannello olografico
echo    6  Stato dell'archivio
echo    7  Sistema la cartella Arrivi
echo    8  Annulla l'ultima importazione
echo    9  Riavvia la sentinella (ascolto di schede, chiavette e Arrivi)
echo    D  Diagnostica
echo    A  Aggiorna JARVIS da GitHub
echo    0  Esci
echo.
rem azzero le risposte precedenti: premere solo Invio non deve ripetere l'ultima scelta
set "scelta="
set "unita="
set "sorgente="
set "dest="
set "conferma="
set /p scelta="   Cosa faccio? "

if "%scelta%"=="1" (
  "%NODE%" src\cli.js supporti
  echo.
  set /p unita="   Lettera dell'unita' da importare (es. E:): "
  "%NODE%" src\cli.js importa "!unita!"
  pause
  goto menu
)
if "%scelta%"=="2" (
  set /p sorgente="   Trascina qui la cartella o lo zip e premi Invio: "
  "%NODE%" src\cli.js importa !sorgente!
  pause
  goto menu
)
if "%scelta%"=="3" (
  set /p dest="   Unita' del disco esterno (Invio = quella impostata): "
  "%NODE%" src\cli.js backup !dest!
  pause
  goto menu
)
if "%scelta%"=="4" (
  set /p dest="   Unita' del disco esterno (Invio = quella impostata): "
  "%NODE%" src\cli.js verifica !dest! --profonda
  pause
  goto menu
)
if "%scelta%"=="5" (
  "%NODE%" src\cli.js pannello
  goto menu
)
if /i "%scelta%"=="G" (
  "%NODE%" src\cli.js galleria
  goto menu
)
if "%scelta%"=="6" (
  "%NODE%" src\cli.js stato
  pause
  goto menu
)
if "%scelta%"=="7" (
  "%NODE%" src\cli.js arrivi
  pause
  goto menu
)
if "%scelta%"=="8" (
  set /p conferma="   Sicuro di annullare l'ultima importazione? (s/n): "
  if /i "!conferma!"=="s" "%NODE%" src\cli.js annulla
  pause
  goto menu
)
if "%scelta%"=="9" (
  "%NODE%" src\cli.js sfondo sorveglia
  echo    Sentinella avviata in background.
  timeout /t 2 >nul
  goto menu
)
if /i "%scelta%"=="D" (
  "%NODE%" src\cli.js diagnostica
  pause
  goto menu
)
if /i "%scelta%"=="A" (
  call "%~dp0aggiorna.bat"
  exit /b
)
if "%scelta%"=="0" exit /b
goto menu
