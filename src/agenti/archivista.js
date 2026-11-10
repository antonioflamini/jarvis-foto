// AGENTE ARCHIVISTA
// Legge la data vera di ogni foto/video, riconosce doppioni (impronta SHA-256) e foto quasi uguali
// (impronta visiva), decide il posto giusto nell'archivio, rinomina in modo uniforme e copia/sposta con verifica.
//
// Struttura dell'archivio:
//   JARVIS_Foto/
//     Arrivi/                                              ← butta qui foto, zip, esportazioni: JARVIS le smista
//     Foto/2026/11 Novembre/2026-11-10_14-35-02_iPhone15.jpg
//     Foto/2026/11 Novembre/2026-11-08 Domenica - Ponza/…  ← giornate con tante foto, col nome del luogo
//     Video/2026/11 Novembre/…
//     Screenshot/2026/…
//     Da scegliere/2026-11-08_16-00-20/…                    ← foto quasi uguali a una già in archivio
//     _JARVIS/  indice.json, registro/, Doppioni/, Annullati/, Zip_importati/
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';
import {
  cartellaMese, giornoISO, timbro, impronta, inParallelo, scriviJSON, leggiJSON, ora, GIORNI, DUE, esiste,
} from '../util.js';
import { tipoDi } from './esploratore.js';
import { improntaVisiva, distanza, SOGLIA_BIT, FINESTRA_MS } from './simili.js';
import { luogoVicino, luogoPrevalente } from './luoghi.js';

const DATA_MINIMA = new Date(1990, 0, 1).getTime();
const valida = (d) => d instanceof Date && !isNaN(d) && d.getTime() > DATA_MINIMA && d.getTime() < Date.now() + 2 * 86400000;
export const CARTELLE_ARCHIVIO = ['Foto', 'Video', 'Screenshot', 'Da scegliere'];

// ---------- Lettura della data ----------

async function dataVideo(file) {
  // Legge la data di creazione dal box "mvhd" dei file MP4/MOV/3GP (salvata in UTC, secondi dal 1904).
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(32);
    const cerca = async (inizio, fine, dentro) => {
      let pos = inizio;
      while (pos + 8 <= fine) {
        const { bytesRead } = await fh.read(buf, 0, 32, pos);
        if (bytesRead < 8) return null;
        let lung = buf.readUInt32BE(0);
        const tipo = buf.toString('latin1', 4, 8);
        let testa = 8;
        if (lung === 1) { lung = Number(buf.readBigUInt64BE(8)); testa = 16; } else if (lung === 0) lung = fine - pos;
        if (!dentro && tipo === 'moov') return cerca(pos + testa, pos + lung, true);
        if (dentro && tipo === 'mvhd') {
          const ver = buf[8];
          const sec = ver === 1 ? Number(buf.readBigUInt64BE(12)) : buf.readUInt32BE(12);
          return sec ? new Date((sec - 2082844800) * 1000) : null;
        }
        if (lung < 8) return null;
        pos += lung;
      }
      return null;
    };
    return await cerca(0, size, false);
  } finally {
    await fh.close();
  }
}

const RE_DATA = /(?<!\d)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_ T.]{0,3}([01]\d|2[0-3])[-_.:h]?([0-5]\d)[-_.:m]?([0-5]\d))?/;
const RE_EPOCA_MS = /(?<!\d)(1[3-7]\d{11})(?!\d)/;

function dataDalNome(nome, mtime) {
  const m = nome.match(RE_DATA);
  if (m) {
    const [, a, me, g, h, mi, s] = m;
    const stessoGiorno = mtime && giornoISO(mtime) === `${a}-${me}-${g}`;
    let d;
    if (h !== undefined) d = new Date(+a, +me - 1, +g, +h, +mi, +s);
    else if (stessoGiorno) d = new Date(mtime);
    else d = new Date(+a, +me - 1, +g, 12, 0, 0);
    if (valida(d) && d.getDate() === +g) return { data: d, conOra: h !== undefined || !!stessoGiorno };
  }
  const e = nome.match(RE_EPOCA_MS);
  if (e) {
    const d = new Date(Number(e[1]));
    if (valida(d)) return { data: d, conOra: true };
  }
  return null;
}

