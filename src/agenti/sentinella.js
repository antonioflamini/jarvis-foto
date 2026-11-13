// AGENTE SENTINELLA
// Si accorge quando inserisci una scheda SD, una chiavetta o il disco del backup e TI CHIEDE cosa fare.
// Non importa mai nulla senza il tuo "Sì". Se rispondi sì, copia le foto nella cartella Arrivi
// (gli originali restano sul supporto) e poi le sistema nell'archivio.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { tipoDi, eseguiPowerShell } from './esploratore.js';
import { numero, byteLeggibili } from '../util.js';

const SALTA = new Set(['$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)', 'jarvis_backup', '.trashes', '.spotlight-v100']);

export async function contaMultimediali(radice, limite = 50000, profonditaMax = 6, conZip = false) {
  let n = 0;
  async function cammina(dir, prof) {
    if (n >= limite || prof > profonditaMax) return;
    for (const v of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (n >= limite) return;
      if (v.isDirectory()) { if (!SALTA.has(v.name.toLowerCase()) && !v.name.startsWith('.')) await cammina(path.join(dir, v.name), prof + 1); } else if (tipoDi(v.name) || (conZip && /\.zip$/i.test(v.name))) n++;
    }
  }
  await cammina(radice, 0);
  return n;
}

// Finestra Sì/No in primo piano (Windows). Il testo passa da una variabile d'ambiente: niente problemi di virgolette.
export function chiediWindows(messaggio) {
  return new Promise((resolve) => {
    const script = 'Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.Form; $f.TopMost=$true;' +
      "$r=[System.Windows.Forms.MessageBox]::Show($f, $env:JARVIS_MSG, 'J.A.R.V.I.S. Foto', 'YesNo', 'Question'); Write-Output $r";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { env: { ...process.env, JARVIS_MSG: messaggio }, windowsHide: true, timeout: 15 * 60000 },
      (err, out) => resolve(!err && /yes|sì|si/i.test(String(out))));
  });
}

// Avviso informativo (solo OK), senza bloccare la sentinella.
export function avvisaWindows(messaggio) {
  const script = 'Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.Form; $f.TopMost=$true;' +
    "[void][System.Windows.Forms.MessageBox]::Show($f, $env:JARVIS_MSG, 'J.A.R.V.I.S. Foto', 'OK', 'Information')";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
    { env: { ...process.env, JARVIS_MSG: messaggio }, windowsHide: true, timeout: 60 * 60000 }, () => {});
}

export const FILE_BLOCCO_SENTINELLA = path.join(os.tmpdir(), 'jarvis-foto-sentinella.lock');
export const SOGLIA_SPAZIO_BASSO = 5 * 1024 ** 3; // sotto i 5 GB liberi JARVIS avvisa

