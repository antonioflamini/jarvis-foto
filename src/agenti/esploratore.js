// AGENTE ESPLORATORE
// Trova foto e video in una cartella, in uno zip (anche zip dentro zip) o su un supporto
// (chiavetta, scheda SD, hard disk, telefono montato come unità). Non modifica mai la sorgente.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import yauzl from 'yauzl';

export const EST_FOTO = new Set(['jpg', 'jpeg', 'jpe', 'png', 'heic', 'heif', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'avif',
  'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srw', 'raf', 'orf', 'rw2', 'pef']);
export const EST_VIDEO = new Set(['mp4', 'mov', 'm4v', '3gp', 'avi', 'mkv', 'mts', 'm2ts', 'wmv', 'mpg', 'mpeg', 'webm']);

const CARTELLE_DA_SALTARE = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.thumbnails', '.trash',
  '.trashes', '.spotlight-v100', '.fseventsd', '@eadir', '.git', 'windows', 'program files', 'program files (x86)', 'appdata']);

export function tipoDi(nome) {
  const ext = path.extname(nome).slice(1).toLowerCase();
  if (EST_FOTO.has(ext)) return 'foto';
  if (EST_VIDEO.has(ext)) return 'video';
  return null;
}

// Estrae uno zip in una cartella temporanea, proteggendosi dai percorsi malevoli (zip-slip).
export function estraiZip(fileZip, destinazione, suProgresso) {
  return new Promise((resolve, reject) => {
    yauzl.open(fileZip, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(new Error(`Impossibile aprire lo zip "${path.basename(fileZip)}": ${err.message}`));
      let estratti = 0;
      zip.on('error', reject);
      zip.on('end', () => resolve(estratti));
      zip.on('entry', (voce) => {
        const nome = voce.fileName.replace(/\\/g, '/');
        if (nome.endsWith('/') || nome.startsWith('__MACOSX/') || path.basename(nome).startsWith('._')) return zip.readEntry();
        const interessa = tipoDi(nome) || /\.(zip|json)$/i.test(nome);
        if (!interessa) return zip.readEntry();
        const dest = path.resolve(destinazione, nome);
        if (!dest.startsWith(path.resolve(destinazione) + path.sep)) return zip.readEntry();
        zip.openReadStream(voce, (e2, flusso) => {
          if (e2) return reject(e2);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const out = fs.createWriteStream(dest);
          flusso.pipe(out);
          out.on('error', reject);
          out.on('finish', () => {
            try {
              const data = voce.getLastModDate();
              fs.utimesSync(dest, data, data);
            } catch { /* data non disponibile */ }
            estratti++;
            suProgresso?.(estratti, nome);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

/**
 * Esplora una sorgente e restituisce l'elenco dei file multimediali trovati.
 * @param {string} sorgente cartella, file zip, lettera di unità (es. "E:") o singolo file
 * @param {object} opz { escludi: percorso da ignorare (l'archivio stesso), suProgresso(n) }
 */
export async function esplora(sorgente, opz = {}) {
  let radice = sorgente.trim().replace(/^"|"$/g, '');
  if (/^[a-zA-Z]:$/.test(radice)) radice += '\\';
  radice = path.resolve(radice);
  const st = await fsp.stat(radice).catch(() => null);
  if (!st) throw new Error(`Non trovo "${sorgente}". Controlla il percorso o che il supporto sia collegato.`);

  const temporanee = [];
  const trovati = [];
  const zipSaltati = [];
  const jsonPerCartella = new Map();
  const escludi = [].concat(opz.escludi || []).map((e) => path.resolve(e).toLowerCase());

  async function daZip(fileZip, profondita) {
    if (profondita > 3) return;
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-zip-'));
    temporanee.push(tmp);
    opz.suMessaggio?.(`Apro lo zip ${path.basename(fileZip)}…`);
    try {
      await estraiZip(fileZip, tmp, (n) => n % 50 === 0 && opz.suMessaggio?.(`Estratti ${n} file da ${path.basename(fileZip)}`));
    } catch (e) {
      // Uno zip rotto (o bloccato dall'antivirus) non deve fermare tutto: lo salto e vado avanti.
      zipSaltati.push(path.basename(fileZip));
      opz.suMessaggio?.(`Salto lo zip ${path.basename(fileZip)}: non si apre (${e.message.replace(/^Impossibile aprire lo zip "[^"]*": /, '')})`);
    }
    await cammina(tmp, profondita + 1, path.basename(fileZip));
  }

  async function aggiungi(percorso, stat, profondita, origineZip) {
    const nome = path.basename(percorso);
    if (nome.toLowerCase().endsWith('.zip')) return daZip(percorso, profondita);
    if (nome.toLowerCase().endsWith('.json')) {
      const d = path.dirname(percorso);
      if (!jsonPerCartella.has(d)) jsonPerCartella.set(d, []);
      jsonPerCartella.get(d).push(nome);
      return;
    }
    const tipo = tipoDi(nome);
    if (!tipo || nome.startsWith('._') || stat.size === 0) return;
    trovati.push({ percorso, nome, tipo, dimensione: stat.size, mtime: stat.mtime, origineZip: origineZip || null });
    if (trovati.length % 100 === 0) opz.suProgresso?.(trovati.length);
  }

  async function cammina(dir, profondita, origineZip) {
    const dl = dir.toLowerCase();
    if (escludi.some((e) => dl === e || dl.startsWith(e + path.sep))) return;
    let voci;
    try {
      voci = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // cartella non leggibile: si va avanti
    }
    for (const v of voci) {
      const p = path.join(dir, v.name);
      if (v.isDirectory()) {
        if (CARTELLE_DA_SALTARE.has(v.name.toLowerCase())) continue;
        await cammina(p, profondita, origineZip);
      } else if (v.isFile()) {
        const s = await fsp.stat(p).catch(() => null);
        if (s) await aggiungi(p, s, profondita, origineZip);
      }
    }
  }

  if (st.isDirectory()) await cammina(radice, 0, null);
  else await aggiungi(radice, st, 0, null);

  // Abbina i file .json delle esportazioni Google Foto (Takeout) alle foto
  for (const f of trovati) {
    const elenco = jsonPerCartella.get(path.dirname(f.percorso));
    if (elenco) {
      const j = trovaSidecar(f.nome, elenco);
      if (j) f.sidecar = path.join(path.dirname(f.percorso), j);
    }
  }
  opz.suProgresso?.(trovati.length);
  return {
    file: trovati,
    zipSaltati,
    pulisci: async () => {
      for (const t of temporanee) await fsp.rm(t, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// Google Takeout salva la data in "foto.jpg.json" o "foto.jpg.supplemental-metadata.json",
// a volte troncato a ~46 caratteri, e per i duplicati usa "foto.jpg(1).json" invece di "foto(1).jpg.json".
export function trovaSidecar(nome, elencoJson) {
  const insieme = new Map(elencoJson.map((j) => [j.toLowerCase(), j]));
  const n = nome.toLowerCase();
  const base = n.replace(/\.[^.]+$/, '');
  const candidati = [`${n}.json`, `${n}.supplemental-metadata.json`, `${base}.json`];
  const dup = n.match(/^(.*)\((\d+)\)(\.[^.]+)$/);
  if (dup) candidati.push(`${dup[1]}${dup[3]}(${dup[2]}).json`, `${dup[1]}${dup[3]}.supplemental-metadata(${dup[2]}).json`);
  for (const c of candidati) if (insieme.has(c)) return insieme.get(c);
  if (!dup && n.length > 20) {
    const prefisso = n.slice(0, Math.min(n.length, 40));
    const trovato = elencoJson.find((j) => j.toLowerCase().startsWith(prefisso) && !/\(\d+\)\.json$/i.test(j));
    if (trovato) return trovato;
  }
  return null;
}

export function eseguiPowerShell(comando) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', comando], { timeout: 10000, windowsHide: true },
      (err, out) => resolve(err ? null : out));
  });
}

const TIPI_UNITA = { 2: 'rimovibile (chiavetta/scheda)', 3: 'disco interno', 4: 'unità di rete', 5: 'CD/DVD' };

// Elenca i supporti collegati, segnalando quelli con una cartella DCIM (fotocamere, telefoni, schede SD).
export async function rilevaSupporti() {
  const supporti = [];
  if (process.platform === 'win32') {
    const out = await eseguiPowerShell(
      'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress');
    let dischi = [];
    try {
      dischi = [].concat(JSON.parse(out));
    } catch {
      for (const l of 'DEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${l}:\\`)) dischi.push({ DeviceID: `${l}:`, DriveType: 0 });
    }
    for (const d of dischi) {
      const radice = `${d.DeviceID}\\`;
      supporti.push({
        percorso: d.DeviceID,
        nome: d.VolumeName || '',
        tipo: TIPI_UNITA[d.DriveType] || 'unità',
        dimensione: d.Size || null,
        libero: d.FreeSpace || null,
        haDCIM: fs.existsSync(path.join(radice, 'DCIM')),
      });
    }
  } else {
    const basi = process.platform === 'darwin' ? ['/Volumes'] : ['/media', `/media/${os.userInfo().username}`, '/mnt', '/run/media'];
    for (const b of basi) {
      for (const n of await fsp.readdir(b).catch(() => [])) {
        const p = path.join(b, n);
        const s = await fsp.stat(p).catch(() => null);
        if (!s?.isDirectory()) continue;
        const sf = await fsp.statfs?.(p).catch(() => null);
        supporti.push({ percorso: p, nome: n, tipo: 'volume', dimensione: sf ? sf.blocks * sf.bsize : null,
          libero: sf ? sf.bavail * sf.bsize : null, haDCIM: fs.existsSync(path.join(p, 'DCIM')) });
      }
    }
  }
  return supporti;
}
