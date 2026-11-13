// AGENTE GALLERIA
// Sfoglia l'archivio nel browser (http://127.0.0.1:7777/galleria): anni, mesi, giornate, foto e video.
// Mostra anche i RAW (NEF, CR2, ARW…) usando l'anteprima JPG che la fotocamera salva dentro il file.
// Tutto resta sul computer: il pannello risponde solo a 127.0.0.1.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { tipoDi } from './esploratore.js';
import { miniaturaEXIF } from './simili.js';
import { fileURLToPath } from 'node:url';

const PAGINA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hud', 'galleria.html');

const RAW = new Set(['.nef', '.nrw', '.cr2', '.cr3', '.arw', '.srw', '.raf', '.orf', '.rw2', '.pef', '.dng']);
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.3gp': 'video/3gpp',
};
const SEZIONI = ['Foto', 'Video', 'Screenshot', 'Da scegliere'];
const GIORNO = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Trova i JPEG completi dentro un file (anteprime dei RAW). Segue la struttura dei segmenti JPEG,
 * così le miniature annidate nei metadati non vengono scambiate per la fine dell'immagine.
 * @returns {{inizio:number, fine:number}[]}
 */
export function jpegIncorporati(buf) {
  const trovati = [];
  const SOI = Buffer.from([0xff, 0xd8, 0xff]);
  let i = buf.indexOf(SOI);
  while (i >= 0 && i < buf.length - 4) {
    let p = i + 2;
    let fine = -1;
    while (p + 4 <= buf.length && buf[p] === 0xff) {
      const m = buf[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xd9) { fine = p + 2; break; }
      if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
      const lung = buf.readUInt16BE(p + 2);
      if (lung < 2) break;
      p += 2 + lung;
      if (m === 0xda) {
        // dati compressi: avanzo fino al prossimo marcatore vero (FF seguito da qualcosa che non sia 00 o RSTn)
        for (;;) {
          p = buf.indexOf(0xff, p);
          if (p < 0 || p + 1 >= buf.length) { p = buf.length; break; }
          const n = buf[p + 1];
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { p += 2; continue; }
          if (n === 0xff) { p++; continue; }
          break;
        }
      }
    }
    if (fine > 0) { trovati.push({ inizio: i, fine }); i = buf.indexOf(SOI, fine); } else i = buf.indexOf(SOI, i + 1);
  }
  return trovati;
}

/** L'anteprima JPG più grande salvata dentro un RAW (o null). */
export async function anteprimaRaw(file, minimo = 20000) {
  const buf = await fsp.readFile(file);
  let migliore = null;
  for (const j of jpegIncorporati(buf)) if (!migliore || j.fine - j.inizio > migliore.fine - migliore.inizio) migliore = j;
  // sotto i 20 KB è solo la miniatura: meglio niente che un'immagine sgranata a tutto schermo
  return migliore && migliore.fine - migliore.inizio > minimo ? buf.subarray(migliore.inizio, migliore.fine) : null;
}

