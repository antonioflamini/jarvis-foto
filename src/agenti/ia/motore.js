// AGENTE IA: ricerca delle foto con le parole ("tramonto al mare", "torta di compleanno"), in italiano e altre lingue.
// Usa il modello UForm multilingue (licenza Apache 2.0) che gira sul computer: nessuna foto lascia mai il PC.
// I modelli (~210 MB) si scaricano una volta sola in %LOCALAPPDATA%\JARVIS-Foto-IA, fuori dalla cartella
// del programma, così gli aggiornamenti non li cancellano.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Tokenizzatore } from './tokenizzatore.js';
import { anteprimaRaw } from '../galleria.js';
import { miniaturaEXIF } from '../simili.js';

export const VERSIONE_MODELLO = 'uform-vl-multilingual-v1';
const UFORM = 'https://huggingface.co/Xenova/uform-vl-multilingual/resolve/ceae6f2d0602aa870e87727a7e894366d84a9e95';
const MINILM = 'https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/resolve/e8f8c211226b894fcb81acc59f3b34ba3efd5f42';
// Ogni file scaricato viene controllato con la sua impronta SHA-256: se non corrisponde, non viene usato.
export const FILE_MODELLO = [
  { nome: 'vision_model_quantized.onnx', url: `${UFORM}/onnx/vision_model_quantized.onnx`, sha256: 'a0698645bc7ebd966d52cb454f3904d26b599ec7999ad7299e9d5eb887d4440a', byte: 87581209 },
  { nome: 'text_model_quantized.onnx', url: `${UFORM}/onnx/text_model_quantized.onnx`, sha256: 'b1d872215c9286370009e52cdcc81f6536b2bf2fbd1a77f6cad49696305f6053', byte: 110775276 },
  // il tokenizer giusto è quello multilingue del modello di partenza (quello allegato a UForm è inglese)
  { nome: 'tokenizer.json', url: `${MINILM}/tokenizer.json`, sha256: '2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8', byte: 9081518 },
];
const MEDIA = [0.48145466, 0.4578275, 0.40821073];
const DEVIAZIONE = [0.26862954, 0.26130258, 0.27577711];
const LATO = 224;
const RAW = /\.(nef|nrw|cr2|cr3|arw|srw|raf|orf|rw2|pef|dng)$/i;

export function cartellaModelli() {
  return process.env.JARVIS_IA_MODELLI || path.join(process.env.LOCALAPPDATA || os.homedir(), 'JARVIS-Foto-IA');
}

function normalizza(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return Float32Array.from(v, (x) => x / s);
}

export class MotoreIA {
  /** @param {import('../../jarvis.js').Jarvis} jarvis */
  constructor(jarvis, opz = {}) {
    this.jarvis = jarvis;
    this.dir = opz.cartella || cartellaModelli();
    this.sessioni = null;
    this.impronte = null; // Map rel → Float32Array(256)
    this.stato = { indicizzate: 0, totali: 0, inCorso: false, errore: null };
    this.fermati = false;
    this.calcola = opz.calcola || null; // sostituibile nei collaudi
  }

  get fileImpronte() { return path.join(this.jarvis.cfg.archivio, '_JARVIS', 'ia', 'impronte.json'); }

  modelliPresenti() {
    return FILE_MODELLO.every((f) => { try { return fs.statSync(path.join(this.dir, f.nome)).size === f.byte; } catch { return false; } });
  }

