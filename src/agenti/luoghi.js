// LUOGHI: trova il nome del posto dalle coordinate GPS di una foto, senza internet.
// - Italia: i 7.894 comuni ISTAT con il nome italiano (dati: pacchetto italian-cap-comuni-province, MIT).
// - Resto del mondo: località con più di 1000 abitanti (GeoNames via all-the-cities, MIT / CC BY 4.0),
//   preferendo la città più grande vicina, così il centro di una città non diventa un suo quartiere.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dati');
const tabelle = {};

function carica(nome) {
  if (tabelle[nome]) return tabelle[nome];
  const righe = zlib.gunzipSync(fs.readFileSync(path.join(DIR, nome))).toString('utf8').split('\n');
  const t = { lat: new Float32Array(righe.length), lon: new Float32Array(righe.length), nome: new Array(righe.length), pop: new Uint32Array(righe.length) };
  righe.forEach((r, i) => {
    const c = r.split('\t');
    t.lat[i] = +c[0]; t.lon[i] = +c[1]; t.nome[i] = c[2]; t.pop[i] = +(c[4] || 0);
  });
  tabelle[nome] = t;
  return t;
}

function distanzaKm(a1, o1, a2, o2) {
  const r = Math.PI / 180;
  const x = Math.sin(((a2 - a1) * r) / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(((o2 - o1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

function vicini(t, la, lo, maxKm) {
  const dLat = maxKm / 111;
  const dLon = dLat / Math.max(0.15, Math.cos((la * Math.PI) / 180));
  let a = 0, b = t.lat.length;
  while (a < b) { const m = (a + b) >> 1; if (t.lat[m] < la - dLat) a = m + 1; else b = m; }
  const out = [];
  for (let i = a; i < t.lat.length && t.lat[i] <= la + dLat; i++) {
    if (Math.abs(t.lon[i] - lo) > dLon) continue;
    const d = distanzaKm(la, lo, t.lat[i], t.lon[i]);
    if (d <= maxKm) out.push({ i, d });
  }
  return out;
}

/** Nome del luogo più adatto per le coordinate, oppure null. */
export function luogoVicino(latitudine, longitudine) {
  if (!Number.isFinite(latitudine) || !Number.isFinite(longitudine) || (latitudine === 0 && longitudine === 0)) return null;
  // Italia: comune col centro più vicino
  const it = carica('comuni_it.tsv.gz');
  const ci = vicini(it, latitudine, longitudine, 12).sort((x, y) => x.d - y.d)[0];
  if (ci) return it.nome[ci.i];
  // Resto del mondo: la città più popolosa entro 8 km, altrimenti la più vicina entro 25 km
  const mo = carica('citta_mondo.tsv.gz');
  const cand = vicini(mo, latitudine, longitudine, 25);
  if (!cand.length) return null;
  const grandi = cand.filter((c) => c.d <= 8).sort((x, y) => mo.pop[y.i] - mo.pop[x.i]);
  return mo.nome[(grandi[0] || cand.sort((x, y) => x.d - y.d)[0]).i];
}

/** Il luogo più frequente in un gruppo di foto (serve almeno un terzo delle foto con GPS). */
export function luogoPrevalente(voci) {
  const conta = new Map();
  let conGps = 0;
  for (const v of voci) {
    const l = v.luogo ?? (v.gps ? luogoVicino(v.gps.lat, v.gps.lon) : null);
    if (!l) continue;
    conGps++;
    conta.set(l, (conta.get(l) || 0) + 1);
  }
  if (!conGps || conGps < voci.length / 3) return null;
  return [...conta].sort((a, b) => b[1] - a[1])[0][0];
}