function etichettaDispositivo(marca, modello) {
  if (!modello && !marca) return '';
  let m = String(modello || marca).trim().replace(/^SM-/i, '');
  let ma = String(marca || '').trim().split(' ')[0];
  ma = ma.charAt(0).toUpperCase() + ma.slice(1).toLowerCase();
  if (ma && !m.toLowerCase().includes(ma.toLowerCase()) && !/^iphone|^ipad|^pixel|^galaxy/i.test(m)) m = `${ma} ${m}`;
  return m.replace(/corporation|co\.?,? ?ltd\.?|imaging|electronics/gi, '').replace(/[^A-Za-z0-9]+/g, '').slice(0, 20);
}

// File .json di Google Takeout: data di scatto (UTC) e posizione.
async function leggiSidecar(percorso) {
  if (!percorso) return null;
  try {
    const j = JSON.parse(await fsp.readFile(percorso, 'utf8'));
    const ts = Number(j.photoTakenTime?.timestamp || j.creationTime?.timestamp);
    const geo = [j.geoDataExif, j.geoData].find((g) => g && (g.latitude || g.longitude));
    return {
      data: ts ? new Date(ts * 1000) : null,
      gps: geo ? { lat: Number(geo.latitude), lon: Number(geo.longitude) } : null,
    };
  } catch {
    return null;
  }
}

export async function leggiData(file) {
  const tipo = tipoDi(file.nome);
  let dispositivo = '';
  let gps = null;
  let dataExif = null;
  if (tipo === 'foto') {
    try {
      const x = await exifr.parse(file.percorso, {
        pick: ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'Make', 'Model',
          'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef'],
        gps: true, interop: false, ifd1: false, translateValues: false,
      });
      if (x) {
        dispositivo = etichettaDispositivo(x.Make, x.Model);
        if (Number.isFinite(x.latitude) && Number.isFinite(x.longitude)) gps = { lat: x.latitude, lon: x.longitude };
        dataExif = ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized'].map((k) => x[k]).find(valida) || null;
      }
    } catch { /* formato senza EXIF leggibile */ }
  }
  const sidecar = await leggiSidecar(file.sidecar);
  if (!gps && sidecar?.gps && !(sidecar.gps.lat === 0 && sidecar.gps.lon === 0)) gps = sidecar.gps;
  if (dataExif) return { data: dataExif, fonte: 'exif', dispositivo, gps };

  const dalNome = dataDalNome(file.nome, file.mtime);
  if (tipo === 'video' && /\.(mp4|mov|m4v|3gp)$/i.test(file.nome)) {
    try {
      const d = await dataVideo(file.percorso);
      if (valida(d)) {
        // Molti Android scrivono l'ora locale come se fosse UTC: se il nome del file (che è in ora locale)
        // differisce di un numero intero di ore, mi fido del nome.
        if (dalNome?.conOra) {
          const diff = Math.abs(d - dalNome.data);
          const resto = diff % 3600000;
          if (diff > 120000 && diff <= 14 * 3600000 && (resto <= 120000 || resto >= 3480000)) {
            return { data: dalNome.data, fonte: 'video', dispositivo, gps, corretto: true };
          }
        }
        return { data: d, fonte: 'video', dispositivo, gps };
      }
    } catch { /* intestazione non leggibile */ }
  }
  if (valida(sidecar?.data)) return { data: sidecar.data, fonte: 'takeout', dispositivo, gps };
  if (dalNome) return { data: dalNome.data, fonte: 'nome', dispositivo, gps };
  return { data: new Date(file.mtime), fonte: 'file', dispositivo, gps };
}

function categoriaDi(file) {
  if (file.tipo === 'video') return 'Video';
  const p = file.percorso.toLowerCase();
  if (/screenshot|screen[_ -]?shot|schermata|cattura di schermata|captura/.test(path.basename(p)) || /[\\/]screenshots?[\\/]/.test(p)) {
    return 'Screenshot';
  }
  return 'Foto';
}

function etichettaOrigine(file, dispositivo) {
  if (/-WA\d+/i.test(file.nome) || /whatsapp/i.test(file.percorso)) return 'WhatsApp';
  if (/telegram/i.test(file.percorso)) return 'Telegram';
  return dispositivo;
}

// Controlla la "firma" dei formati più comuni: scarta file danneggiati o rinominati per sbaglio.
const FIRME = { jpg: [0xff, 0xd8], jpeg: [0xff, 0xd8], jpe: [0xff, 0xd8], png: [0x89, 0x50, 0x4e, 0x47], gif: [0x47, 0x49, 0x46] };
async function firmaValida(percorso) {
  const attesa = FIRME[path.extname(percorso).slice(1).toLowerCase()];
  if (!attesa) return true;
  try {
    const fh = await fsp.open(percorso, 'r');
    const buf = Buffer.alloc(attesa.length);
    await fh.read(buf, 0, attesa.length, 0);
    await fh.close();
    return attesa.every((b, i) => buf[i] === b);
  } catch {
    return false;
  }
}

