// AGENTE IA: ricerca delle foto con le parole ("tramonto al mare", "torta di compleanno"), in italiano e altre lingue,
// e riconoscimento dei volti (gruppi di persone a cui dai un nome). Tutto gira sul computer: nessuna foto lascia il PC.
// Modelli: UForm multilingue (Apache 2.0), YuNet (MIT) e SFace (Apache 2.0) di OpenCV.
// Si scaricano una volta sola (~250 MB) in %LOCALAPPDATA%\JARVIS-Foto-IA, fuori dalla cartella del programma,
// così gli aggiornamenti non li cancellano.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Tokenizzatore } from './tokenizzatore.js';
import { ingressoRilevatore, decodificaVolti, voltoAllineato, normalizza as normalizzaVolto, raggruppa } from './volti.js';
import { anteprimaRaw } from '../galleria.js';
import { miniaturaEXIF } from '../simili.js';
import { RADICE_PROGETTO } from '../../config.js';

export const VERSIONE_MODELLO = 'uform-vl-multilingual-v1';
export const VERSIONE_VOLTI = 'yunet-sface-1';
const UFORM = 'https://huggingface.co/Xenova/uform-vl-multilingual/resolve/ceae6f2d0602aa870e87727a7e894366d84a9e95';
const MINILM = 'https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/resolve/e8f8c211226b894fcb81acc59f3b34ba3efd5f42';
const ZOO = 'https://github.com/opencv/opencv_zoo/raw';
// Ogni file scaricato viene controllato con la sua impronta SHA-256: se non corrisponde, non viene usato.
export const FILE_MODELLO = [
  { nome: 'vision_model_quantized.onnx', url: `${UFORM}/onnx/vision_model_quantized.onnx`, sha256: 'a0698645bc7ebd966d52cb454f3904d26b599ec7999ad7299e9d5eb887d4440a', byte: 87581209 },
  { nome: 'text_model_quantized.onnx', url: `${UFORM}/onnx/text_model_quantized.onnx`, sha256: 'b1d872215c9286370009e52cdcc81f6536b2bf2fbd1a77f6cad49696305f6053', byte: 110775276 },
  // il tokenizer giusto è quello multilingue del modello di partenza (quello allegato a UForm è inglese)
  { nome: 'tokenizer.json', url: `${MINILM}/tokenizer.json`, sha256: '2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8', byte: 9081518 },
  { nome: 'yunet.onnx', url: `${ZOO}/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx`, sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4', byte: 232589 },
  { nome: 'sface.onnx', url: `${ZOO}/ba91a3b91d00d76e86540d4013f944bd6b514e39/models/face_recognition_sface/face_recognition_sface_2021dec.onnx`, sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79', byte: 38696353 },
];
const MEDIA = [0.48145466, 0.4578275, 0.40821073];
const DEVIAZIONE = [0.26862954, 0.26130258, 0.27577711];
const LATO = 224;
const LATO_LAVORO = 1280;
const SOGLIA_GRUPPO = 0.52; // prudente: meglio due gruppi della stessa persona (si uniscono dando lo stesso nome) che due persone mischiate
const RAW = /\.(nef|nrw|cr2|cr3|arw|srw|raf|orf|rw2|pef|dng)$/i;

const presentiIn = (dir) => FILE_MODELLO.every((f) => {
  try { return fs.statSync(path.join(dir, f.nome)).size === f.byte; } catch { return false; }
});

export function cartellaModelli() {
  if (process.env.JARVIS_IA_MODELLI) return process.env.JARVIS_IA_MODELLI;
  // Più posti possibili: se JARVIS parte con un ambiente diverso (es. dopo un aggiornamento) li ritrova lo stesso.
  const candidati = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'JARVIS-Foto-IA'),
    path.join(RADICE_PROGETTO, '..', 'JARVIS-Foto-IA'), // accanto alla cartella del programma
    path.join(os.homedir(), 'AppData', 'Local', 'JARVIS-Foto-IA'),
  ].filter(Boolean).map((c) => path.resolve(c));
  return candidati.find(presentiIn) || candidati[0];
}

