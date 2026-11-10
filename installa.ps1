# =====================================================================
#  J.A.R.V.I.S. Foto - installazione e aggiornamento per Windows
#
#  Installazione (PowerShell, copia e incolla):
#    irm https://raw.githubusercontent.com/antonioflamini/jarvis-foto/main/installa.ps1 | iex
#
#  Oppure: scarica JARVIS-Foto-Windows.zip dalle Release, estrailo e fai
#  doppio clic su installa.bat
#
#  Cosa fa:
#   1. scarica l'ultima versione da GitHub (Node.js gia' incluso)
#   2. la mette in %LOCALAPPDATA%\JARVIS-Foto
#   3. ti fa 3 domande (nome, cartella archivio, disco backup)
#   4. crea le icone sul desktop e nel menu Start
#   5. fa partire la sentinella con Windows (nascosta)
#  Non tocca mai le tue foto.
# =====================================================================
param(
  [switch]$Aggiorna,
  [string]$Repo = 'antonioflamini/jarvis-foto'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Dest = Join-Path $env:LOCALAPPDATA 'JARVIS-Foto'
$FileConfig = Join-Path $Dest 'jarvis.config.json'

function Titolo([string]$t) { Write-Host ''; Write-Host "  $t" -ForegroundColor Cyan }
function Fatto([string]$t) { Write-Host "  [OK] $t" -ForegroundColor Green }
function Avviso([string]$t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }

Clear-Host
Write-Host ''
Write-Host '   ==============================================' -ForegroundColor Cyan
Write-Host '     J . A . R . V . I . S .    F O T O' -ForegroundColor Cyan
Write-Host '     archivio foto personale - installazione' -ForegroundColor DarkCyan
Write-Host '   ==============================================' -ForegroundColor Cyan

$tmp = Join-Path $env:TEMP ('jarvis-installa-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  # ---------------------------------------------------------------
  # 1. Da dove prendo i file
  # ---------------------------------------------------------------
  $locale = $false
  if (-not $Aggiorna -and $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'src\cli.js'))) { $locale = $true }

  if ($locale) {
    $origine = $PSScriptRoot
    Titolo "Installo dalla cartella $origine"
  } else {
    Titolo "Scarico l'ultima versione da GitHub ($Repo)..."
    $rel = $null
    try {
      $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'JARVIS-Foto' }
    } catch {
      throw "Non riesco a leggere le Release di github.com/$Repo. Controlla la connessione e che il repository sia pubblico e abbia almeno una Release."
    }
    $asset = $rel.assets | Where-Object { $_.name -eq 'JARVIS-Foto-Windows.zip' } | Select-Object -First 1
    if (-not $asset) { throw "Nella Release $($rel.tag_name) non c'e' il file JARVIS-Foto-Windows.zip. Aspetta che GitHub finisca di prepararlo (scheda Actions) e riprova." }
    $zip = Join-Path $tmp 'jarvis.zip'
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
    $origine = Join-Path $tmp 'x'
    Expand-Archive -Path $zip -DestinationPath $origine -Force
    Fatto "Scaricata la versione $($rel.tag_name)"
  }

  # ---------------------------------------------------------------
  # 2. Fermo la sentinella se gia' attiva (per aggiornare i file)
  # ---------------------------------------------------------------
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*JARVIS-Foto*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500

  # ---------------------------------------------------------------
  # 3. Copio i file (la configurazione esistente resta)
  # ---------------------------------------------------------------
  if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest | Out-Null }
  $stessaCartella = (Resolve-Path $origine).Path.TrimEnd('\') -eq (Resolve-Path $Dest).Path.TrimEnd('\')
  if (-not $stessaCartella) {
    Get-ChildItem -Path $Dest -Force | Where-Object { @('jarvis.config.json', 'jarvis.log', 'jarvis.log.1') -notcontains $_.Name } |
      Remove-Item -Recurse -Force
    Copy-Item -Path (Join-Path $origine '*') -Destination $Dest -Recurse -Force
  }
  Get-ChildItem -Path $Dest -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
  Fatto "Programma in $Dest"

  # Node.js: incluso nel pacchetto; se manca (installazione da sorgente) uso quello del PC
  $Node = Join-Path $Dest 'node\node.exe'
  if (-not (Test-Path $Node)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) {
      Avviso 'Node.js non e'' installato. Provo a installarlo con winget...'
      winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
      $cmd = Get-Command node -ErrorAction SilentlyContinue
      if (-not $cmd) { throw 'Installa Node.js LTS da https://nodejs.org e rilancia questo programma.' }
    }
    $Node = $cmd.Source
    if (-not (Test-Path (Join-Path $Dest 'node_modules'))) {
      Titolo 'Installo i componenti (npm)...'
      Push-Location $Dest
      & npm install --omit=dev --no-audit --no-fund
      Pop-Location
    }
  }
  Fatto ('Node.js ' + (& $Node --version))

  # ---------------------------------------------------------------
  # 4. Configurazione (solo la prima volta)
  # ---------------------------------------------------------------
  if (-not (Test-Path $FileConfig)) {
    Titolo 'Tre domande (premi Invio per accettare il valore tra parentesi quadre)'
    $nome = Read-Host '  Come ti chiami? [Antonio]'
    if (-not $nome) { $nome = 'Antonio' }
    $archivioPredefinito = Join-Path ([Environment]::GetFolderPath('MyPictures')) 'JARVIS_Foto'
    $archivio = Read-Host "  Cartella principale dell'archivio [$archivioPredefinito]"
    $archivio = "$archivio".Trim().Trim('"').Trim("'").Trim()
    if (-not $archivio) { $archivio = $archivioPredefinito }
    $backup = Read-Host '  Lettera del disco esterno per il backup, es. F  [Invio = decido dopo]'
    $backup = "$backup".Trim().Trim('"').Trim("'").Trim().TrimEnd('\').TrimEnd(':')
    if ($backup -match '^[A-Za-z]$') { $backup = $backup.ToUpper() + ':\' }
    elseif ($backup) { Avviso "'$backup' non e' una lettera di disco: il backup lo imposti dopo (menu JARVIS Foto, tasto 3)."; $backup = '' }
    else { $backup = '' }
    $config = [ordered]@{
      archivio = $archivio; backup = $backup; nome = $nome
      effetti = $true; voce = $true; simili = $true; sorveglianza = $true; sogliaGiornata = 12
    }
    [IO.File]::WriteAllText($FileConfig, ($config | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    Fatto 'Configurazione salvata (puoi cambiarla in jarvis.config.json)'
  } else {
    Fatto 'Configurazione esistente mantenuta'
  }
  $config = Get-Content $FileConfig -Raw | ConvertFrom-Json
  $Arrivi = Join-Path $config.archivio 'Arrivi'
  New-Item -ItemType Directory -Path $Arrivi -Force | Out-Null

  # ---------------------------------------------------------------
  # 5. Icone: desktop, menu Start, avvio automatico
  # ---------------------------------------------------------------
  $ws = New-Object -ComObject WScript.Shell
  $icona = Join-Path $Dest 'icon.ico'
  # La sentinella parte con Node.js in modo nascosto ("sfondo"): non serve piu' VBScript
  $argSentinella = "`"$(Join-Path $Dest 'src\cli.js')`" sfondo sorveglia"
  function Collegamento([string]$file, [string]$target, [string]$argomenti, [string]$descrizione, [int]$finestra = 1) {
    $l = $ws.CreateShortcut($file)
    $l.TargetPath = $target
    $l.Arguments = $argomenti
    $l.WorkingDirectory = $Dest
    $l.Description = $descrizione
    $l.WindowStyle = $finestra
    if (Test-Path $icona) { $l.IconLocation = "$icona,0" }
    $l.Save()
  }
  function CollegamentoWeb([string]$file, [string]$url) {
    $testo = "[InternetShortcut]`r`nURL=$url`r`nIconFile=$icona`r`nIconIndex=0`r`n"
    [IO.File]::WriteAllText($file, $testo, [Text.Encoding]::ASCII)
  }
  $desktop = [Environment]::GetFolderPath('Desktop')
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'JARVIS Foto'
  $esecuzione = [Environment]::GetFolderPath('Startup')
  New-Item -ItemType Directory -Path $menu -Force | Out-Null

  Collegamento (Join-Path $desktop 'JARVIS Foto.lnk') (Join-Path $Dest 'JARVIS.bat') '' 'JARVIS Foto: importa, backup, verifica'
  Collegamento (Join-Path $desktop 'JARVIS Arrivi.lnk') $Arrivi '' 'Copia qui foto, cartelle e zip: JARVIS li sistema'
  CollegamentoWeb (Join-Path $desktop 'JARVIS Pannello.url') 'http://127.0.0.1:7777/'
  Collegamento (Join-Path $menu 'JARVIS Foto.lnk') (Join-Path $Dest 'JARVIS.bat') '' 'JARVIS Foto'
  CollegamentoWeb (Join-Path $menu 'JARVIS Pannello.url') 'http://127.0.0.1:7777/'
  Collegamento (Join-Path $menu 'Aggiorna JARVIS.lnk') (Join-Path $Dest 'aggiorna.bat') '' 'Scarica la nuova versione da GitHub'
  Collegamento (Join-Path $menu 'Disinstalla JARVIS.lnk') (Join-Path $Dest 'disinstalla.bat') '' 'Rimuove il programma (le foto restano)'
  Collegamento (Join-Path $menu 'Apri archivio foto.lnk') $config.archivio '' 'Archivio JARVIS'
  Collegamento (Join-Path $esecuzione 'JARVIS Sentinella.lnk') $Node $argSentinella 'JARVIS resta in ascolto di schede, chiavette e cartella Arrivi' 7
  Fatto 'Icone sul desktop e nel menu Start'
  Fatto 'Avvio automatico con Windows'

  # ---------------------------------------------------------------
  # 6. Avvio subito la sentinella e controllo che funzioni
  # ---------------------------------------------------------------
  Start-Process -FilePath $Node -ArgumentList $argSentinella -WorkingDirectory $Dest -WindowStyle Hidden
  Start-Sleep -Seconds 3
  $attiva = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*JARVIS-Foto*sorveglia*' }
  if ($attiva) { Fatto 'Sentinella attiva' } else { Avviso 'La sentinella non risulta attiva: apri JARVIS Foto e scegli D (diagnostica).' }

  Write-Host ''
  Write-Host '   ==============================================' -ForegroundColor Cyan
  if ($Aggiorna) { Write-Host '     AGGIORNAMENTO COMPLETATO' -ForegroundColor Green } else { Write-Host '     INSTALLAZIONE COMPLETATA' -ForegroundColor Green }
  Write-Host '   ==============================================' -ForegroundColor Cyan
  Write-Host ''
  Write-Host "   Archivio:  $($config.archivio)"
  Write-Host "   Arrivi:    $Arrivi"
  Write-Host ''
  Write-Host '   - Inserisci una scheda SD o una chiavetta: JARVIS ti chiede se importare.'
  Write-Host '   - Oppure copia foto/zip nella cartella Arrivi (icona sul desktop).'
  Write-Host '   - Icona "JARVIS Foto" sul desktop: backup, verifica, annulla, diagnostica.'
  Write-Host ''
} catch {
  Write-Host ''
  Write-Host "  ERRORE: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ''
} finally {
  Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