// ---------- Indice: doppioni e impronte visive ----------

export class Indice {
  constructor(archivio) {
    this.archivio = archivio;
    this.file = path.join(archivio, '_JARVIS', 'indice.json');
    this.mappa = new Map(); // sha256 → percorso relativo
    this.simili = new Map(); // sha256 → [impronta visiva, data scatto ms, dimensione]
  }

  async carica(emetti, conSimili = true) {
    const d = await leggiJSON(this.file, null);
    if (d?.file) {
      this.mappa = new Map(Object.entries(d.file));
      this.simili = new Map(Object.entries(d.simili || {}));
      return;
    }
    if (await esiste(this.archivio)) await this.ricostruisci(emetti, conSimili);
  }

  async ricostruisci(emetti, conSimili = true) {
    this.mappa = new Map();
    this.simili = new Map();
    const tutti = [];
    const archivio = this.archivio;
    async function cammina(dir) {
      for (const v of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, v.name);
        if (v.isDirectory()) { if (dir !== archivio || CARTELLE_ARCHIVIO.includes(v.name)) await cammina(p); } else if (tipoDi(v.name)) tutti.push(p);
      }
    }
    await cammina(archivio);
    if (!tutti.length) return 0;
    emetti?.({ t: 'messaggio', testo: `Ricostruisco l'indice dell'archivio (${tutti.length} file)…` });
    await inParallelo(tutti, 4, async (p, i) => {
      const h = await impronta(p).catch(() => null);
      if (!h) return;
      this.mappa.set(h, path.relative(this.archivio, p));
      if (conSimili && tipoDi(p) === 'foto' && !p.includes(`${path.sep}Da scegliere${path.sep}`)) {
        const st = await fsp.stat(p);
        const dh = await improntaVisiva(p, st.size);
        if (dh) {
          const info = await leggiData({ percorso: p, nome: path.basename(p), mtime: st.mtime });
          this.simili.set(h, [dh, info.data.getTime(), st.size]);
        }
      }
      if (i % 50 === 0) emetti?.({ t: 'analisi', fatti: i, n: tutti.length, fase: 'indice' });
    });
    await this.salva();
    return tutti.length;
  }

  rimuovi(hash) {
    this.mappa.delete(hash);
    this.simili.delete(hash);
  }

  async salva() {
    await scriviJSON(this.file, {
      versione: 2, aggiornato: new Date().toISOString(),
      file: Object.fromEntries(this.mappa), simili: Object.fromEntries(this.simili),
    });
  }
}

// ---------- Pianificazione ----------

/**
 * Analizza i file (data, impronte, posizione) e prepara il piano: dove va ciascun file e con che nome.
 * Non modifica nulla su disco.
 */
