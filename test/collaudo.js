// Collaudo automatico di JARVIS Foto: crea foto e video finti (con EXIF, GPS, Takeout, Live Photo…),
// importa, controlla, fa backup, verifica, annulla e prova la sentinella.
// Uso: npm test   (lavora solo in una cartella temporanea)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ZipArchive } from 'archiver';
import jpegjs from 'jpeg-js';
import { Jarvis } from '../src/jarvis.js';
import { caricaConfig } from '../src/config.js';
import { Sentinella } from '../src/agenti/sentinella.js';
import { jpegIncorporati, anteprimaRaw, conOrientamento } from '../src/agenti/galleria.js';
import exifr from 'exifr';

// ---------- Generatori di file finti ----------

function immagine(seme, w, h) {
  // Sfumature sinusoidali casuali: si comportano come una foto vera quando vengono ridotte.
  let x = ((seme + 1) * 2654435761) >>> 0;
  const casuale = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  for (let k = 0; k < 5; k++) casuale();
  const onde = Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => [casuale() * 4 - 2, casuale() * 4 - 2, casuale() * 6.28, 30 + casuale() * 40]));
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let i = 0; i < w; i++) {
      const p = (y * w + i) * 4;
      for (let c = 0; c < 3; c++) {
        let v = 128;
        for (const [fx, fy, fase, amp] of onde[c]) v += amp * Math.sin(fx * (i / w) * 6.28 + fy * (y / h) * 6.28 + fase);
        data[p + c] = Math.max(0, Math.min(255, v));
      }
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

// Scrive una struttura TIFF/EXIF con IFD0, Exif e (facoltativo) GPS.
function tiff({ marca, modello, data, gps }) {
  const asc = (s) => Buffer.from(`${s}\0`, 'latin1');
  const raz = (vals) => { const b = Buffer.alloc(8 * vals.length); vals.forEach((v, i) => { b.writeUInt32LE(Math.round(v * 10000), i * 8); b.writeUInt32LE(10000, i * 8 + 4); }); return b; };
  const gms = (d) => { const a = Math.abs(d); const g = Math.floor(a); const m = Math.floor((a - g) * 60); return [g, m, ((a - g) * 60 - m) * 60]; };
  const ifd0 = [[0x010f, 2, asc(marca)], [0x0110, 2, asc(modello)], [0x8769, 4, null]];
  if (gps) ifd0.push([0x8825, 4, null]);
  const exif = [[0x9003, 2, asc(data)]];
  const gpsIfd = gps ? [[1, 2, asc(gps.lat >= 0 ? 'N' : 'S')], [2, 5, raz(gms(gps.lat))], [3, 2, asc(gps.lon >= 0 ? 'E' : 'W')], [4, 5, raz(gms(gps.lon))]] : [];
  const lungIfd = (e) => 2 + e.length * 12 + 4;
  const off0 = 8;
  const offExif = off0 + lungIfd(ifd0);
  const offGps = offExif + lungIfd(exif);
  let dati = offGps + (gps ? lungIfd(gpsIfd) : 0);
  const blocchi = [];
  const scriviIfd = (buf, pos, voci) => {
    buf.writeUInt16LE(voci.length, pos);
    voci.forEach(([tag, tipo, val], i) => {
      const p = pos + 2 + i * 12;
      buf.writeUInt16LE(tag, p); buf.writeUInt16LE(tipo, p + 2);
      if (val === null) { buf.writeUInt32LE(1, p + 4); buf.writeUInt32LE(tag === 0x8769 ? offExif : offGps, p + 8); return; }
      buf.writeUInt32LE(tipo === 5 ? val.length / 8 : val.length, p + 4);
      if (val.length <= 4) val.copy(buf, p + 8);
      else { buf.writeUInt32LE(dati, p + 8); blocchi.push([dati, val]); dati += val.length + (val.length % 2); }
    });
  };
  const buf = Buffer.alloc(4096);
  buf.write('II', 0, 'latin1'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(off0, 4);
  scriviIfd(buf, off0, ifd0); scriviIfd(buf, offExif, exif); if (gps) scriviIfd(buf, offGps, gpsIfd);
  for (const [o, v] of blocchi) v.copy(buf, o);
  return buf.subarray(0, dati);
}

function jpeg({ data, marca = 'Apple', modello = 'iPhone 15 Pro', seme, scala = 1, gps }) {
  const base = jpegjs.encode(immagine(seme, Math.round(96 * scala), Math.round(72 * scala)), 85).data;
  if (!data) return base;
  const corpo = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff({ marca, modello, data, gps })]);
  const app1 = Buffer.alloc(4); app1.writeUInt16BE(0xffe1, 0); app1.writeUInt16BE(corpo.length + 2, 2);
  return Buffer.concat([base.subarray(0, 2), app1, corpo, base.subarray(2)]);
}