function normalizza(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return Float32Array.from(v, (x) => x / s);
}
const b64 = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
const daB64 = (s) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice(); };
const relDi = (idVolto) => idVolto.slice(0, idVolto.lastIndexOf('#'));
const numDi = (idVolto) => Number(idVolto.slice(idVolto.lastIndexOf('#') + 1));

export class MotoreIA {
  /** @param {import('../../jarvis.js').Jarvis} jarvis */
  constructor(jarvis, opz = {}) {
    this.jarvis = jarvis;
    this.dir = opz.cartella || cartellaModelli();
    this.cartellaFissa = Boolean(opz.cartella);
    this.sessioni = null;
    this.impronte = null; // Map rel → Float32Array(256)
    this.volti = null; // Map rel → [{b:[x,y,w,h] in 0-1, e:Float32Array(128)}]
    this.persone = null; // { gruppi: [{id, nome, centro, n}], assegnati: Map 'rel#i' → id gruppo }
    this.stato = { indicizzate: 0, totali: 0, inCorso: false, errore: null };
    this.fermati = false;
    this.calcola = opz.calcola || null; // sostituibile nei collaudi
  }

  #file(nome) { return path.join(this.jarvis.cfg.archivio, '_JARVIS', 'ia', nome); }
  get fileImpronte() { return this.#file('impronte.json'); }
  get fileVolti() { return this.#file('volti.json'); }
  get filePersone() { return this.#file('persone.json'); }

  modelliPresenti() {
    if (!this.cartellaFissa && !presentiIn(this.dir)) this.dir = cartellaModelli(); // ricontrollo i posti possibili
    return presentiIn(this.dir);
  }

  /** Scarica i modelli che mancano (una volta sola), con verifica SHA-256. */
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
    const opz = { intraOpNumThreads: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))), executionMode: 'sequential', logSeverityLevel: 3 };
    const sessione = (nome) => ort.InferenceSession.create(path.join(this.dir, nome), opz);
    this.sessioni = {
      ort, sharp,
      vista: await sessione('vision_model_quantized.onnx'),
      testo: await sessione('text_model_quantized.onnx'),
      tok: new Tokenizzatore(path.join(this.dir, 'tokenizer.json')),
      rilevatore: await sessione('yunet.onnx'),
      riconoscitore: await sessione('sface.onnx'),
    };
    return this.sessioni;
  }

  // La foto ridotta a 1280 pixel (lato lungo), già ruotata, in RGB.
  async #grande(abs) {
    const { sharp } = this.sessioni;
    let sorgente = abs;
    if (RAW.test(abs)) sorgente = (await anteprimaRaw(abs, 8000)) || (await miniaturaEXIF(abs)) || abs;
    try {
      return await sharp(sorgente, { failOn: 'none' }).rotate().resize(LATO_LAVORO, LATO_LAVORO, { fit: 'inside', withoutEnlargement: true })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    } catch {
      const t = await miniaturaEXIF(abs); // HEIC e formati che il lettore non conosce: uso la miniatura interna
      if (!t) throw new Error('immagine non leggibile');
      return sharp(t).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    }
  }

  /** Legge la foto una volta sola e calcola l'impronta per la ricerca e i volti. */
  async analizza(abs) {
    if (this.calcola) return { clip: normalizza(await this.calcola('foto', abs)), volti: (await this.calcola('volti', abs)) || [] };
    const { ort, sharp, vista, rilevatore, riconoscitore } = await this.#carica();
    const { data, info } = await this.#grande(abs);
    const W = info.width, H = info.height;
    const crudo = { raw: { width: W, height: H, channels: 3 } };
    // impronta per la ricerca
    const p224 = await sharp(data, crudo).resize(LATO, LATO, { fit: 'cover', kernel: 'cubic' }).raw().toBuffer();
    const n = LATO * LATO;
    const t = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) t[c * n + i] = (p224[i * 3 + c] / 255 - MEDIA[c]) / DEVIAZIONE[c];
    const ov = await vista.run({ x: new ort.Tensor('float32', t, [1, 3, LATO, LATO]) });
    const clip = normalizza(ov[vista.outputNames.find((k) => ov[k].dims.length === 2)].data);
    // volti
    const k = 640 / Math.max(W, H);
    const p640 = await sharp(data, crudo).resize(Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k)), { fit: 'fill' })
      .raw().toBuffer({ resolveWithObject: true });
    const or = await rilevatore.run({ input: new ort.Tensor('float32', ingressoRilevatore(p640.data, p640.info.width, p640.info.height), [1, 3, 640, 640]) });
    const volti = [];
    for (const v of decodificaVolti(or).slice(0, 30)) {
      if (v.w / k < 36 || v.h / k < 36) continue; // volti troppo piccoli: impronta poco affidabile
      const punti = v.punti.map(([x, y]) => [x / k, y / k]);
      const oe = await riconoscitore.run({ data: new ort.Tensor('float32', voltoAllineato(data, W, H, punti), [1, 3, 112, 112]) });
      const b = [v.x / k / W, v.y / k / H, v.w / k / W, v.h / k / H].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 10000) / 10000);
      volti.push({ b, e: normalizzaVolto(oe.fc1.data) });
    }
    return { clip, volti };
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

  // ---------- memoria su disco (_JARVIS/ia) ----------

  async #leggi(file, versione) {
    try {
      const d = JSON.parse(await fsp.readFile(file, 'utf8'));
      return d.modello === versione ? d : null;
    } catch { return null; }
  }

  async #scrivi(file, oggetto) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(`${file}.tmp`, JSON.stringify(oggetto));
    await fsp.rename(`${file}.tmp`, file);
  }

  async #caricaImpronte() {
    if (this.impronte) return this.impronte;
    this.impronte = new Map();
    const d = await this.#leggi(this.fileImpronte, VERSIONE_MODELLO);
    if (d) for (const [rel, s] of Object.entries(d.voci)) this.impronte.set(rel, daB64(s));
    return this.impronte;
  }

  async #caricaVolti() {
    if (this.volti) return this.volti;
    this.volti = new Map();
    const d = await this.#leggi(this.fileVolti, VERSIONE_VOLTI);
    if (d) for (const [rel, elenco] of Object.entries(d.foto)) this.volti.set(rel, elenco.map((v) => ({ b: v.b, e: daB64(v.e) })));
    return this.volti;
  }

  async #caricaPersone() {
    if (this.persone) return this.persone;
    this.persone = { gruppi: [], assegnati: new Map() };
    const d = await this.#leggi(this.filePersone, VERSIONE_VOLTI);
    if (d) {
      this.persone.gruppi = d.gruppi.map((g) => ({ ...g, centro: daB64(g.centro) }));
      this.persone.assegnati = new Map(Object.entries(d.assegnati));
    }
    return this.persone;
  }

  async #salva() {
    const voci = {};
    for (const [rel, v] of this.impronte || []) voci[rel] = b64(v);
    if (this.impronte) await this.#scrivi(this.fileImpronte, { modello: VERSIONE_MODELLO, voci });
    if (this.volti) {
      const foto = {};
      for (const [rel, elenco] of this.volti) foto[rel] = elenco.map((v) => ({ b: v.b, e: b64(v.e) }));
      await this.#scrivi(this.fileVolti, { modello: VERSIONE_VOLTI, foto });
    }
    if (this.persone) {
      const p = this.persone;
      await this.#scrivi(this.filePersone, {
        modello: VERSIONE_VOLTI,
        gruppi: p.gruppi.map((g) => ({ id: g.id, nome: g.nome || '', n: g.n, centro: b64(g.centro) })),
        assegnati: Object.fromEntries(p.assegnati),
      });
    }
  }

  // Mette nei gruppi i volti nuovi e toglie quelli delle foto che non ci sono più.
  async #aggiornaPersone() {
    const volti = await this.#caricaVolti();
    const p = await this.#caricaPersone();
    for (const k of [...p.assegnati.keys()]) if (!volti.get(relDi(k))?.[numDi(k)]) p.assegnati.delete(k);
    const nuovi = [];
    for (const [rel, elenco] of volti) elenco.forEach((v, i) => { const id = `${rel}#${i}`; if (!p.assegnati.has(id)) nuovi.push({ id, e: v.e }); });
    for (const [id, g] of raggruppa(nuovi, p.gruppi, SOGLIA_GRUPPO)) p.assegnati.set(id, g);
    const conta = new Map();
    for (const g of p.assegnati.values()) conta.set(g, (conta.get(g) || 0) + 1);
    p.gruppi = p.gruppi.filter((g) => conta.has(g.id) || g.nome);
    for (const g of p.gruppi) g.n = conta.get(g.id) || 0;
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
      const volti = await this.#caricaVolti();
      await this.#caricaPersone();
      const tutte = (await this.jarvis.galleria.tutti()).filter((v) => v.tipo === 'foto');
      const presenti = new Set(tutte.map((v) => v.p));
      const prima = impronte.size + volti.size;
      for (const rel of [...impronte.keys()]) if (!presenti.has(rel)) impronte.delete(rel); // foto spostate o tolte
      for (const rel of [...volti.keys()]) if (!presenti.has(rel)) volti.delete(rel);
      const daFare = tutte.filter((v) => !impronte.has(v.p) || !volti.has(v.p));
      if (!daFare.length && impronte.size + volti.size === prima) { // niente di nuovo: non riscrivo i file
        this.stato.totali = this.stato.indicizzate = tutte.length;
        return this.stato;
      }
      this.stato.totali = tutte.length;
      this.stato.indicizzate = tutte.length - daFare.length;
      let nonSalvate = 0;
      for (const v of daFare) {
        if (this.fermati || !this.jarvis.archivioDisponibile()) break;
        while (this.jarvis.lavoroInCorso && !this.fermati) await new Promise((r) => setTimeout(r, 5000));
        try {
          const a = await this.analizza(path.join(this.jarvis.cfg.archivio, v.p));
          impronte.set(v.p, a.clip);
          volti.set(v.p, a.volti);
        } catch {
          impronte.set(v.p, new Float32Array(256)); // illeggibile: non riprovo a ogni giro
          volti.set(v.p, []);
        }
        this.stato.indicizzate++;
        suProgresso(this.stato);
        if (++nonSalvate >= 100) { await this.#aggiornaPersone(); await this.#salva(); nonSalvate = 0; }
        if (pausa) await new Promise((r) => setTimeout(r, pausa));
      }
      await this.#aggiornaPersone();
      await this.#salva();
    } catch (e) {
      this.stato.errore = e.message;
    } finally {
      this.stato.inCorso = false;
    }
    return this.stato;
  }

  ferma() { this.fermati = true; }

  // ---------- persone ----------

  /** Le persone trovate (gruppi di volti), prima quelle con un nome. */
  async elencoPersone(minimo = 3) {
    const volti = await this.#caricaVolti();
    const p = await this.#caricaPersone();
    const migliore = new Map();
    for (const [id, g] of p.assegnati) {
      const v = volti.get(relDi(id))?.[numDi(id)];
      if (!v) continue;
      const area = v.b[2] * v.b[3];
      if (!migliore.has(g) || area > migliore.get(g).area) migliore.set(g, { id, area });
    }
    return p.gruppi.filter((g) => g.nome || g.n >= minimo)
      .sort((a, b) => (b.nome ? 1 : 0) - (a.nome ? 1 : 0) || b.n - a.n)
      .map((g) => ({ id: g.id, nome: g.nome || '', n: g.n, volto: migliore.get(g.id)?.id }));
  }

  async fotoDi(idPersona) {
    const p = await this.#caricaPersone();
    const foto = new Set();
    for (const [id, g] of p.assegnati) if (g === idPersona) foto.add(relDi(id));
    return [...foto].sort();
  }

  /** Dà un nome a un gruppo; se un altro gruppo ha già quel nome, li unisce (è la stessa persona). */
  async rinomina(idPersona, nome) {
    await this.#caricaImpronte();
    await this.#caricaVolti();
    const p = await this.#caricaPersone();
    const g = p.gruppi.find((x) => x.id === idPersona);
    if (!g) throw new Error('persona non trovata');
    const pulito = String(nome || '').replace(/[<>]/g, '').trim().slice(0, 40);
    const gemello = pulito && p.gruppi.find((x) => x !== g && x.nome && x.nome.toLowerCase() === pulito.toLowerCase());
    if (gemello) {
      for (const [id, x] of p.assegnati) if (x === g.id) p.assegnati.set(id, gemello.id);
      gemello.centro = normalizzaVolto(gemello.centro.map((v, i) => v * gemello.n + g.centro[i] * g.n));
      gemello.n += g.n;
      p.gruppi = p.gruppi.filter((x) => x !== g);
    } else g.nome = pulito;
    await this.#salva();
    return { id: gemello ? gemello.id : g.id, nome: pulito, unito: !!gemello };
  }

  /** Ritaglio quadrato di un volto (per le figurine delle persone). */
  async ritaglioVolto(idVolto, lato = 160) {
    const volti = await this.#caricaVolti();
    const v = volti.get(relDi(idVolto))?.[numDi(idVolto)];
    if (!v) return null;
    const { sharp } = await this.#carica();
    const { data, info } = await this.#grande(path.join(this.jarvis.cfg.archivio, relDi(idVolto)));
    const [x, y, w, h] = v.b;
    const cx = (x + w / 2) * info.width, cy = (y + h / 2) * info.height;
    const l = Math.max(1, Math.round(Math.min(Math.max(w * info.width, h * info.height) * 1.6, info.width, info.height)));
    const left = Math.round(Math.min(Math.max(0, cx - l / 2), info.width - l));
    const top = Math.round(Math.min(Math.max(0, cy - l / 2), info.height - l));
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } })
      .extract({ left, top, width: l, height: l }).resize(lato, lato).jpeg({ quality: 82 }).toBuffer();
  }

  // ---------- ricerca ----------

  /** Cerca le foto più vicine alla frase (o le foto di una persona, se la frase è il suo nome). */
  async cerca(frase, max = 240) {
    const p = await this.#caricaPersone();
    const cercato = String(frase).trim().toLowerCase();
    const persona = p.gruppi.find((g) => g.nome && (g.nome.toLowerCase() === cercato || cercato.split(/\s+/).includes(g.nome.toLowerCase())));
    if (persona) {
      const foto = await this.fotoDi(persona.id);
      return { frase, persona: persona.nome, risultati: foto.slice(0, 2000).map((x) => ({ p: x, s: 1 })), guardate: foto.length, totali: foto.length };
    }
    const impronte = await this.#caricaImpronte();
    if (!impronte.size) throw new Error('JARVIS non ha ancora guardato le foto: la prima lettura dell\'archivio è in corso, riprova tra poco.');
    const q = await this.improntaTesto(frase);
    const r = [];
    for (const [rel, v] of impronte) {
      let s = 0;
      for (let i = 0; i < v.length; i++) s += v[i] * q[i];
      if (s !== 0) r.push({ p: rel, s });
    }
    r.sort((a, b) => b.s - a.s);
    // tengo le più somiglianti: entro un margine dalla migliore, come fa una ricerca "a colpo d'occhio"
    const soglia = (r[0]?.s ?? 0) - 0.07;
    return { frase, risultati: r.filter((x, i) => i < max && x.s >= soglia), guardate: impronte.size, totali: this.stato.totali || impronte.size };
  }
}