function titoloGiorno(chiave) {
  const m = chiave.match(GIORNO);
  if (!m) return chiave;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export class Galleria {
  /** @param {import('../jarvis.js').Jarvis} jarvis */
  constructor(jarvis) {
    this.jarvis = jarvis;
    this.cache = null;
  }

  get archivio() { return this.jarvis.cfg.archivio; }

  invalida() { this.cache = null; }

  /** Percorso assoluto di un file dell'archivio, solo se sta davvero dentro l'archivio. */
  risolvi(rel) {
    if (!rel || typeof rel !== 'string') return null;
    const radice = path.resolve(this.archivio);
    const abs = path.resolve(radice, rel);
    return abs.toLowerCase().startsWith(radice.toLowerCase() + path.sep) ? abs : null;
  }

  rel(abs) { return path.relative(this.archivio, abs).split(path.sep).join('/'); }

  async #fileIn(dir) {
    const out = [];
    const cammina = async (d) => {
      for (const v of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, v.name);
        if (v.isDirectory()) await cammina(p);
        else if (tipoDi(v.name) && !v.name.startsWith('.')) out.push(p);
      }
    };
    await cammina(dir);
    return out.sort();
  }

  /** Elenco degli album: per Foto e Video un album per mese, per Screenshot uno per anno, "Da scegliere" uno solo. */
  async indice() {
    if (this.cache && Date.now() - this.cache.t < 120000) return this.cache.dati;
    const sezioni = {};
    const totali = {};
    for (const s of SEZIONI) {
      const base = path.join(this.archivio, s);
      const anni = [];
      let tot = 0;
      if (s === 'Da scegliere') {
        const file = await this.#fileIn(base);
        if (file.length) anni.push({ anno: '', album: [{ chiave: s, titolo: 'Foto quasi uguali da guardare', n: file.length, copertina: this.rel(file[0]) }] });
        tot = file.length;
      } else {
        const elenco = (await fsp.readdir(base, { withFileTypes: true }).catch(() => [])).filter((v) => v.isDirectory() && /^\d{4}$/.test(v.name));
        for (const a of elenco.map((v) => v.name).sort().reverse()) {
          const dirAnno = path.join(base, a);
          const album = [];
          const sotto = (await fsp.readdir(dirAnno, { withFileTypes: true }).catch(() => [])).filter((v) => v.isDirectory() && /^\d{2} /.test(v.name));
          if (sotto.length && s !== 'Screenshot') {
            for (const m of sotto.map((v) => v.name).sort().reverse()) {
              const file = await this.#fileIn(path.join(dirAnno, m));
              if (file.length) album.push({ chiave: `${s}/${a}/${m}`, titolo: m.replace(/^\d{2} /, ''), n: file.length, copertina: this.rel(file[Math.floor(file.length / 2)]) });
            }
          } else {
            const file = await this.#fileIn(dirAnno);
            if (file.length) album.push({ chiave: `${s}/${a}`, titolo: s === 'Screenshot' ? 'Screenshot' : 'Tutto l\'anno', n: file.length, copertina: this.rel(file[0]) });
          }
          const n = album.reduce((t, x) => t + x.n, 0);
          if (n) anni.push({ anno: a, n, album });
          tot += n;
        }
      }
      sezioni[s] = anni;
      totali[s] = tot;
    }
    const dati = { archivio: this.archivio, sezioni, totali };
    this.cache = { t: Date.now(), dati };
    return dati;
  }

  /** Le foto di un album, raggruppate per giornata. */
  async album(chiave) {
    const dir = this.risolvi(chiave);
    if (!dir) throw new Error('album non valido');
    const file = await this.#fileIn(dir);
    const gruppi = new Map();
    for (const f of file) {
      const relDir = path.relative(dir, path.dirname(f));
      // le giornate "speciali" hanno una cartella propria; le altre foto le raggruppo per data nel nome
      const k = relDir && relDir !== '.' ? relDir.split(path.sep)[0] : (path.basename(f).match(GIORNO)?.[0] || 'Altro');
      if (!gruppi.has(k)) gruppi.set(k, []);
      gruppi.get(k).push({ p: this.rel(f), nome: path.basename(f), tipo: tipoDi(f) });
    }
    return {
      chiave,
      gruppi: [...gruppi.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, voci]) => {
        // "2025-05-03 Sabato - Ponza" → "Sabato 3 maggio 2025 · Ponza"
        const luogo = GIORNO.test(k) ? (k.split(' - ').slice(1).join(' - ').trim()) : '';
        return { titolo: luogo ? `${titoloGiorno(k)} · ${luogo}` : titoloGiorno(k), speciale: k.length > 10 && GIORNO.test(k), voci };
      }),
    };
  }

  async #cacheAnteprima(abs) {
    const st = await fsp.stat(abs);
    const nome = crypto.createHash('sha1').update(`${abs}|${st.size}|${st.mtimeMs}`).digest('hex');
    const file = path.join(this.archivio, '_JARVIS', 'anteprime', `${nome}.jpg`);
    try { return await fsp.readFile(file); } catch { /* da creare */ }
    const jpg = await anteprimaRaw(abs);
    if (jpg) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, jpg).catch(() => {});
    }
    return jpg;
  }

  /** Gestisce le richieste /galleria e /api/galleria/…; restituisce true se ha risposto. */
  async gestisci(u, q, r) {
    if (u.pathname === '/galleria') {
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      fs.createReadStream(PAGINA).pipe(r);
      return true;
    }
    if (!u.pathname.startsWith('/api/galleria')) return false;
    const json = (codice, dati) => { r.writeHead(codice, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); r.end(JSON.stringify(dati)); };
    if (!this.jarvis.archivioDisponibile()) { json(503, { errore: `Il disco dell'archivio (${this.jarvis.discoArchivio}) è spento o scollegato.` }); return true; }
    try {
      const azione = u.pathname.slice('/api/galleria'.length);
      if (azione === '' || azione === '/') { json(200, await this.indice()); return true; }
      if (azione === '/album') { json(200, await this.album(u.searchParams.get('c'))); return true; }
      if (azione === '/mostra' && q.method === 'POST' && q.headers['x-jarvis'] === '1') {
        // l'intestazione speciale impedisce a un sito qualsiasi di usare questo comando
        const abs = this.risolvi(u.searchParams.get('p'));
        if (!abs) { json(400, { errore: 'percorso non valido' }); return true; }
        if (process.platform === 'win32') spawn('explorer.exe', [`/select,${abs}`], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        json(200, { ok: true });
        return true;
      }
      const abs = this.risolvi(u.searchParams.get('p'));
      if (!abs || !fs.existsSync(abs)) { r.writeHead(404); r.end(); return true; }
      const ext = path.extname(abs).toLowerCase();
      if (azione === '/min') {
        const t = await miniaturaEXIF(abs);
        if (t?.length) { r.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' }); r.end(t); return true; }
        if (RAW.has(ext)) {
          const jpg = await this.#cacheAnteprima(abs);
          if (jpg) { r.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' }); r.end(jpg); return true; }
        }
        if (MIME[ext]?.startsWith('image/') && (await fsp.stat(abs)).size < 25 * 1024 * 1024) return this.#invia(abs, ext, q, r);
        r.writeHead(204); r.end(); return true;
      }
      if (azione === '/foto') {
        if (RAW.has(ext)) {
          const jpg = await this.#cacheAnteprima(abs);
          if (jpg) { r.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' }); r.end(jpg); return true; }
        }
        if (MIME[ext]) return this.#invia(abs, ext, q, r);
        const t = await miniaturaEXIF(abs); // HEIC e TIFF: il browser non li sa mostrare, uso la miniatura interna
        if (t?.length) { r.writeHead(200, { 'content-type': 'image/jpeg' }); r.end(t); return true; }
        r.writeHead(415); r.end(); return true;
      }
      r.writeHead(404); r.end(); return true;
    } catch (e) {
      json(500, { errore: e.message });
      return true;
    }
  }

  // Invia un file, con supporto ai "range" per far scorrere i video.
  async #invia(abs, ext, q, r) {
    const st = await fsp.stat(abs);
    const tipo = MIME[ext] || 'application/octet-stream';
    const range = q.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const inizio = range[1] ? Number(range[1]) : 0;
      const fine = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      r.writeHead(206, { 'content-type': tipo, 'content-range': `bytes ${inizio}-${fine}/${st.size}`, 'accept-ranges': 'bytes', 'content-length': fine - inizio + 1 });
      fs.createReadStream(abs, { start: inizio, end: fine }).pipe(r);
    } else {
      r.writeHead(200, { 'content-type': tipo, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'max-age=3600' });
      fs.createReadStream(abs).pipe(r);
    }
    return true;
  }
}