  /** Scarica i modelli (una volta sola), con verifica SHA-256. */
  async scarica(suProgresso = () => {}) {
    await fsp.mkdir(this.dir, { recursive: true });
    const totale = FILE_MODELLO.reduce((t, f) => t + f.byte, 0);
    let fatti = 0;
    for (const f of FILE_MODELLO) {
      const dest = path.join(this.dir, f.nome);
      if (fs.existsSync(dest) && fs.statSync(dest).size === f.byte) { fatti += f.byte; continue; }
      const r = await fetch(f.url, { headers: { 'user-agent': 'JARVIS-Foto' } });
      if (!r.ok || !r.body) throw new Error(`Scaricamento di ${f.nome} non riuscito (${r.status}).`);
      const tmp = `${dest}.parziale`;
      const out = fs.createWriteStream(tmp);
      const hash = crypto.createHash('sha256');
      for await (const pezzo of r.body) {
        hash.update(pezzo);
        if (!out.write(pezzo)) await new Promise((ok) => out.once('drain', ok));
        fatti += pezzo.length;
        suProgresso(fatti / totale, fatti, totale);
      }
      await new Promise((ok, ko) => out.end((e) => (e ? ko(e) : ok())));
      if (hash.digest('hex') !== f.sha256) {
        await fsp.rm(tmp, { force: true });
        throw new Error(`Il file ${f.nome} scaricato non è integro: riprova più tardi.`);
      }
      await fsp.rename(tmp, dest);
    }
    return { cartella: this.dir, byte: totale };
  }