// C'è una sentinella attiva in un altro processo? (letta dal file di blocco: serve alla diagnostica del menu)
export function sentinellaInEsecuzione(file = FILE_BLOCCO_SENTINELLA) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!pid || pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function unitaWindows() {
  const presenti = [];
  for (const l of 'DEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${l}:\\`)) presenti.push(`${l}:\\`);
  return presenti;
}

async function infoUnita(radice) {
  if (process.platform !== 'win32') return { tipo: 2, nome: path.basename(radice) };
  const id = radice.slice(0, 2);
  const out = await eseguiPowerShell(`Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${id}'" | Select-Object DriveType,VolumeName | ConvertTo-Json -Compress`);
  try {
    const d = JSON.parse(out);
    return { tipo: d.DriveType, nome: d.VolumeName || '' };
  } catch {
    return { tipo: 0, nome: '' };
  }
}

export class Sentinella {
  /**
   * @param {import('../jarvis.js').Jarvis} jarvis
   * @param {object} opz  { elencaUnita, chiedi, info, intervallo } — sostituibili per i collaudi
   */
  constructor(jarvis, opz = {}) {
    this.jarvis = jarvis;
    this.elencaUnita = opz.elencaUnita || (process.platform === 'win32' ? unitaWindows : null);
    this.chiedi = opz.chiedi || chiediWindows;
    this.info = opz.info || infoUnita;
    this.intervallo = opz.intervallo || 4000;
    this.note = new Set();
    this.inAttesa = new Set();
    this.timer = null;
    this.occupata = false;
    this.sorvegliaArrivi = opz.sorvegliaArrivi ?? true;
    this.attesaArrivi = opz.attesaArrivi ?? 8000; // aspetta che la copia nella cartella sia finita
    this.arrivi = { conteggio: 0, stabileDa: 0, chiesto: 0 };
    this.fileBlocco = opz.fileBlocco ?? FILE_BLOCCO_SENTINELLA;
    // Promemoria (backup da fare, spazio quasi finito): al massimo uno ogni 7 giorni per tipo,
    // e non subito all'accensione del PC.
    this.avvisa = opz.avvisa || avvisaWindows;
    this.attesaPromemoria = opz.attesaPromemoria ?? 10 * 60000;
    this.ripetiPromemoria = opz.ripetiPromemoria ?? 7 * 86400000;
    this.avviataIl = Date.now();
    this.ultimoControlloPromemoria = 0;
  }

  // Avvisa (senza bloccare nulla) se il backup è vecchio o mai fatto, o se il disco dell'archivio è quasi pieno.
  async controllaPromemoria(adesso = Date.now()) {
    const j = this.jarvis;
    if (j.lavoroInCorso || adesso - this.avviataIl < this.attesaPromemoria) return [];
    if (adesso - this.ultimoControlloPromemoria < 3600000) return []; // controllo al massimo una volta all'ora
    this.ultimoControlloPromemoria = adesso;
    const fileAvvisi = path.join(j.cfg.archivio, '_JARVIS', 'promemoria_avvisi.json');
    let avvisi = {};
    try { avvisi = JSON.parse(await fsp.readFile(fileAvvisi, 'utf8')); } catch { /* primo avviso */ }
    const scaduto = (k) => !avvisi[k] || adesso - new Date(avvisi[k]).getTime() >= this.ripetiPromemoria;
    const fatti = [];

    const p = await j.promemoriaBackup().catch(() => null);
    if (p?.daFare && (p.giorni === null || p.giorni >= 7) && scaduto('backup')) {
      this.avvisa(`${p.testo}\n\nSe hai già fatto un backup con JARVIS, ti basta collegare il disco: ti chiederò io se aggiornarlo.`);
      j.regista.parla('Promemoria: è ora di fare il backup delle foto.');
      avvisi.backup = new Date(adesso).toISOString();
      fatti.push('backup');
    }
    const libero = await j.leggiSpazio().catch(() => null);
    if (libero !== null && libero < SOGLIA_SPAZIO_BASSO && scaduto('spazio')) {
      this.avvisa(`Sul disco dell'archivio restano solo ${byteLeggibili(libero)} liberi.\n\n` +
        'Libera un po\' di spazio (per esempio svuota il Cestino) o sposta l\'archivio su un disco più grande.');
      avvisi.spazio = new Date(adesso).toISOString();
      fatti.push('spazio');
    }
    if (fatti.length) {
      await fsp.mkdir(path.dirname(fileAvvisi), { recursive: true });
      await fsp.writeFile(fileAvvisi, JSON.stringify(avvisi, null, 2));
    }
    return fatti;
  }

  // "Accadde oggi": una volta al giorno (tra le 9 e le 21) ricorda le foto di questo giorno negli anni passati.
  async controllaRicordi(adesso = new Date()) {
    const j = this.jarvis;
    if (j.lavoroInCorso || !j.archivioDisponibile() || !j.galleria) return null;
    if (Date.now() - this.avviataIl < this.attesaPromemoria) return null; // non subito all'accensione del PC
    if (adesso.getHours() < 9 || adesso.getHours() >= 21) return null;
    if (adesso.getTime() - (this.ultimoControlloRicordi || 0) < 600000) return null;
    this.ultimoControlloRicordi = adesso.getTime();
    const oggi = `${adesso.getFullYear()}-${String(adesso.getMonth() + 1).padStart(2, '0')}-${String(adesso.getDate()).padStart(2, '0')}`;
    const file = path.join(j.cfg.archivio, '_JARVIS', 'ricordi_avvisati.txt');
    if ((await fsp.readFile(file, 'utf8').catch(() => '')).trim() === oggi) return null;
    const r = await j.galleria.ricordi(adesso);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, oggi);
    if (!r.totale) return { totale: 0 };
    const anni = r.gruppi.map((g) => g.anno);
    const elencoAnni = anni.length > 1 ? `${anni.slice(0, -1).join(', ')} e ${anni.at(-1)}` : String(anni[0]);
    this.avvisa(`Accadde oggi: ${numero(r.totale)} foto e video del ${adesso.getDate()} ${adesso.toLocaleDateString('it-IT', { month: 'long' })} ` +
      `(${elencoAnni}). Clicca qui per rivederli.`, 'galleria-oggi');
    j.regista.parla(`${j.cfg.nome ? `${j.cfg.nome}, oggi` : 'Oggi'} ci sono dei ricordi da rivedere.`);
    return { totale: r.totale, anni };
  }

  // Una sola sentinella per volta sul PC (evita domande doppie se è aperto anche Claude Desktop).
  #prendiBlocco() {
    if (!this.fileBlocco) return true;
    try {
      const pid = Number(fs.readFileSync(this.fileBlocco, 'utf8'));
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); return false; } catch { /* processo non più attivo: blocco vecchio */ }
      }
    } catch { /* nessun blocco */ }
    fs.writeFileSync(this.fileBlocco, String(process.pid));
    const libera = () => { try { if (Number(fs.readFileSync(this.fileBlocco, 'utf8')) === process.pid) fs.rmSync(this.fileBlocco); } catch { /* già libero */ } };
    process.once('exit', libera);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { libera(); process.exit(0); });
    return true;
  }

  /** @returns {Promise<true|'non-supportato'|'gia-attiva'>} */
  async avvia() {
    if (!this.elencaUnita) return 'non-supportato';
    if (!this.#prendiBlocco()) return 'gia-attiva';
    for (const u of await this.elencaUnita()) this.note.add(u); // quelle già collegate all'avvio non disturbano
    this.timer = setInterval(() => this.controlla().catch(() => {}), this.intervallo);
    this.timer.unref?.();
    return true;
  }

  ferma() { clearInterval(this.timer); this.timer = null; }

  // Cartella Arrivi: quando ci copi dentro dei file (e la copia è finita) chiede se sistemarli.
  async controllaArrivi() {
    const j = this.jarvis;
    if (!this.sorvegliaArrivi || j.lavoroInCorso) return null;
    const n = await contaMultimediali(j.cfg.arrivi, 200000, 8, true);
    const a = this.arrivi;
    if (n === 0) { a.conteggio = 0; a.chiesto = 0; return null; }
    if (n !== a.conteggio) { a.conteggio = n; a.stabileDa = Date.now(); return null; }
    if (Date.now() - a.stabileDa < this.attesaArrivi || a.chiesto === n) return null;
    if (!j.archivioDisponibile()) {
      // Il disco dell'archivio è spento: lo dico una volta, e appena lo accendi chiedo se sistemare.
      if (a.avvisatoSpento !== n) {
        a.avvisatoSpento = n;
        j.regista.parla('Accendi il disco dell\'archivio per sistemare i nuovi file.');
        this.avvisa(`Nella cartella Arrivi ci sono ${numero(n)} nuovi file, ma il disco dell'archivio (${j.discoArchivio}) è spento.\n\n` +
          'Accendilo: appena lo vedo ti chiedo se sistemarli.');
      }
      return { azione: 'attesa-disco' };
    }
    a.chiesto = n;
    j.regista.parla(`Ci sono ${numero(n)} nuovi file nella cartella Arrivi. Li sistemo?`);
    const si = await this.chiedi(`Nella cartella Arrivi ci sono ${numero(n)} nuovi file.\n\nLi sistemo nell'archivio adesso?`);
    if (!si) return { azione: 'rifiutata' };
    j.importaArrivi().catch(() => {});
    return { azione: 'importazione', file: n };
  }

  async controlla() {
    if (this.occupata) return;
    this.occupata = true;
    try {
      const ora = new Set(await this.elencaUnita());
      for (const u of [...this.note]) if (!ora.has(u)) { this.note.delete(u); this.inAttesa.delete(u); }
      const nuove = [...ora].filter((u) => !this.note.has(u));
      for (const u of nuove) this.note.add(u);
      for (const u of [...nuove, ...this.inAttesa]) {
        if (this.jarvis.lavoroInCorso) { this.inAttesa.add(u); continue; }
        this.inAttesa.delete(u);
        await this.valuta(u);
      }
      await this.controllaArrivi();
      await this.controllaPromemoria().catch(() => {});
      await this.controllaRicordi().catch(() => {});
    } finally {
      this.occupata = false;
    }
  }

  async valuta(radice) {
    const j = this.jarvis;
    const archivio = path.resolve(j.cfg.archivio).toLowerCase();
    if (archivio.startsWith(path.resolve(radice).toLowerCase())) return { azione: 'ignorata', motivo: 'contiene l\'archivio' };

    // Disco del backup: propone di aggiornarlo se serve.
    if (fs.existsSync(path.join(radice, 'JARVIS_Backup', 'backup_jarvis.json'))) {
      const p = await j.promemoriaBackup();
      if (!p?.daFare) return { azione: 'ignorata', motivo: 'backup già aggiornato' };
      j.regista.parla('Ho riconosciuto il disco del backup. Vuoi aggiornarlo?');
      const si = await this.chiedi(`Ho riconosciuto il disco del backup (${radice}).\n\n${p.testo}\n\nVuoi aggiornare il backup adesso?`);
      if (!si) return { azione: 'rifiutata' };
      j.backup({ destinazione: radice }).catch(() => {});
      return { azione: 'backup' };
    }

    const info = await this.info(radice);
    const haDCIM = fs.existsSync(path.join(radice, 'DCIM'));
    if (info.tipo !== 2 && !haDCIM) return { azione: 'ignorata', motivo: 'non è una scheda o chiavetta' };
    const n = await contaMultimediali(radice);
    if (!n) return { azione: 'ignorata', motivo: 'nessuna foto' };
    const nome = `${radice.replace(/\\$/, '')}${info.nome ? ` (${info.nome})` : ''}`;
    if (!j.archivioDisponibile()) {
      j.regista.parla('Per importare devi prima accendere il disco dell\'archivio.');
      this.avvisa(`Ho trovato ${numero(n)} foto e video su ${nome}, ma il disco dell'archivio (${j.discoArchivio}) è spento.\n\n` +
        'Accendi il disco, poi togli e reinserisci la scheda o la chiavetta.');
      return { azione: 'attesa-disco' };
    }
    j.emetti({ t: 'messaggio', testo: `Rilevato ${nome}: ${numero(n)} foto/video. Attendo conferma…` });
    j.regista.parla(`Ho trovato ${numero(n)} foto e video sul nuovo supporto. Vuoi importarli?`);
    const si = await this.chiedi(
      `Ho trovato ${numero(n)} foto e video su ${nome}.\n\nVuoi importarli nell'archivio?\n\n` +
      'Verranno copiati nella cartella Arrivi e poi messi in ordine. Gli originali restano sul supporto.');
    if (!si) {
      j.emetti({ t: 'messaggio', testo: `Importazione da ${nome} rifiutata.` });
      return { azione: 'rifiutata' };
    }
    j.importaDaSupporto(radice, { etichetta: info.nome }).catch(() => {});
    return { azione: 'importazione', file: n };
  }
}
