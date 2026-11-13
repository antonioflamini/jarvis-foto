// AGENTE VASSOIO
// L'icona di JARVIS accanto all'orologio di Windows: mostra lo stato, i promemoria (fumetti)
// e un menu con le azioni più comuni. È uno script PowerShell (strumenti/vassoio.ps1) che parla
// con la sentinella a righe di testo: niente programmi in più da installare.
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { RADICE_PROGETTO } from '../config.js';

export class Vassoio {
  /**
   * @param {(comando:string) => void} suComando chiamata quando scegli una voce del menu
   */
  constructor(suComando) {
    this.suComando = suComando;
    this.figlio = null;
    this.attivo = false;
    this.chiuso = false;
    this.riavvii = 0;
    this.ultimoStato = '';
  }

  avvia() {
    if (process.platform !== 'win32' || this.chiuso) return false;
    const script = path.join(RADICE_PROGETTO, 'strumenti', 'vassoio.ps1');
    if (!fs.existsSync(script)) return false;
    const figlio = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', script, '-FileIcona', path.join(RADICE_PROGETTO, 'icon.ico')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.figlio = figlio;
    this.attivo = true;
    figlio.on('error', () => { this.attivo = false; });
    figlio.stdin.on('error', () => {});
    readline.createInterface({ input: figlio.stdout }).on('line', (riga) => {
      const c = riga.trim();
      if (c) try { this.suComando(c); } catch { /* comando non riuscito */ }
    });
    figlio.on('exit', () => {
      this.attivo = false;
      if (this.figlio !== figlio) return;
      // se l'icona si chiude da sola (Esplora risorse riavviato…) la rimetto, al massimo 3 volte
      if (!this.chiuso && this.riavvii++ < 3) setTimeout(() => { this.avvia(); if (this.ultimoStato) this.stato(this.ultimoStato); }, 5000).unref();
    });
    return true;
  }

  #invia(oggetto) {
    if (!this.attivo || !this.figlio?.stdin.writable) return false;
    this.figlio.stdin.write(`${JSON.stringify(oggetto)}\n`);
    return true;
  }

  stato(testo) {
    this.ultimoStato = testo;
    return this.#invia({ stato: testo });
  }

  /** Fumetto accanto all'orologio. Restituisce false se l'icona non c'è (allora si usa la finestra). */
  avviso(titolo, testo) {
    return this.#invia({ avviso: { titolo, testo } });
  }

  chiudi() {
    this.chiuso = true;
    try { this.figlio?.stdin.end(); } catch { /* già chiuso */ }
  }
}
