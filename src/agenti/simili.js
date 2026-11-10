// SIMILI: impronta visiva (dHash a 64 bit) per riconoscere foto quasi uguali:
// copie ridotte (WhatsApp), raffiche di scatti, foto ricompresse.
// Usa la miniatura già salvata dentro la foto (veloce); se manca, decodifica i JPEG piccoli.
import fsp from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';
import jpeg from 'jpeg-js';

const MAX_DECODIFICA = 6 * 1024 * 1024;

/** Estrae la miniatura salvata nella foto. Per i JPEG legge solo l'inizio del file (veloce, nessun file lasciato aperto). */
export async function miniaturaEXIF(percorso) {
  try {
    const ext = path.extname(percorso).toLowerCase();
    if (['.jpg', '.jpeg', '.jpe'].includes(ext)) {
      const fh = await fsp.open(percorso, 'r');
      let buf;
      try {
        buf = Buffer.alloc(196608);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        buf = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      const t = await exifr.thumbnail(buf).catch(() => null);
      return t?.length ? Buffer.from(t) : null;
    }
    if (['.heic', '.heif', '.tif', '.tiff', '.dng', '.cr2', '.nef', '.arw'].includes(ext)) {
      const t = await exifr.thumbnail(await fsp.readFile(percorso)).catch(() => null);
      return t?.length ? Buffer.from(t) : null;
    }
  } catch { /* nessuna miniatura */ }
  return null;
}

function luminanza(img) {
  const { width: w, height: h, data } = img;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  return { w, h, g };
}

// Le miniature EXIF delle foto 16:9 hanno bande nere: le tolgo per confrontare solo l'immagine vera.
function ritaglioBande({ w, h, g }) {
  const vuotaRiga = (y) => { let s = 0, m = 0; for (let x = 0; x < w; x++) { const v = g[y * w + x]; s += v; m = Math.max(m, v); } return s / w < 10 && m < 30; };
  const vuotaCol = (x, y0, y1) => { let s = 0, m = 0; for (let y = y0; y < y1; y++) { const v = g[y * w + x]; s += v; m = Math.max(m, v); } return s / (y1 - y0) < 10 && m < 30; };
  let y0 = 0, y1 = h, x0 = 0, x1 = w;
  while (y0 < h / 3 && vuotaRiga(y0)) y0++;
  while (y1 > (2 * h) / 3 && vuotaRiga(y1 - 1)) y1--;
  while (x0 < w / 3 && vuotaCol(x0, y0, y1)) x0++;
  while (x1 > (2 * w) / 3 && vuotaCol(x1 - 1, y0, y1)) x1--;
  return { x0, y0, x1, y1 };
}

function dhash(img) {
  const l = luminanza(img);
  const { x0, y0, x1, y1 } = ritaglioBande(l);
  const cw = (x1 - x0) / 9;
  const ch = (y1 - y0) / 8;
  const celle = new Float32Array(72);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 9; c++) {
      let s = 0, n = 0;
      const ya = Math.floor(y0 + r * ch), yb = Math.max(ya + 1, Math.floor(y0 + (r + 1) * ch));
      const xa = Math.floor(x0 + c * cw), xb = Math.max(xa + 1, Math.floor(x0 + (c + 1) * cw));
      for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { s += l.g[y * l.w + x]; n++; }
      celle[r * 9 + c] = s / n;
    }
  }
  let alto = 0, basso = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const bit = celle[r * 9 + c] > celle[r * 9 + c + 1] ? 1 : 0;
      const k = r * 8 + c;
      if (k < 32) alto = (alto << 1) | bit; else basso = (basso << 1) | bit;
    }
  }
  return (alto >>> 0).toString(16).padStart(8, '0') + (basso >>> 0).toString(16).padStart(8, '0');
}

/** Impronta visiva di una foto (stringa esadecimale di 16 caratteri) oppure null se non calcolabile. */
export async function improntaVisiva(percorso, dimensione) {
  try {
    const anteprima = await miniaturaEXIF(percorso);
    if (anteprima) return dhash(jpeg.decode(anteprima, { useTArray: true, maxMemoryUsageInMB: 64 }));
    const ext = path.extname(percorso).toLowerCase();
    if (['.jpg', '.jpeg', '.jpe'].includes(ext) && dimensione <= MAX_DECODIFICA) {
      return dhash(jpeg.decode(await fsp.readFile(percorso), { useTArray: true, maxMemoryUsageInMB: 768, tolerantDecoding: true }));
    }
  } catch { /* immagine non decodificabile */ }
  return null;
}

function bitAccesi(n) {
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function distanza(a, b) {
  return bitAccesi((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) +
    bitAccesi((parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0);
}

// Soglie: quanto devono somigliarsi (bit diversi su 64) ed entro quanto tempo sono state scattate.
export const SOGLIA_BIT = 5;
export const FINESTRA_MS = 2 * 86400000;