function mp4(creazione, seme) {
  const box = (tipo, corpo) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + corpo.length, 0); h.write(tipo, 4, 'latin1'); return Buffer.concat([h, corpo]); };
  const sec = Math.floor(creazione.getTime() / 1000) + 2082844800;
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(sec, 4); mvhd.writeUInt32BE(sec, 8); mvhd.writeUInt32BE(1000, 12);
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')), box('moov', box('mvhd', mvhd)), box('free', Buffer.from(`video${seme}`))]);
}

function creaZip(file, voci) {
  return new Promise((ok, ko) => {
    const out = fs.createWriteStream(file);
    const z = new ZipArchive({ zlib: { level: 1 } });
    out.on('close', ok); z.on('error', ko); z.pipe(out);
    for (const [nome, buf] of voci) z.append(buf, { name: nome });
    z.finalize();
  });
}

// ---------- Preparazione ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-collaudo-'));
const src = path.join(tmp, 'sorgente');
const scrivi = (base, rel, buf) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };
const PONZA = { lat: 40.8953, lon: 12.9589 };

let seme = 1;
for (let i = 0; i < 14; i++) scrivi(src, `DCIM/IMG_${100 + i}.JPG`, jpeg({ data: `2025:08:14 1${Math.floor(i / 6)}:${String((i * 4) % 60).padStart(2, '0')}:00`, seme: seme++, gps: PONZA }));
scrivi(src, 'DCIM/IMG_200.JPG', jpeg({ data: '2024:12:25 10:00:00', marca: 'samsung', modello: 'SM-S918B', seme: seme++ }));
scrivi(src, 'DCIM/IMG_201.JPG', jpeg({ data: '2024:12:25 10:00:00', marca: 'samsung', modello: 'SM-S918B', seme: seme++ }));
scrivi(src, 'WhatsApp/IMG-20230310-WA0001.jpg', jpeg({ seme: seme++ }));
scrivi(src, 'Screenshots/Screenshot_20250102-101010.jpg', jpeg({ seme: seme++ }));
fs.copyFileSync(path.join(src, 'DCIM/IMG_100.JPG'), path.join(src, 'copia.JPG'));
fs.writeFileSync(path.join(src, 'leggimi.txt'), 'non sono una foto');
// Google Takeout: foto senza EXIF con la data nel file .json accanto
scrivi(src, 'Takeout/Google Foto/IMG_9999.jpg', jpeg({ seme: seme++ }));
scrivi(src, 'Takeout/Google Foto/IMG_9999.jpg.supplemental-metadata.json', JSON.stringify({ photoTakenTime: { timestamp: String(Date.UTC(2021, 4, 1, 9, 0, 0) / 1000) } }));
// Live Photo: foto + video con lo stesso nome
const scattoLive = new Date(2025, 2, 1, 10, 0, 0);
scrivi(src, 'DCIM/IMG_5000.JPG', jpeg({ data: '2025:03:01 10:00:00', seme: seme++ }));
scrivi(src, 'DCIM/IMG_5000.MOV', mp4(scattoLive, 1));
// Video Android: ora locale scritta come se fosse UTC (il nome del file ha l'ora giusta)
scrivi(src, 'Camera/VID_20240601_183000.mp4', mp4(new Date(Date.UTC(2024, 5, 1, 18, 30, 0)), 2));
// Foto quasi uguale: copia ridotta di IMG_103 (come quelle di WhatsApp), stesso giorno
scrivi(src, 'WhatsApp/IMG-20250814-WA0007.jpg', jpeg({ seme: 4, scala: 0.6 }));
// zip con dentro foto (una è doppione) e un file malevolo
await creaZip(path.join(src, 'vacanze.zip'), [
  ['Ponza/P1.jpg', jpeg({ data: '2022:07:01 09:30:00', marca: 'Google', modello: 'Pixel 7', seme: seme++ })],
  ['Ponza/P2.jpg', jpeg({ data: '2022:07:01 11:30:00', marca: 'Google', modello: 'Pixel 7', seme: seme++ })],
  ['doppione.jpg', fs.readFileSync(path.join(src, 'DCIM/IMG_101.JPG'))],
  ['../../evil.jpg', Buffer.from('../fuga')],
]);

