# =====================================================================
#  J.A.R.V.I.S. Foto - disinstallazione
#  Rimuove il programma, le icone e l'avvio automatico.
#  NON tocca l'archivio delle foto ne' i backup.
# =====================================================================
$ErrorActionPreference = 'Stop'
$Dest = Join-Path $env:LOCALAPPDATA 'JARVIS-Foto'

Write-Host ''
Write-Host '  Disinstallazione di J.A.R.V.I.S. Foto' -ForegroundColor Cyan
Write-Host '  Le tue foto e i backup NON vengono toccati.' -ForegroundColor Green
Write-Host ''
$risposta = Read-Host '  Confermi la disinstallazione? (s/n)'
if ($risposta -notmatch '^[sSyY]') { Write-Host '  Annullato.'; exit }

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*JARVIS-Foto*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

$desktop = [Environment]::GetFolderPath('Desktop')
foreach ($f in @('JARVIS Foto.lnk', 'JARVIS Arrivi.lnk', 'JARVIS Pannello.url')) {
  Remove-Item -Path (Join-Path $desktop $f) -Force -ErrorAction SilentlyContinue
}
Remove-Item -Path (Join-Path ([Environment]::GetFolderPath('Programs')) 'JARVIS Foto') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path ([Environment]::GetFolderPath('Startup')) 'JARVIS Sentinella.lnk') -Force -ErrorAction SilentlyContinue

$copiaConfig = Join-Path $env:USERPROFILE 'Documents\jarvis.config.backup.json'
if (Test-Path (Join-Path $Dest 'jarvis.config.json')) {
  Copy-Item (Join-Path $Dest 'jarvis.config.json') $copiaConfig -Force
}
Remove-Item -Path $Dest -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  JARVIS Foto e'' stato rimosso.' -ForegroundColor Green
if (Test-Path $copiaConfig) { Write-Host "  (Copia delle impostazioni in $copiaConfig)" }
Write-Host ''
