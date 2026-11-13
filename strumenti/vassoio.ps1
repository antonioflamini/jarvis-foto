# =====================================================================
#  J.A.R.V.I.S. Foto - icona accanto all'orologio (area di notifica)
#  La avvia la sentinella. Riceve da JARVIS righe JSON sullo standard input
#  ({"stato":"..."} oppure {"avviso":{"titolo":"...","testo":"..."}})
#  e scrive sullo standard output il comando scelto nel menu.
#  Quando JARVIS si chiude, l'input finisce e l'icona sparisce da sola.
# =====================================================================
param([string]$FileIcona = '')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$uscita = [Console]::Out
function Invia([string]$comando) { $uscita.WriteLine($comando); $uscita.Flush() }

$notifica = New-Object System.Windows.Forms.NotifyIcon
if ($FileIcona -and (Test-Path -LiteralPath $FileIcona)) { $notifica.Icon = New-Object System.Drawing.Icon($FileIcona) }
else { $notifica.Icon = [System.Drawing.SystemIcons]::Application }
$notifica.Text = 'J.A.R.V.I.S. Foto'
$notifica.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$voceStato = $menu.Items.Add('J.A.R.V.I.S. Foto')
$voceStato.Enabled = $false
[void]$menu.Items.Add('-')
function Voce([string]$testo, [string]$comando, [bool]$grassetto = $false) {
  $v = $menu.Items.Add($testo)
  $v.Tag = $comando
  if ($grassetto) { $v.Font = New-Object System.Drawing.Font($v.Font, [System.Drawing.FontStyle]::Bold) }
  $v.add_Click({ param($s, $e) Invia ([string]$s.Tag) })
}
Voce 'Apri la galleria' 'galleria' $true
Voce 'Pannello del lavoro in corso' 'pannello'
[void]$menu.Items.Add('-')
Voce 'Apri la cartella Arrivi' 'arrivi-cartella'
Voce 'Sistema adesso la cartella Arrivi' 'arrivi-sistema'
Voce 'Apri l''archivio delle foto' 'archivio-cartella'
Voce 'Fai il backup adesso' 'backup'
[void]$menu.Items.Add('-')
Voce 'Menu completo (verifica, annulla, diagnostica...)' 'menu'
Voce 'Chiudi JARVIS fino al prossimo avvio del PC' 'esci'
$notifica.ContextMenuStrip = $menu
$notifica.add_MouseDoubleClick({ Invia 'galleria' })
$script:azioneFumetto = 'galleria'
$notifica.add_BalloonTipClicked({ Invia $script:azioneFumetto })

# Lettura dei messaggi di JARVIS senza bloccare l'icona
$ingresso = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
$script:lettura = $ingresso.ReadLineAsync()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.add_Tick({
  while ($script:lettura.IsCompleted) {
    $riga = $null
    try { $riga = $script:lettura.Result } catch { $riga = $null }
    if ($null -eq $riga) {
      # JARVIS si e' chiuso: tolgo l'icona
      $timer.Stop()
      $notifica.Visible = $false
      [System.Windows.Forms.Application]::Exit()
      return
    }
    $m = $null
    try { $m = $riga | ConvertFrom-Json } catch { $m = $null }
    if ($m) {
      if ($m.stato) {
        $t = [string]$m.stato
        $voceStato.Text = $t
        if ($t.Length -gt 63) { $t = $t.Substring(0, 60) + '...' }
        $notifica.Text = $t
      }
      if ($m.avviso) {
        $testo = [string]$m.avviso.testo
        if ($testo.Length -gt 250) { $testo = $testo.Substring(0, 247) + '...' }
        if ($m.avviso.azione) { $script:azioneFumetto = [string]$m.avviso.azione } else { $script:azioneFumetto = 'galleria' }
        $notifica.BalloonTipTitle = [string]$m.avviso.titolo
        $notifica.BalloonTipText = $testo
        $notifica.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
        $notifica.ShowBalloonTip(10000)
      }
    }
    $script:lettura = $ingresso.ReadLineAsync()
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
$notifica.Visible = $false
$notifica.Dispose()