  async #carica() {
    if (this.sessioni) return this.sessioni;
    if (!this.modelliPresenti()) throw new Error('La ricerca intelligente non è ancora attiva: scarica i modelli (menu dell\'icona, "Attiva la ricerca intelligente").');
    let ort;
    let sharp;
    try {
      ort = (await import('onnxruntime-node')).default;
      sharp = (await import('sharp')).default;
    } catch {
      throw new Error('Mancano i componenti per l\'intelligenza artificiale: aggiorna JARVIS (menu Start → Aggiorna JARVIS).');
    }
    const opz = { intraOpNumThreads: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))), executionMode: 'sequential' };
    this.sessioni = {
      ort, sharp,
      vista: await ort.InferenceSession.create(path.join(this.dir, 'vision_model_quantized.onnx'), opz),
      testo: await ort.InferenceSession.create(path.join(this.dir, 'text_model_quantized.onnx'), opz),
      tok: new Tokenizzatore(path.join(this.dir, 'tokenizer.json')),
    };
    return this.sessioni;
  }

  async #pixel(abs) {
    const { sharp } = this.sessioni;
    let sorgente = abs;
    if (RAW.test(abs)) sorgente = (await anteprimaRaw(abs, 8000, true)) || (await miniaturaEXIF(abs)) || abs;
    let dati;
    try {
      dati = await sharp(sorgente, { failOn: 'none' }).rotate().resize(LATO, LATO, { fit: 'cover', kernel: 'cubic' }).removeAlpha().raw().toBuffer();
    } catch {
      const t = await miniaturaEXIF(abs); // HEIC e formati che il lettore non conosce: uso la miniatura interna
      if (!t) throw new Error('immagine non leggibile');
      dati = await sharp(t).rotate().resize(LATO, LATO, { fit: 'cover' }).removeAlpha().raw().toBuffer();
    }
    const n = LATO * LATO;
    const t = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) t[c * n + i] = (dati[i * 3 + c] / 255 - MEDIA[c]) / DEVIAZIONE[c];
    return t;
  }

  /** Impronta (256 numeri) di una foto. */
  async improntaFoto(abs) {
    if (this.calcola) return normalizza(await this.calcola('foto', abs));
    const { ort, vista } = await this.#carica();
    const o = await vista.run({ x: new ort.Tensor('float32', await this.#pixel(abs), [1, 3, LATO, LATO]) });
    return normalizza(o[vista.outputNames.find((k) => o[k].dims.length === 2)].data);
  }

  /** Impronta di una frase. */
  async improntaTesto(frase) {
    if (this.calcola) return normalizza(await this.calcola('testo', frase));
    const { ort, testo, tok } = await this.#carica();
    const { ids, maschera } = tok.codifica(frase, 77);
    const o = await testo.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, 77]),
      attention_mask: new ort.Tensor('int32', Int32Array.from(maschera), [1, 77]),
    });
    return normalizza(o[testo.outputNames.find((k) => o[k].dims.length === 2)].data);
  }

  async #caricaImpronte() {
    if (this.impronte) return this.impronte;
    this.impronte = new Map();
    try {
      const d = JSON.parse(await fsp.readFile(this.fileImpronte, 'utf8'));
      if (d.modello === VERSIONE_MODELLO) {
        for (const [rel, b64] of Object.entries(d.voci)) {
          const b = Buffer.from(b64, 'base64');
          this.impronte.set(rel, new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice());
        }
      }
    } catch { /* prima volta */ }
    return this.impronte;
  }

  async #salvaImpronte() {
    const voci = {};
    for (const [rel, v] of this.impronte) voci[rel] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
    await fsp.mkdir(path.dirname(this.fileImpronte), { recursive: true });
    const tmp = `${this.fileImpronte}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ modello: VERSIONE_MODELLO, voci }));
    await fsp.rename(tmp, this.fileImpronte);
  }

  /**
   * Legge le foto dell'archivio non ancora "guardate". Si mette in pausa se JARVIS sta lavorando
   * o se il disco viene spento, e lascia respirare il computer tra una foto e l'altra.
   */
  async indicizza({ pausa = 120, suProgresso = () => {} } = {}) {
    if (this.stato.inCorso) return this.stato;
    this.stato.inCorso = true;
    this.stato.errore = null;
    this.fermati = false;
    try {
      if (!this.calcola) await this.#carica();
      const impronte = await this.#caricaImpronte();
      const tutte = (await this.jarvis.galleria.tutti()).filter((v) => v.tipo === 'foto');
      const presenti = new Set(tutte.map((v) => v.p));
      for (const rel of [...impronte.keys()]) if (!presenti.has(rel)) impronte.delete(rel); // foto spostate o tolte
      const daFare = tutte.filter((v) => !impronte.has(v.p));
      this.stato.totali = tutte.length;
      this.stato.indicizzate = tutte.length - daFare.length;
      let nonSalvate = 0;
      for (const v of daFare) {
        if (this.fermati || !this.jarvis.archivioDisponibile()) break;
        while (this.jarvis.lavoroInCorso && !this.fermati) await new Promise((r) => setTimeout(r, 5000));
        try {
          impronte.set(v.p, await this.improntaFoto(path.join(this.jarvis.cfg.archivio, v.p)));
        } catch {
          impronte.set(v.p, new Float32Array(256)); // illeggibile: non riprovo a ogni giro
        }
        this.stato.indicizzate++;
        suProgresso(this.stato);
        if (++nonSalvate >= 100) { await this.#salvaImpronte(); nonSalvate = 0; }
        if (pausa) await new Promise((r) => setTimeout(r, pausa));
      }
      await this.#salvaImpronte();
    } catch (e) {
      this.stato.errore = e.message;
    } finally {
      this.stato.inCorso = false;
    }
    return this.stato;
  }

  ferma() { this.fermati = true; }

  /** Cerca le foto più vicine alla frase. */
  async cerca(frase, max = 240) {
    const impronte = await this.#caricaImpronte();
    if (!impronte.size) throw new Error('JARVIS non ha ancora guardato le foto: la prima lettura dell\'archivio è in corso, riprova tra poco.');
    const q = await this.improntaTesto(frase);
    const r = [];
    for (const [p, v] of impronte) {
      let s = 0;
      for (let i = 0; i < v.length; i++) s += v[i] * q[i];
      if (s !== 0) r.push({ p, s });
    }
    r.sort((a, b) => b.s - a.s);
    // tengo le più somiglianti: entro un margine dalla migliore, come fa una ricerca "a colpo d'occhio"
    const soglia = (r[0]?.s ?? 0) - 0.07;
    return { frase, risultati: r.filter((x, i) => i < max && x.s >= soglia), guardate: impronte.size, totali: this.stato.totali || impronte.size };
  }
}
