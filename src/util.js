// Utilità comuni a tutti gli agenti.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

export const MESI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
export const GIORNI = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];

export const DUE = (n) => String(n).padStart(2, '0');

export function cartellaMese(d) {
  return `${DUE(d.getMonth() + 1)} ${MESI[d.getMonth()]}`;
}

export function giornoISO(d) {
  return `${d.getFullYear()}-${DUE(d.getMonth() + 1)}-${DUE(d.getDate())}`;
}

export function timbro(d) {
  return `${giornoISO(d)}_${DUE(d.getHours())}-${DUE(d.getMinutes())}-${DUE(d.getSeconds())}`;
}

export function numero(n) {
  return Number(n).toLocaleString('it-IT');
}

export function byteLeggibili(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0).replace('.', ',')} ${u[i]}`;
}

export async function impronta(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file, { highWaterMark: 1 << 20 }), h);
  return h.digest('hex');
}

export async function esiste(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// Scrittura sicura: prima su file temporaneo, poi rinomina (niente file a metà se si spegne il PC).
export async function scriviJSON(file, dati) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(dati, null, 1), 'utf8');
  await fsp.rename(tmp, file);
}

export async function leggiJSON(file, predefinito) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return predefinito;
  }
}

// Esegue fino a `limite` lavori in parallelo mantenendo l'ordine dei risultati.
export async function inParallelo(elementi, limite, lavoro) {
  const risultati = new Array(elementi.length);
  let prossimo = 0;
  async function operaio() {
    while (prossimo < elementi.length) {
      const i = prossimo++;
      risultati[i] = await lavoro(elementi[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, elementi.length) }, operaio));
  return risultati;
}

export function nomeSicuro(s, max = 60) {
  return String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, max);
}

export function ora() {
  const d = new Date();
  return `${giornoISO(d)}_${DUE(d.getHours())}${DUE(d.getMinutes())}${DUE(d.getSeconds())}`;
}

export function saluto(nome) {
  const h = new Date().getHours();
  const s = h < 13 ? 'Buongiorno' : h < 18 ? 'Buon pomeriggio' : 'Buonasera';
  return nome ? `${s} ${nome}` : s;
}