export async function pianifica(file, cfg, indice, emetti = () => {}) {
  const n = file.length;
  let fatti = 0;
  const conSimili = cfg.simili !== false;
  const analizzati = await inParallelo(file, 6, async (f) => {
    const [info, hash, valido] = await Promise.all([leggiData(f), impronta(f.percorso).catch(() => null), firmaValida(f.percorso)]);
    const dh = conSimili && f.tipo === 'foto' && valido && categoriaDi(f) === 'Foto' ? await improntaVisiva(f.percorso, f.dimensione) : null;
    fatti++;
    if (fatti % 10 === 0 || fatti === n) emetti({ t: 'analisi', fatti, n, fase: 'exif' });
    return { ...f, ...info, hash, valido, dh, categoria: categoriaDi(f), luogo: info.gps ? luogoVicino(info.gps.lat, info.gps.lon) : null };
  });
  analizzati.sort((a, b) => a.data - b.data);

  // 1) Live Photo dell'iPhone: foto e video brevi con lo stesso nome nella stessa cartella restano insieme.
  const fotoPerNome = new Map();
  for (const a of analizzati) if (a.tipo === 'foto') fotoPerNome.set(path.join(path.dirname(a.percorso), path.parse(a.nome).name).toLowerCase(), a);
  for (const a of analizzati) {
    if (a.tipo !== 'video' || !/\.(mov|mp4)$/i.test(a.nome)) continue;
    const foto = fotoPerNome.get(path.join(path.dirname(a.percorso), path.parse(a.nome).name).toLowerCase());
    if (foto && Math.abs(foto.data - a.data) < 12 * 3600000) { a.compagnoDi = foto; foto.compagno = a; }
  }

  // 2) Doppioni esatti (archivio e stesso lotto) e file non validi.
  const visti = new Set();
  for (const a of analizzati) {
    a.esito = 'nuovo';
    if (!a.hash) { a.esito = 'errore'; a.motivo = 'file non leggibile'; } else if (!a.valido) {
      a.esito = 'errore'; a.motivo = 'non è una vera immagine (file danneggiato o rinominato)';
    } else if (indice.mappa.has(a.hash)) { a.esito = 'doppione'; a.giaIn = indice.mappa.get(a.hash); } else if (visti.has(a.hash)) {
      a.esito = 'doppione'; a.giaIn = 'stesso lotto';
    } else visti.add(a.hash);
  }

  // 3) Foto quasi uguali: copie ridotte, raffiche. Resta nella linea del tempo la versione più grande,
  //    le altre vanno in "Da scegliere" (mai cancellate).
  const gruppiSimili = [];
  if (conSimili) {
    const nuove = analizzati.filter((a) => a.esito === 'nuovo' && a.dh);
    const archivioSimili = [...indice.simili].map(([h, [dh, ts, dim]]) => ({ dh, ts, dim, rel: indice.mappa.get(h) }))
      .filter((x) => x.rel).sort((a, b) => a.ts - b.ts);
    const padre = new Map();
    const trova = (x) => { while (padre.get(x) !== x) { padre.set(x, padre.get(padre.get(x))); x = padre.get(x); } return x; };
    const unisci = (a, b) => { const ra = trova(a), rb = trova(b); if (ra !== rb) padre.set(ra, rb); };
    for (const a of nuove) padre.set(a, a);
    for (let i = 0; i < nuove.length; i++) {
      for (let j = i + 1; j < nuove.length && nuove[j].data - nuove[i].data <= FINESTRA_MS; j++) {
        if (distanza(nuove[i].dh, nuove[j].dh) <= SOGLIA_BIT) unisci(nuove[i], nuove[j]);
      }
    }
    // somiglianza con foto già in archivio (solo entro la finestra di tempo, per essere veloci)
    const vicinoInArchivio = new Map();
    let k0 = 0;
    for (const a of nuove) {
      const t = a.data.getTime();
      while (k0 < archivioSimili.length && archivioSimili[k0].ts < t - FINESTRA_MS) k0++;
      for (let k = k0; k < archivioSimili.length && archivioSimili[k].ts <= t + FINESTRA_MS; k++) {
        const x = archivioSimili[k];
        if (distanza(a.dh, x.dh) <= SOGLIA_BIT && (!vicinoInArchivio.get(a) || x.dim > vicinoInArchivio.get(a).dim)) vicinoInArchivio.set(a, x);
      }
    }
    const gruppi = new Map();
    for (const a of nuove) {
      const r = trova(a);
      if (!gruppi.has(r)) gruppi.set(r, []);
      gruppi.get(r).push(a);
    }
    for (const membri of gruppi.values()) {
      const inArchivio = membri.map((m) => vicinoInArchivio.get(m)).filter(Boolean).sort((a, b) => b.dim - a.dim)[0];
      if (membri.length < 2 && !inArchivio) continue;
      const ordinati = [...membri].sort((a, b) => b.dimensione - a.dimensione);
      const migliore = inArchivio && inArchivio.dim >= ordinati[0].dimensione ? null : ordinati[0];
      const scartati = membri.filter((m) => m !== migliore);
      if (!scartati.length) continue;
      const riferimento = migliore || { data: new Date(inArchivio.ts) };
      const gruppo = { cartella: path.join('Da scegliere', timbro(riferimento.data)), migliore, inArchivio: inArchivio?.rel || null, membri: scartati };
      for (const s of scartati) { s.simile = gruppo; s.categoria = 'Foto'; }
      gruppiSimili.push(gruppo);
    }
  }

  // 4) Giornate "evento" (tante foto nello stesso giorno), col nome del luogo se c'è il GPS.
  const perGiorno = new Map();
  for (const a of analizzati) {
    if (a.esito !== 'nuovo' || a.categoria !== 'Foto' || a.simile || a.compagnoDi) continue;
    const g = giornoISO(a.data);
    if (!perGiorno.has(g)) perGiorno.set(g, []);
    perGiorno.get(g).push(a);
  }
  const cacheMese = new Map();
  async function cartellaGiornoEsistente(dirMese, g) {
    if (!cacheMese.has(dirMese)) {
      const voci = await fsp.readdir(path.join(cfg.archivio, dirMese), { withFileTypes: true }).catch(() => []);
      cacheMese.set(dirMese, voci.filter((v) => v.isDirectory()).map((v) => v.name));
    }
    return cacheMese.get(dirMese).find((nome) => nome.startsWith(g)) || null;
  }

  const riservati = new Set();
  const giornate = new Map();
  const occupato = (rel) => riservati.has(rel.toLowerCase()) || fs.existsSync(path.join(cfg.archivio, rel));
  function nomeLibero(dir, base, ext) {
    let nome = `${base}${ext}`;
    for (let k = 2; occupato(path.join(dir, nome)); k++) nome = `${base}_${DUE(k)}${ext}`;
    riservati.add(path.join(dir, nome).toLowerCase());
    return path.join(dir, nome);
  }
  const estensione = (nome) => path.extname(nome).toLowerCase().replace(/^\.jpe?g$|^\.jpe$/, '.jpg');

  for (const a of analizzati) {
    if (a.esito !== 'nuovo' || a.compagnoDi) continue;
    const d = a.data;
    const anno = String(d.getFullYear());
    let dir;
    if (a.simile) dir = a.simile.cartella;
    else if (a.categoria === 'Screenshot') dir = path.join('Screenshot', anno);
    else dir = path.join(a.categoria, anno, cartellaMese(d));
    if (a.categoria === 'Foto' && !a.simile) {
      const g = giornoISO(d);
      const esistente = await cartellaGiornoEsistente(dir, g);
      if (esistente) dir = path.join(dir, esistente);
      else if ((perGiorno.get(g)?.length || 0) >= cfg.sogliaGiornata) {
        if (!giornate.has(g)) {
          const luogo = luogoPrevalente(perGiorno.get(g));
          giornate.set(g, `${g} ${GIORNI[d.getDay()]}${luogo ? ` - ${luogo.replace(/[<>:"/\\|?*]/g, '')}` : ''}`);
        }
        dir = path.join(dir, giornate.get(g));
      }
    }
    const etich = etichettaOrigine(a, a.dispositivo);
    a.destRel = nomeLibero(dir, `${timbro(d)}${etich ? `_${etich}` : ''}`, estensione(a.nome));
  }

  // 5) Il video della Live Photo prende lo stesso nome e la stessa cartella della sua foto.
  for (const v of analizzati) {
    if (!v.compagnoDi || v.esito !== 'nuovo') continue;
    const foto = v.compagnoDi;
    const relFoto = foto.esito === 'nuovo' ? foto.destRel : foto.esito === 'doppione' && foto.giaIn !== 'stesso lotto' ? foto.giaIn : null;
    if (!relFoto) { v.compagnoDi = null; v.destRel = nomeLibero(path.join('Video', String(v.data.getFullYear()), cartellaMese(v.data)), timbro(v.data), estensione(v.nome)); continue; }
    v.categoria = 'Foto';
    v.data = foto.data;
    v.livePhoto = true;
    v.destRel = nomeLibero(path.dirname(relFoto), path.parse(relFoto).name, estensione(v.nome));
  }

  return {
    piano: analizzati,
    giornate: [...giornate].map(([giorno, nome]) => ({ giorno, nome })),
    gruppiSimili,
  };
}

// ---------- Esecuzione ----------

async function copiaVerificata(da, a, hashAtteso, sposta) {
  await fsp.mkdir(path.dirname(a), { recursive: true });
  if (sposta) {
    try {
      await fsp.rename(da, a);
      return;
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
    }
  }
  const tmp = `${a}.jarvis-tmp`;
  await fsp.copyFile(da, tmp);
  if (sposta) {
    const h = await impronta(tmp);
    if (h !== hashAtteso) {
      await fsp.rm(tmp, { force: true });
      throw new Error('verifica fallita dopo la copia');
    }
  } else {
    const [s1, s2] = await Promise.all([fsp.stat(da), fsp.stat(tmp)]);
    if (s1.size !== s2.size) {
      await fsp.rm(tmp, { force: true });
      throw new Error('dimensione diversa dopo la copia');
    }
  }
  await fsp.rename(tmp, a);
  if (sposta) await fsp.unlink(da);
}

export async function spostaSicuro(da, a) {
  let finale = a;
  for (let k = 2; await esiste(finale); k++) finale = a.replace(/(\.[^.\\/]+)?$/, (m) => `_${k}${m}`);
  await fsp.mkdir(path.dirname(finale), { recursive: true });
  try {
    await fsp.rename(da, finale);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(da, finale, { recursive: true });
    await fsp.rm(da, { recursive: true, force: true });
  }
  return finale;
}

/**
 * Esegue il piano. `registraMiniatura(percorso)` restituisce un id per il pannello olografico.
 */
export async function esegui(pianificazione, cfg, indice, { modalita = 'copia', emetti = () => {}, registraMiniatura = () => null, sorgente }) {
  const { piano, gruppiSimili = [] } = pianificazione;
  const sposta = modalita === 'sposta';
  const timbroLotto = ora();
  const righe = [['originale', 'nuovo', 'data_scatto', 'fonte_data', 'luogo', 'esito', 'note']];
  const voci = [];
  const conteggi = { archiviati: 0, doppioni: 0, simili: 0, livePhoto: 0, errori: 0, video: 0, screenshot: 0, byte: 0, perAnno: {}, dataStimata: 0, luoghi: [] };
  const luoghi = new Set();
  const n = piano.length;
  let i = 0;

  await inParallelo(piano, 3, async (v) => {
    const idx = ++i;
    const base = {
      t: 'file', i: idx, n, nome: v.nome, tipo: v.tipo, categoria: v.categoria, anno: v.data.getFullYear(),
      mese: v.data.getMonth() + 1, data: v.data.toISOString(), fonte: v.fonte, dispositivo: v.dispositivo || '', luogo: v.luogo || '',
    };
    if (v.esito === 'doppione') {
      conteggi.doppioni++;
      let nota = `già presente: ${v.giaIn}`;
      if (sposta && !v.origineZip) {
        try {
          const finale = await spostaSicuro(v.percorso, path.join(cfg.archivio, '_JARVIS', 'Doppioni', timbroLotto, v.nome));
          voci.push({ da: v.percorso, a: path.relative(cfg.archivio, finale), esito: 'doppione_spostato' });
          nota += ' (spostato in _JARVIS/Doppioni)';
        } catch { /* lasciato dov'era */ }
      }
      righe.push([v.percorso, '', v.data.toISOString(), v.fonte, v.luogo || '', 'doppione', nota]);
      emetti({ ...base, esito: 'doppione', giaIn: v.giaIn });
      return;
    }
    if (v.esito === 'errore') {
      conteggi.errori++;
      righe.push([v.percorso, '', '', '', '', 'errore', v.motivo]);
      emetti({ ...base, esito: 'errore', motivo: v.motivo });
      return;
    }
    const dest = path.join(cfg.archivio, v.destRel);
    const spostaQuesto = sposta && !v.origineZip;
    try {
      await copiaVerificata(v.percorso, dest, v.hash, spostaQuesto);
      if (v.fonte !== 'file') await fsp.utimes(dest, v.data, v.data).catch(() => {});
      indice.mappa.set(v.hash, v.destRel);
      if (v.dh && !v.simile) indice.simili.set(v.hash, [v.dh, v.data.getTime(), v.dimensione]);
      voci.push({ da: v.percorso, a: v.destRel, esito: 'archiviato', hash: v.hash, spostato: spostaQuesto });
      conteggi.archiviati++;
      conteggi.byte += v.dimensione;
      if (v.tipo === 'video' && !v.livePhoto) conteggi.video++;
      if (v.livePhoto) conteggi.livePhoto++;
      if (v.simile) conteggi.simili++;
      if (v.categoria === 'Screenshot') conteggi.screenshot++;
      if (v.fonte === 'file') conteggi.dataStimata++;
      if (v.luogo) luoghi.add(v.luogo);
      const anno = v.data.getFullYear();
      conteggi.perAnno[anno] = (conteggi.perAnno[anno] || 0) + 1;
      const note = [v.fonte === 'file' ? 'data stimata dal file' : '', v.corretto ? 'ora del video corretta' : '',
        v.livePhoto ? 'Live Photo' : '', v.simile ? 'simile a un\'altra foto' : ''].filter(Boolean).join('; ');
      righe.push([v.percorso, v.destRel, v.data.toISOString(), v.fonte, v.luogo || '', 'archiviato', note]);
      emetti({ ...base, esito: v.simile ? 'simile' : 'archiviato', nuovo: v.destRel.replace(/\\/g, '/'), miniatura: registraMiniatura(dest) });
      if (conteggi.archiviati % 200 === 0) await indice.salva();
    } catch (e) {
      conteggi.errori++;
      righe.push([v.percorso, v.destRel, v.data.toISOString(), v.fonte, v.luogo || '', 'errore', e.message]);
      emetti({ ...base, esito: 'errore', motivo: e.message });
    }
  });

  // Un promemoria in ogni gruppo di foto simili, per sapere a cosa somigliano.
  for (const g of gruppiSimili) {
    const dir = path.join(cfg.archivio, g.cartella);
    if (!(await esiste(dir))) continue;
    const tenuta = g.migliore?.destRel || g.inArchivio;
    const testo = 'JARVIS - foto quasi uguali\r\n\r\n' +
      `Queste foto somigliano molto a quella tenuta nella linea del tempo:\r\n  ${String(tenuta).replace(/\\/g, '/')}\r\n\r\n` +
      'Guarda e tieni quelle che ti piacciono (spostale dove vuoi), cancella le altre.\r\n';
    await fsp.writeFile(path.join(dir, 'LEGGIMI.txt'), testo, 'utf8').catch(() => {});
  }

  await indice.salva();
  const csv = '﻿' + righe.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const dirRegistro = path.join(cfg.archivio, '_JARVIS', 'registro');
  await fsp.mkdir(dirRegistro, { recursive: true });
  const fileRegistro = path.join(dirRegistro, `${timbroLotto}_importazione.csv`);
  await fsp.writeFile(fileRegistro, csv, 'utf8');
  await scriviJSON(path.join(dirRegistro, `${timbroLotto}_importazione.json`), { quando: new Date().toISOString(), sorgente, modalita, voci });
  conteggi.luoghi = [...luoghi].slice(0, 20);
  const riepilogo = { quando: new Date().toISOString(), sorgente, modalita, totale: n, ...conteggi, registro: fileRegistro };
  await scriviJSON(path.join(cfg.archivio, '_JARVIS', 'ultima_importazione.json'), riepilogo);
  return riepilogo;
}

// ---------- Annulla l'ultima importazione ----------

async function rimuoviCartelleVuote(radice, dir) {
  let d = dir;
  while (d.startsWith(radice) && d !== radice && !CARTELLE_ARCHIVIO.map((c) => path.join(radice, c)).includes(d)) {
    const voci = await fsp.readdir(d).catch(() => null);
    if (!voci) break;
    const restanti = voci.filter((v) => v !== 'LEGGIMI.txt');
    if (restanti.length) break;
    for (const v of voci) await fsp.rm(path.join(d, v), { force: true });
    await fsp.rmdir(d).catch(() => {});
    d = path.dirname(d);
  }
}

export async function annullaUltima(archivio) {
  const dirRegistro = path.join(archivio, '_JARVIS', 'registro');
  const elenco = (await fsp.readdir(dirRegistro).catch(() => [])).filter((f) => f.endsWith('_importazione.json')).sort().reverse();
  let fileJ = null;
  let reg = null;
  for (const f of elenco) {
    const r = await leggiJSON(path.join(dirRegistro, f), null);
    if (r && !r.annullata) { fileJ = path.join(dirRegistro, f); reg = r; break; }
  }
  if (!reg) throw new Error('Non c\'è nessuna importazione da annullare.');
  const indice = new Indice(archivio);
  await indice.carica(null, false);
  const timbroA = ora();
  const esito = { importazione: reg.quando, sorgente: reg.sorgente, rimessiAlPosto: 0, messiDaParte: 0, mancanti: 0 };
  for (const v of reg.voci) {
    const nellArchivio = path.join(archivio, v.a);
    if (!(await esiste(nellArchivio))) { esito.mancanti++; continue; }
    const tornaIndietro = (v.spostato || v.esito === 'doppione_spostato') && !(await esiste(v.da)) && (await esiste(path.dirname(path.dirname(v.da))));
    if (tornaIndietro) {
      await spostaSicuro(nellArchivio, v.da);
      esito.rimessiAlPosto++;
    } else {
      // Copia: l'originale esiste ancora, quindi la copia va da parte (non cancello mai).
      await spostaSicuro(nellArchivio, path.join(archivio, '_JARVIS', 'Annullati', timbroA, v.a));
      esito.messiDaParte++;
    }
    if (v.hash) indice.rimuovi(v.hash);
    await rimuoviCartelleVuote(archivio, path.dirname(nellArchivio));
  }
  await indice.salva();
  reg.annullata = new Date().toISOString();
  await scriviJSON(fileJ, reg);
  if (esito.messiDaParte) esito.cartellaAnnullati = path.join(archivio, '_JARVIS', 'Annullati', timbroA);
  return esito;
}

// ---------- Statistiche e consultazione ----------

export async function statisticheArchivio(archivio) {
  const s = { foto: 0, video: 0, screenshot: 0, daScegliere: 0, byte: 0, perAnno: {} };
  async function cammina(dir, cat, anno) {
    for (const v of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, v.name);
      if (v.isDirectory()) { await cammina(p, cat, anno); continue; }
      const tipo = tipoDi(v.name);
      if (!tipo) continue;
      const st = await fsp.stat(p).catch(() => null);
      s.byte += st?.size || 0;
      if (cat === 'Da scegliere') { s.daScegliere++; continue; }
      if (tipo === 'video') s.video++; else if (cat === 'Screenshot') s.screenshot++; else s.foto++;
      if (anno) s.perAnno[anno] = (s.perAnno[anno] || 0) + 1;
    }
  }
  for (const cat of CARTELLE_ARCHIVIO) {
    const dirCat = path.join(archivio, cat);
    if (cat === 'Da scegliere') { await cammina(dirCat, cat, null); continue; }
    for (const anno of await fsp.readdir(dirCat).catch(() => [])) if (/^\d{4}$/.test(anno)) await cammina(path.join(dirCat, anno), cat, anno);
  }
  return s;
}

export async function elencaDaScegliere(archivio) {
  const dir = path.join(archivio, 'Da scegliere');
  const gruppi = [];
  for (const g of (await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((v) => v.isDirectory())) {
    const file = (await fsp.readdir(path.join(dir, g.name))).filter((f) => tipoDi(f));
    if (!file.length) continue;
    const leggimi = await fsp.readFile(path.join(dir, g.name, 'LEGGIMI.txt'), 'utf8').catch(() => '');
    gruppi.push({ cartella: path.join(dir, g.name), foto: file.length, simileA: (leggimi.match(/\n {2}(.+)\r?\n/) || [])[1] || null });
  }
  return { totaleGruppi: gruppi.length, totaleFoto: gruppi.reduce((s, g) => s + g.foto, 0), gruppi: gruppi.slice(-30) };
}

// Dà un nome a una giornata: "2026-11-08 Domenica" → "2026-11-08 Domenica - Raccolta AVIS"
export async function rinominaGiornata(archivio, giorno, descrizione, nomeSicuro) {
  const [a, m, g] = giorno.split('-').map(Number);
  const d = new Date(a, m - 1, g);
  if (isNaN(d) || giornoISO(d) !== giorno) throw new Error('Data non valida: usa il formato AAAA-MM-GG');
  const dirMese = path.join(archivio, 'Foto', String(a), cartellaMese(d));
  const voci = await fsp.readdir(dirMese, { withFileTypes: true }).catch(() => []);
  const nuovoNome = `${giorno} ${GIORNI[d.getDay()]} - ${nomeSicuro(descrizione)}`;
  const indice = new Indice(archivio);
  await indice.carica(null, false);
  const esistente = voci.find((v) => v.isDirectory() && v.name.startsWith(giorno));
  const aggiornaIndice = (vecchioPrefisso, nuovoPrefisso) => {
    for (const [h, rel] of indice.mappa) {
      if (rel.toLowerCase().startsWith(vecchioPrefisso.toLowerCase())) indice.mappa.set(h, nuovoPrefisso + rel.slice(vecchioPrefisso.length));
    }
  };
  if (esistente) {
    await fsp.rename(path.join(dirMese, esistente.name), path.join(dirMese, nuovoNome));
    aggiornaIndice(path.relative(archivio, path.join(dirMese, esistente.name)) + path.sep, path.relative(archivio, path.join(dirMese, nuovoNome)) + path.sep);
    await indice.salva();
    return { cartella: path.join(dirMese, nuovoNome), spostati: 0, rinominata: true };
  }
  // Nessuna cartella: la creo e ci metto le foto di quel giorno che stanno sciolte nel mese.
  const sciolte = voci.filter((v) => v.isFile() && v.name.startsWith(giorno));
  if (!sciolte.length) throw new Error(`Nessuna foto del ${giorno} nell'archivio`);
  const dest = path.join(dirMese, nuovoNome);
  await fsp.mkdir(dest, { recursive: true });
  for (const v of sciolte) {
    await fsp.rename(path.join(dirMese, v.name), path.join(dest, v.name));
    aggiornaIndice(path.relative(archivio, path.join(dirMese, v.name)), path.relative(archivio, path.join(dest, v.name)));
  }
  await indice.salva();
  return { cartella: dest, spostati: sciolte.length, rinominata: false };
}