const archivio = path.join(tmp, 'JARVIS_Foto');
const disco = path.join(tmp, 'disco_esterno');
fs.mkdirSync(disco);
const j = new Jarvis(caricaConfig({ archivio, effetti: false, voce: false }));
const esiste = (rel) => fs.existsSync(path.join(archivio, rel));
const elenco = (rel) => fs.readdirSync(path.join(archivio, rel));
const MESE_AGOSTO = 'Foto/2025/08 Agosto';
let ok = 0;
const prova = async (nome, fn) => { await fn(); ok++; console.log('  ✔', nome); };
const attendiFine = async () => { while (j.lavoroInCorso) await new Promise((r) => setTimeout(r, 50)); };

try {
  await prova('anteprima: non modifica nulla', async () => {
    const a = await j.anteprima(src);
    assert.equal(a.trovati, 28);
    assert.equal(a.doppioni, 2);
    assert.equal(a.livePhoto, 1);
    assert.equal(a.simili, 1);
    assert.ok(!fs.existsSync(path.join(archivio, 'Foto')));
  });

  await prova('importazione', async () => {
    const r = await j.importa(src);
    assert.equal(r.esito, 'ok', r.errore);
    assert.equal(r.archiviati, 25);
    assert.equal(r.doppioni, 2);
    assert.equal(r.errori, 1, 'il finto .jpg viene scartato');
    assert.equal(r.simili, 1);
    assert.equal(r.livePhoto, 1);
    assert.ok(r.luoghi.includes('Ponza'));
  });

  await prova('giornata speciale col nome del luogo (GPS)', async () => {
    assert.ok(esiste(`${MESE_AGOSTO}/2025-08-14 Giovedì - Ponza/2025-08-14_10-00-00_iPhone15Pro.jpg`), elenco(MESE_AGOSTO).join(', '));
  });

  await prova('scatti nello stesso secondo non si sovrascrivono', async () => {
    assert.ok(esiste('Foto/2024/12 Dicembre/2024-12-25_10-00-00_SamsungS918B.jpg'));
    assert.ok(esiste('Foto/2024/12 Dicembre/2024-12-25_10-00-00_SamsungS918B_02.jpg'));
  });

  await prova('data dal nome WhatsApp e screenshot separati', async () => {
    assert.ok(elenco('Foto/2023/03 Marzo').some((n) => n.startsWith('2023-03-10') && n.includes('WhatsApp')));
    assert.ok(esiste('Screenshot/2025/2025-01-02_10-10-10.jpg'));
  });

  await prova('Google Takeout: data letta dal file .json', async () => {
    assert.ok(elenco('Foto/2021/05 Maggio').some((n) => n.startsWith('2021-05-01')));
  });

  await prova('Live Photo: il video resta accanto alla sua foto', async () => {
    assert.ok(esiste('Foto/2025/03 Marzo/2025-03-01_10-00-00_iPhone15Pro.jpg'));
    assert.ok(esiste('Foto/2025/03 Marzo/2025-03-01_10-00-00_iPhone15Pro.mov'));
  });

  await prova('video Android: ora corretta', async () => {
    assert.ok(esiste('Video/2024/06 Giugno/2024-06-01_18-30-00.mp4'), elenco('Video/2024/06 Giugno').join(', '));
  });

  await prova('foto quasi uguale in "Da scegliere" con LEGGIMI', async () => {
    const gruppi = elenco('Da scegliere');
    assert.equal(gruppi.length, 1);
    const dentro = elenco(`Da scegliere/${gruppi[0]}`);
    assert.ok(dentro.includes('LEGGIMI.txt') && dentro.some((n) => n.includes('WhatsApp')), dentro.join(', '));
    const ds = await j.daScegliere();
    assert.equal(ds.totaleFoto, 1);
  });

  await prova('zip letto e protetto dai percorsi malevoli', async () => {
    assert.ok(esiste('Foto/2022/07 Luglio/2022-07-01_09-30-00_Pixel7.jpg'));
    assert.ok(!fs.existsSync(path.join(tmp, 'evil.jpg')) && !fs.existsSync(path.join(os.tmpdir(), 'evil.jpg')));
  });

  await prova('originali intatti in modalità copia', async () => {
    assert.ok(fs.existsSync(path.join(src, 'DCIM/IMG_100.JPG')));
  });

  await prova('seconda importazione: tutto riconosciuto come doppione', async () => {
    const r = await j.importa(src);
    assert.equal(r.archiviati, 0);
    assert.equal(r.doppioni, 27);
  });

  await prova('non si può importare una cartella interna all\'archivio', async () => {
    await assert.rejects(() => j.importa(path.join(archivio, 'Foto')), /già dentro l'archivio/);
  });

  await prova('promemoria: nessun backup ancora fatto', async () => {
    const p = await j.promemoriaBackup();
    assert.equal(p.daFare, true);
    assert.match(p.testo, /tasto 3/);
  });

  await prova('sentinella: promemoria del backup e dello spazio, al massimo uno a settimana', async () => {
    const avvisi = [];
    const s = new Sentinella(j, { attesaPromemoria: 0, avvisa: (m) => avvisi.push(m) });
    const vero = j.leggiSpazio;
    j.leggiSpazio = async () => 2 * 1024 ** 3; // 2 GB liberi
    try {
      assert.deepEqual(await s.controllaPromemoria(), ['backup', 'spazio']);
      assert.match(avvisi[1], /restano solo/);
      s.ultimoControlloPromemoria = 0;
      assert.deepEqual(await s.controllaPromemoria(), [], 'non ripete prima di 7 giorni');
      s.ultimoControlloPromemoria = 0;
      assert.deepEqual(await s.controllaPromemoria(Date.now() + 8 * 86400000), ['backup', 'spazio']);
    } finally {
      j.leggiSpazio = vero;
      fs.rmSync(path.join(archivio, '_JARVIS', 'promemoria_avvisi.json'), { force: true });
    }
  });

  await prova('spazio insufficiente: si ferma prima di copiare', async () => {
    const nuova = path.join(tmp, 'sorgente_grande');
    scrivi(nuova, 'IMG_7000.JPG', jpeg({ data: '2026:02:01 10:00:00', seme: 7000 }));
    const vero = j.leggiSpazio;
    j.leggiSpazio = async () => 100 * 1024 ** 2; // 100 MB liberi
    try {
      const r = await j.importa(nuova);
      assert.equal(r.esito, 'errore');
      assert.match(r.errore, /Spazio insufficiente/);
      assert.ok(!esiste('Foto/2026/02 Febbraio'));
      assert.ok(fs.existsSync(path.join(nuova, 'IMG_7000.JPG')));
    } finally {
      j.leggiSpazio = vero;
    }
  });

  await prova('cartella Arrivi: svuotata e smistata', async () => {
    scrivi(j.cfg.arrivi, 'nuova.jpg', jpeg({ data: '2026:01:06 12:00:00', seme: 900 }));
    await creaZip(path.join(j.cfg.arrivi, 'amici.zip'), [['festa.jpg', jpeg({ data: '2026:01:07 21:00:00', seme: 901 })]]);
    scrivi(j.cfg.arrivi, 'appunti.txt', 'ciao');
    const r = await j.importaArrivi();
    assert.equal(r.esito, 'ok', r.errore);
    assert.equal(r.archiviati, 2);
    assert.deepEqual(fs.readdirSync(j.cfg.arrivi), []);
    assert.ok(esiste('Foto/2026/01 Gennaio/2026-01-06_12-00-00_iPhone15Pro.jpg'));
    const t = elenco('_JARVIS/Zip_importati')[0];
    assert.ok(esiste(`_JARVIS/Zip_importati/${t}/amici.zip`));
    assert.ok(esiste(`_JARVIS/Arrivi_avanzi/${elenco('_JARVIS/Arrivi_avanzi')[0]}/appunti.txt`));
  });

  await prova('annulla l\'ultima importazione', async () => {
    const r = await j.annullaUltimaImportazione();
    assert.equal(r.rimessiAlPosto + r.messiDaParte, 2);
    assert.ok(fs.existsSync(path.join(j.cfg.arrivi, 'nuova.jpg')), 'la foto spostata torna in Arrivi');
    assert.ok(!esiste('Foto/2026/01 Gennaio/2026-01-06_12-00-00_iPhone15Pro.jpg'));
    const a = await j.anteprima(j.cfg.arrivi);
    assert.equal(a.nuovi, 1, 'dopo l\'annullamento la foto è di nuovo "nuova"');
    fs.rmSync(path.join(j.cfg.arrivi, 'nuova.jpg'));
  });

  await prova('sentinella: se rispondi NO non importa nulla', async () => {
    const chiavetta = path.join(tmp, 'chiavetta');
    scrivi(chiavetta, 'DCIM/100CANON/IMG_0001.JPG', jpeg({ data: '2026:02:14 18:00:00', marca: 'Canon', modello: 'Canon EOS 250D', seme: 950 }));
    scrivi(chiavetta, 'DCIM/100CANON/IMG_0002.JPG', jpeg({ data: '2026:02:14 18:05:00', marca: 'Canon', modello: 'Canon EOS 250D', seme: 951 }));
    const domande = [];
    const s = new Sentinella(j, { chiedi: async (m) => { domande.push(m); return false; }, info: async () => ({ tipo: 2, nome: 'SD' }) });
    const r = await s.valuta(chiavetta);
    assert.equal(r.azione, 'rifiutata');
    assert.match(domande[0], /2 foto e video/);
    assert.ok(!fs.existsSync(path.join(archivio, 'Foto/2026/02 Febbraio')));
  });

  await prova('sentinella: se rispondi SÌ copia in Arrivi e sistema', async () => {
    const chiavetta = path.join(tmp, 'chiavetta');
    const s = new Sentinella(j, { chiedi: async () => true, info: async () => ({ tipo: 2, nome: 'SD' }) });
    const r = await s.valuta(chiavetta);
    assert.equal(r.azione, 'importazione');
    await attendiFine();
    assert.equal(j.ultimoEsito.esito, 'ok', j.ultimoEsito.errore);
    assert.equal(elenco('Foto/2026/02 Febbraio').length, 2);
    assert.ok(fs.existsSync(path.join(chiavetta, 'DCIM/100CANON/IMG_0001.JPG')), 'gli originali restano sulla scheda');
    assert.deepEqual(fs.readdirSync(j.cfg.arrivi), []);
  });

  await prova('sentinella: ignora dischi senza foto', async () => {
    const vuoto = path.join(tmp, 'disco_vuoto');
    fs.mkdirSync(vuoto);
    const s = new Sentinella(j, { chiedi: async () => { throw new Error('non doveva chiedere'); }, info: async () => ({ tipo: 2 }) });
    assert.equal((await s.valuta(vuoto)).azione, 'ignorata');
  });

  await prova('sentinella: file copiati in Arrivi → chiede e sistema', async () => {
    const domande = [];
    const s = new Sentinella(j, { chiedi: async (m) => { domande.push(m); return true; }, attesaArrivi: 50 });
    assert.equal(await s.controllaArrivi(), null, 'cartella vuota: nessuna domanda');
    scrivi(j.cfg.arrivi, 'telefono/DCIM/IMG_7000.jpg', jpeg({ data: '2026:03:01 08:00:00', seme: 970 }));
    assert.equal(await s.controllaArrivi(), null, 'prima aspetta che la copia sia finita');
    await new Promise((r) => setTimeout(r, 80));
    const r = await s.controllaArrivi();
    assert.equal(r.azione, 'importazione');
    assert.match(domande[0], /Arrivi ci sono 1 nuovi file/);
    await attendiFine();
    assert.ok(esiste('Foto/2026/03 Marzo/2026-03-01_08-00-00_iPhone15Pro.jpg'));
    assert.deepEqual(fs.readdirSync(j.cfg.arrivi), []);
  });

  await prova('sentinella: una sola attiva per volta', async () => {
    const blocco = path.join(tmp, 'sentinella.lock');
    fs.writeFileSync(blocco, String(process.ppid));
    const s = new Sentinella(j, { elencaUnita: async () => [], fileBlocco: blocco });
    assert.equal(await s.avvia(), 'gia-attiva');
    fs.writeFileSync(blocco, '999999');
    assert.equal(await s.avvia(), true, 'un blocco rimasto da un processo chiuso non ferma la sentinella');
    s.ferma();
  });

  await prova('backup zippato per mese (senza la cartella Arrivi)', async () => {
    scrivi(j.cfg.arrivi, 'in_attesa.jpg', jpeg({ seme: 990 }));
    const r = await j.backup({ destinazione: disco });
    assert.equal(r.errori.length, 0);
    assert.ok(fs.existsSync(path.join(disco, 'JARVIS_Backup/2025/JARVIS_Foto_2025-08.zip')));
    assert.ok(fs.existsSync(path.join(disco, 'JARVIS_Backup/JARVIS_Foto_DaScegliere.zip')));
    assert.ok(!fs.readdirSync(path.join(disco, 'JARVIS_Backup')).some((n) => /Altro|Arrivi/.test(n)));
    fs.rmSync(path.join(j.cfg.arrivi, 'in_attesa.jpg'));
  });

  await prova('promemoria: dopo il backup è tutto a posto', async () => {
    assert.equal((await j.promemoriaBackup()).daFare, false);
  });

  await prova('sentinella: il disco del backup aggiornato non disturba', async () => {
    const s = new Sentinella(j, { chiedi: async () => { throw new Error('non doveva chiedere'); } });
    assert.equal((await s.valuta(disco)).azione, 'ignorata');
  });

  await prova('backup incrementale', async () => {
    const r = await j.backup({ destinazione: disco });
    assert.ok(r.aggiornati <= 1, 'riscrive al massimo il registro');
  });

  await prova('verifica profonda', async () => {
    const r = await j.verifica({ destinazione: disco, profonda: true });
    assert.equal(r.esito, 'ok');
    assert.equal(r.danneggiati.length, 0);
  });

  await prova('nome alla giornata (sostituisce il luogo)', async () => {
    await j.rinominaGiornata('2025-08-14', 'Ferragosto');
    assert.ok(esiste(`${MESE_AGOSTO}/2025-08-14 Giovedì - Ferragosto`));
    const r = await j.importa(src);
    assert.equal(r.archiviati, 0, 'l\'indice segue la cartella rinominata');
  });

  await prova('archivio su disco esterno spento: Arrivi sul PC aspetta il disco', async () => {
    const j2 = new Jarvis(caricaConfig({ archivio: path.join(tmp, 'disco_archivio', 'JARVIS_Foto'), arrivi: path.join(tmp, 'pc', 'Arrivi'), effetti: false, voce: false }));
    try {
      scrivi(j2.cfg.arrivi, 'dal_telefono.jpg', jpeg({ data: '2026:03:03 08:00:00', seme: 3030 }));
      j2.archivioDisponibile = () => false; // disco spento
      await assert.rejects(() => j2.importaArrivi(), /spento o scollegato/);
      const avvisi = [];
      let chiesto = 0;
      const s = new Sentinella(j2, { attesaArrivi: 0, avvisa: (m) => avvisi.push(m), chiedi: async () => { chiesto++; return true; } });
      await s.controllaArrivi(); // primo conteggio
      assert.equal((await s.controllaArrivi()).azione, 'attesa-disco');
      await s.controllaArrivi();
      assert.equal(avvisi.length, 1, 'avvisa una volta sola');
      assert.equal(chiesto, 0);
      delete j2.archivioDisponibile; // disco acceso
      assert.equal((await s.controllaArrivi()).azione, 'importazione');
      while (j2.lavoroInCorso) await new Promise((r) => setTimeout(r, 50));
      assert.equal(j2.ultimoEsito.esito, 'ok', j2.ultimoEsito.errore);
      assert.ok(fs.existsSync(path.join(j2.cfg.archivio, 'Foto/2026/03 Marzo/2026-03-03_08-00-00_iPhone15Pro.jpg')));
      assert.deepEqual(fs.readdirSync(j2.cfg.arrivi), []);
    } finally {
      j2.regista.chiudi();
    }
  });

  await prova('anteprima dei RAW: trova il JPEG più grande dentro il file', async () => {
    const piccola = jpeg({ seme: 4001, scala: 0.3 });
    const grande = jpeg({ data: '2025:05:03 10:50:56', seme: 4002 }); // contiene a sua volta metadati EXIF
    const raw = Buffer.concat([Buffer.from('MM\0*\0\0\0\x08finto-raw'), Buffer.alloc(500, 7), piccola, Buffer.alloc(300, 1), grande, Buffer.alloc(200, 9)]);
    const file = scrivi(tmp, 'finto/DSC_0001.NEF', raw);
    const trovati = jpegIncorporati(raw);
    assert.equal(trovati.length, 2);
    const a = await anteprimaRaw(file, 100);
    assert.ok(a && a.equals(grande));
    // foto verticale: l'anteprima riceve l'orientamento e il lettore EXIF lo ritrova
    const ruotata = conOrientamento(a, 6);
    assert.equal(await exifr.orientation(ruotata), 6);
    assert.equal(jpegIncorporati(ruotata).length, 1, 'resta un JPEG valido');
    assert.equal(conOrientamento(a, 1), a);
  });

  await prova('galleria: anni, mesi, giornate e protezione dei percorsi', async () => {
    const url = await j.regista.avvia();
    const indice = await (await fetch(`${url}api/galleria`)).json();
    assert.ok(indice.totali.Foto > 20);
    const agosto = indice.sezioni.Foto.find((a) => a.anno === '2025').album.find((al) => al.titolo === 'Agosto');
    assert.ok(agosto && agosto.n >= 14);
    const album = await (await fetch(`${url}api/galleria/album?c=${encodeURIComponent(agosto.chiave)}`)).json();
    const speciale = album.gruppi.find((g) => g.speciale);
    assert.match(speciale.titolo, /Ferragosto/);
    const r = await fetch(`${url}api/galleria/foto?p=${encodeURIComponent(speciale.voci[0].p)}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(`${url}api/galleria/foto?p=${encodeURIComponent('../../segreto.txt')}`)).status, 404);
    assert.equal((await fetch(`${url}api/galleria/mostra?p=x`, { method: 'POST' })).status, 404, 'senza intestazione speciale non risponde');
    assert.match(await (await fetch(`${url}galleria`)).text(), /GALLERIA/);
  });

  await prova('accadde oggi: foto dello stesso giorno negli anni passati, avviso una volta al giorno', async () => {
    j.galleria.invalida();
    const r = await j.galleria.ricordi(new Date(2026, 7, 14, 10, 0));
    assert.equal(r.gruppi[0].anno, 2025);
    assert.equal(r.gruppi[0].fa, 1);
    assert.ok(r.totale >= 14);
    const avvisi = [];
    const s = new Sentinella(j, { attesaPromemoria: 0, avvisa: (m, azione) => avvisi.push([m, azione]) });
    const esito = await s.controllaRicordi(new Date(2026, 7, 14, 10, 0));
    assert.ok(esito.totale >= 14);
    assert.match(avvisi[0][0], /Accadde oggi/);
    assert.equal(avvisi[0][1], 'galleria-oggi');
    s.ultimoControlloRicordi = 0;
    assert.equal(await s.controllaRicordi(new Date(2026, 7, 14, 11, 0)), null, 'non ripete nello stesso giorno');
    assert.equal(await s.controllaRicordi(new Date(2026, 7, 15, 7, 0)), null, 'di notte non disturba');
    fs.rmSync(path.join(archivio, '_JARVIS', 'ricordi_avvisati.txt'), { force: true });
  });

  await prova('video ricordo: salvato nella cartella Ricordi e visibile in galleria', async () => {
    const url = await j.regista.avvia();
    const finto = Buffer.from('finto video webm');
    assert.equal((await fetch(`${url}api/galleria/ricordo?nome=x`, { method: 'POST', body: finto })).status, 404, 'senza intestazione speciale non salva');
    const r = await (await fetch(`${url}api/galleria/ricordo?nome=${encodeURIComponent('Ferragosto: a Ponza!')}`,
      { method: 'POST', headers: { 'x-jarvis': '1', 'content-type': 'video/webm' }, body: finto })).json();
    assert.match(r.rel, /^Ricordi\/\d{4}-\d{2}-\d{2} Ferragosto a Ponza!\.webm$/);
    assert.deepEqual(fs.readFileSync(path.join(archivio, r.rel)), finto);
    const indice = await (await fetch(`${url}api/galleria`)).json();
    assert.equal(indice.totali.Ricordi, 1);
    fs.rmSync(path.join(archivio, 'Ricordi'), { recursive: true, force: true });
    j.galleria.invalida();
  });

  await prova('stato e diagnostica', async () => {
    const s = await j.stato();
    assert.ok(s.totali.foto > 20 && s.totali.daScegliere === 1);
    const d = await j.diagnostica();
    assert.equal(d.controlli.scritturaArchivio, 'ok');
  });

  console.log(`\n  ${ok} prove superate.`);
} finally {
  j.regista.chiudi();
  fs.rmSync(tmp, { recursive: true, force: true });
}
