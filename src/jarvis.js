// IL CERVELLO DI JARVIS
// Coordina gli agenti: Esploratore (trova), Archivista (ordina), Custode (protegge),
// Regista (mostra e parla), Sentinella (si accorge dei supporti e chiede).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { esplora, rilevaSupporti, eseguiPowerShell } from './agenti/esploratore.js';
import {
  Indice, pianifica, esegui, statisticheArchivio, rinominaGiornata, annullaUltima, elencaDaScegliere, spostaSicuro, CARTELLE_ARCHIVIO,
} from './agenti/archivista.js';
import { backup, verificaBackup } from './agenti/custode.js';
import { Regista } from './agenti/regista.js';
import { contaMultimediali, sentinellaInEsecuzione, SOGLIA_SPAZIO_BASSO } from './agenti/sentinella.js';
import { leggiJSON, numero, byteLeggibili, saluto, nomeSicuro, cartellaMese, ora, esiste, inParallelo } from './util.js';
import { tipoDi } from './agenti/esploratore.js';

export const VERSIONE = '1.3.0';
const MARGINE_SPAZIO = 1024 ** 3; // dopo un'importazione devono restare almeno 1 GB liberi

export class Jarvis {
  constructor(cfg) {
    this.cfg = cfg;
    this.regista = new Regista(cfg);
    this.lavoroInCorso = null;
    this.ultimoEsito = null;
    this.progresso = null;
    fs.mkdirSync(cfg.arrivi, { recursive: true });
  }

  // Byte liberi sul disco dell'archivio (null se non si riesce a leggerli). Sostituibile nei collaudi.
  leggiSpazio = async () => {
    const sf = await fsp.statfs(this.cfg.archivio).catch(() => null);
    return sf ? sf.bavail * sf.bsize : null;
  };

  // Prima di copiare: c'è posto? Meglio fermarsi subito che riempire il disco a metà lavoro.
  async #controllaSpazio(byteNecessari) {
    if (!byteNecessari) return;
    const libero = await this.leggiSpazio();
    if (libero !== null && libero < byteNecessari + MARGINE_SPAZIO) {
      throw new Error(`Spazio insufficiente sul disco dell'archivio: servono circa ${byteLeggibili(byteNecessari)}, ` +
        `liberi ${byteLeggibili(libero)}. Libera spazio o sposta l'archivio su un disco più grande. Non ho copiato nulla.`);
    }
  }

  async #avvisoSpazio() {
    const libero = await this.leggiSpazio().catch(() => null);
    return libero !== null && libero < SOGLIA_SPAZIO_BASSO ? `Sul disco dell'archivio restano solo ${byteLeggibili(libero)} liberi.` : null;
  }

  emetti = (e) => {
    if (e.t === 'file' || e.t === 'analisi' || e.t === 'zip_prog') this.progresso = e;
    this.regista.emetti(e);
  };

  // Cartelle dell'archivio da non esplorare mai come sorgente.
  get #escluse() {
    return [...CARTELLE_ARCHIVIO, '_JARVIS'].map((c) => path.join(this.cfg.archivio, c));
  }

  #controllaSorgente(sorgente) {
    const s = path.resolve(sorgente.trim().replace(/^"|"$/g, '')).toLowerCase();
    const a = path.resolve(this.cfg.archivio).toLowerCase();
    const arr = path.resolve(this.cfg.arrivi).toLowerCase();
    if ((s === a || s.startsWith(a + path.sep)) && !(s === arr || s.startsWith(arr + path.sep))) {
      throw new Error('Questa cartella è già dentro l\'archivio. Per importare file nuovi mettili nella cartella Arrivi.');
    }
  }

  async #prepara(modo, dettagli, effetti) {
    if (this.lavoroInCorso) throw new Error(`Sto già lavorando (${this.lavoroInCorso.modo}). Aspetta che finisca o chiedimi a che punto sono.`);
    this.lavoroInCorso = { modo, inizio: Date.now(), ...dettagli };
    if (effetti ?? this.cfg.effetti) {
      await this.regista.apri();
      await this.regista.attendiClient(3500);
    } else {
      await this.regista.avvia();
    }
    this.progresso = null;
    this.emetti({ t: 'inizio', modo, ...dettagli, nome: this.cfg.nome });
  }

  #chiudi(fine) {
    this.lavoroInCorso = null;
    this.ultimoEsito = fine;
    this.emetti({ t: 'fine', ...fine });
  }

  async #conAttesa(promessa, attesaMax) {
    if (!attesaMax) return promessa;
    const timer = new Promise((r) => setTimeout(() => r({ inCorso: true }), attesaMax));
    return Promise.race([promessa, timer]);
  }

  // ---------- Importazione ----------

  async anteprima(sorgente) {
    this.#controllaSorgente(sorgente);
    const { file, pulisci } = await esplora(sorgente, { escludi: this.#escluse });
    try {
      const indice = new Indice(this.cfg.archivio);
      await indice.carica(null, this.cfg.simili);
      const { piano, giornate, gruppiSimili } = await pianifica(file, this.cfg, indice);
      const nuovi = piano.filter((p) => p.esito === 'nuovo');
      const perMese = {};
      for (const p of nuovi) {
        const k = `${p.data.getFullYear()} · ${cartellaMese(p.data)}`;
        perMese[k] = (perMese[k] || 0) + 1;
      }
      const fonti = {};
      for (const p of piano) fonti[p.fonte] = (fonti[p.fonte] || 0) + 1;
      return {
        sorgente, trovati: file.length, nuovi: nuovi.length,
        doppioni: piano.filter((p) => p.esito === 'doppione').length,
        nonValidi: piano.filter((p) => p.esito === 'errore').length,
        simili: nuovi.filter((p) => p.simile).length,
        livePhoto: nuovi.filter((p) => p.livePhoto).length,
        video: nuovi.filter((p) => p.tipo === 'video' && !p.livePhoto).length,
        screenshot: nuovi.filter((p) => p.categoria === 'Screenshot').length,
        dal: nuovi[0]?.data.toISOString().slice(0, 10), al: nuovi.at(-1)?.data.toISOString().slice(0, 10),
        perMese, giornateSpeciali: giornate.map((g) => g.nome), gruppiSimili: gruppiSimili.length,
        luoghi: [...new Set(nuovi.map((p) => p.luogo).filter(Boolean))].slice(0, 15), fontiData: fonti,
        esempi: nuovi.slice(0, 8).map((p) => `${p.nome} → ${p.destRel.replace(/\\/g, '/')}`),
        archivio: this.cfg.archivio,
      };
    } finally {
      await pulisci();
    }
  }

  // Il flusso vero e proprio, usato da tutte le importazioni.
  async #flusso(sorgente, modalita) {
    let pulisci = async () => {};
    try {
      this.emetti({ t: 'fase', fase: 'esplorazione', testo: `Esploro ${sorgente}` });
      const esito = await esplora(sorgente, {
        escludi: this.#escluse,
        suProgresso: (n) => this.emetti({ t: 'scansione', trovati: n }),
        suMessaggio: (testo) => this.emetti({ t: 'messaggio', testo }),
      });
      pulisci = esito.pulisci;
      const file = esito.file;
      if (!file.length) return { modo: 'importa', esito: 'vuoto', testo: 'Nessuna foto o video trovati.', sorgente };
      this.regista.parla(`${saluto(this.cfg.nome)}. Ho trovato ${numero(file.length)} file. Inizio l'archiviazione.`);
      this.emetti({ t: 'fase', fase: 'analisi', testo: `Analisi di ${numero(file.length)} file`, n: file.length });
      const indice = new Indice(this.cfg.archivio);
      await indice.carica(this.emetti, this.cfg.simili);
      const pianificazione = await pianifica(file, this.cfg, indice, this.emetti);
      // Spostare dentro lo stesso disco non occupa spazio; copiare (o spostare da un altro disco) sì.
      const radice = (p) => path.parse(path.resolve(p)).root.toLowerCase();
      if (modalita === 'copia' || radice(sorgente) !== radice(this.cfg.archivio)) {
        await this.#controllaSpazio(pianificazione.piano.filter((p) => p.esito === 'nuovo').reduce((t, p) => t + (p.dimensione || 0), 0));
      }
      for (const g of pianificazione.giornate) this.emetti({ t: 'giornata', giorno: g.giorno, nome: g.nome });
      this.emetti({ t: 'fase', fase: 'archiviazione', testo: 'Archiviazione in corso', n: pianificazione.piano.length });
      const riepilogo = await esegui(pianificazione, this.cfg, indice, {
        modalita, emetti: this.emetti, sorgente, registraMiniatura: (p) => this.regista.registraMiniatura(p),
      });
      riepilogo.giornate = pianificazione.giornate.map((g) => g.nome);
      riepilogo.statistiche = await statisticheArchivio(this.cfg.archivio);
      const p = await this.promemoriaBackup();
      const spazio = await this.#avvisoSpazio();
      if (spazio) this.regista.parla('Attenzione: lo spazio sul disco sta finendo.');
      const note = [p?.daFare ? p.testo : null, spazio].filter(Boolean);
      if (note.length) riepilogo.promemoria = note.join(' ');
      return { modo: 'importa', esito: 'ok', ...riepilogo };
    } finally {
      await pulisci();
    }
  }

  #parlaFine(r) {
    if (r.esito === 'ok') {
      this.regista.parla(`Archiviazione completata. ${numero(r.archiviati)} file archiviati` +
        (r.doppioni ? `, ${numero(r.doppioni)} doppioni ignorati.` : '.'));
    } else if (r.esito === 'vuoto') this.regista.parla('Non ho trovato foto da archiviare.');
    else this.regista.parla('Attenzione. Si è verificato un problema durante l\'importazione.');
  }

  async #lavoroImportazione(corpo) {
    try {
      const fine = await corpo();
      this.#parlaFine(fine);
      this.#chiudi(fine);
      return fine;
    } catch (e) {
      const fine = { modo: 'importa', esito: 'errore', errore: e.message };
      this.#parlaFine(fine);
      this.#chiudi(fine);
      return fine;
    }
  }

  async importa(sorgente, { modalita = 'copia', effetti, attesaMax = 0 } = {}) {
    this.#controllaSorgente(sorgente);
    await this.#prepara('importa', { sorgente, modalita }, effetti);
    return this.#conAttesa(this.#lavoroImportazione(() => this.#flusso(sorgente, modalita)), attesaMax);
  }

  // Svuota la cartella Arrivi: sposta tutto nell'archivio (con verifica). Gli zip elaborati e i file
  // non riconosciuti vanno messi da parte in _JARVIS, mai cancellati.
  async importaArrivi({ effetti, attesaMax = 0 } = {}) {
    const arrivi = this.cfg.arrivi;
    fs.mkdirSync(arrivi, { recursive: true });
    const voci = fs.readdirSync(arrivi);
    if (!voci.length) return { modo: 'importa', esito: 'vuoto', testo: 'La cartella Arrivi è vuota: mettici foto, cartelle o zip e riprova.', cartella: arrivi };
    await this.#prepara('importa', { sorgente: arrivi, modalita: 'sposta', arrivi: true }, effetti);
    return this.#conAttesa(this.#lavoroImportazione(async () => {
      const r = await this.#flusso(arrivi, 'sposta');
      r.avanzi = await this.#riordinaArrivi(arrivi);
      r.cartellaArrivi = arrivi;
      return r;
    }), attesaMax);
  }

  // Modalità usata dalla Sentinella: copia dal supporto in Arrivi, poi sistema da Arrivi.
  async importaDaSupporto(radice, { etichetta = '', effetti, attesaMax = 0 } = {}) {
    const sotto = path.join(this.cfg.arrivi, nomeSicuro(`${ora()}_${etichetta || radice.replace(/[:\\/]/g, '')}`));
    await this.#prepara('importa', { sorgente: radice, modalita: 'copia', supporto: true }, effetti);
    return this.#conAttesa(this.#lavoroImportazione(async () => {
      this.emetti({ t: 'fase', fase: 'copia', testo: `Copio da ${radice} nella cartella Arrivi` });
      const { file, pulisci } = await esplora(radice, { escludi: this.#escluse, suProgresso: (n) => this.emetti({ t: 'scansione', trovati: n }) });
      try {
        await this.#controllaSpazio(file.reduce((t, f) => t + (f.dimensione || 0), 0));
        let fatti = 0;
        await inParallelo(file, 3, async (f) => {
          const rel = f.origineZip ? path.join(path.parse(f.origineZip).name, path.basename(f.percorso)) : path.relative(path.resolve(radice), f.percorso);
          const dest = path.join(sotto, rel);
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.copyFile(f.percorso, dest);
          await fsp.utimes(dest, f.mtime, f.mtime).catch(() => {});
          fatti++;
          if (fatti % 5 === 0 || fatti === file.length) this.emetti({ t: 'analisi', fatti, n: file.length, fase: 'copia' });
        });
      } finally {
        await pulisci();
      }
      const r = await this.#flusso(sotto, 'sposta');
      r.avanzi = await this.#riordinaArrivi(sotto);
      r.sorgente = radice;
      return r;
    }), attesaMax);
  }

  async #riordinaArrivi(dir) {
    const t = ora();
    let spostati = 0;
    const radiceArrivi = this.cfg.arrivi;
    const cammina = async (d) => {
      for (const v of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, v.name);
        if (v.isDirectory()) { await cammina(p); await fsp.rmdir(p).catch(() => {}); continue; }
        const rel = path.relative(radiceArrivi, p);
        const dove = v.name.toLowerCase().endsWith('.zip') ? 'Zip_importati' : 'Arrivi_avanzi';
        await spostaSicuro(p, path.join(this.cfg.archivio, '_JARVIS', dove, t, rel)).catch(() => {});
        spostati++;
      }
    };
    await cammina(dir);
    if (dir !== radiceArrivi) await fsp.rmdir(dir).catch(() => {});
    return spostati ? { file: spostati, nota: 'zip elaborati e file non riconosciuti messi da parte in _JARVIS (Zip_importati / Arrivi_avanzi)' } : null;
  }

  async annullaUltimaImportazione() {
    if (this.lavoroInCorso) throw new Error('Aspetta che finisca il lavoro in corso.');
    const r = await annullaUltima(this.cfg.archivio);
    this.regista.parla('Ultima importazione annullata.');
    return r;
  }

  // ---------- Backup ----------

  async backup({ destinazione, completo = false, effetti, attesaMax = 0 } = {}) {
    await this.#prepara('backup', { destinazione: destinazione || this.cfg.backup, completo }, effetti);
    const lavoro = (async () => {
      try {
        this.regista.parla(`${saluto(this.cfg.nome)}. Avvio il protocollo di backup.`);
        const r = await backup(this.cfg, { destinazione, completo, emetti: this.emetti });
        const fine = { modo: 'backup', esito: r.errori.length ? 'parziale' : 'ok', ...r };
        this.regista.parla(r.errori.length ? 'Backup completato con alcuni errori. Controlla il riepilogo.'
          : r.aggiornati ? `Backup completato e verificato. ${r.aggiornati} archivi aggiornati.` : 'Il backup era già aggiornato.');
        this.#chiudi(fine);
        return fine;
      } catch (e) {
        const fine = { modo: 'backup', esito: 'errore', errore: e.message };
        this.regista.parla('Attenzione. Backup non riuscito.');
        this.#chiudi(fine);
        return fine;
      }
    })();
    return this.#conAttesa(lavoro, attesaMax);
  }

  async verifica({ destinazione, profonda = false, effetti, attesaMax = 0 } = {}) {
    await this.#prepara('verifica', { destinazione: destinazione || this.cfg.backup, profonda }, effetti);
    const lavoro = (async () => {
      try {
        const r = await verificaBackup(this.cfg, { destinazione, profonda, emetti: this.emetti });
        const fine = { modo: 'verifica', esito: r.danneggiati.length ? 'problemi' : 'ok', ...r };
        this.regista.parla(r.danneggiati.length ? 'Attenzione: alcuni archivi del backup hanno problemi.' : 'Verifica completata. Il backup è integro.');
        this.#chiudi(fine);
        return fine;
      } catch (e) {
        const fine = { modo: 'verifica', esito: 'errore', errore: e.message };
        this.#chiudi(fine);
        return fine;
      }
    })();
    return this.#conAttesa(lavoro, attesaMax);
  }

  // Serve un backup? (mai fatto, più di 30 giorni, o foto nuove da più di 7 giorni)
  async promemoriaBackup() {
    const ub = await leggiJSON(path.join(this.cfg.archivio, '_JARVIS', 'ultimo_backup.json'), null);
    const ui = await leggiJSON(path.join(this.cfg.archivio, '_JARVIS', 'ultima_importazione.json'), null);
    if (!ui && !ub) return null;
    if (!ub) return { daFare: true, giorni: null, testo: 'Non hai ancora fatto nessun backup delle foto: collega l\'hard disk esterno e fai il backup (icona JARVIS Foto, tasto 3).' };
    const giorni = Math.floor((Date.now() - new Date(ub.quando)) / 86400000);
    const novita = ui && new Date(ui.quando) > new Date(ub.quando) && ui.archiviati > 0;
    if (giorni >= 30) return { daFare: true, giorni, testo: `L'ultimo backup è di ${giorni} giorni fa: è ora di aggiornarlo.` };
    if (novita && giorni >= 7) return { daFare: true, giorni, testo: `Ci sono foto nuove e l'ultimo backup è di ${giorni} giorni fa.` };
    if (novita) return { daFare: true, giorni, testo: 'Ci sono foto nuove non ancora salvate nel backup.' };
    return { daFare: false, giorni, testo: `Backup aggiornato (${giorni === 0 ? 'oggi' : `${giorni} giorni fa`}).` };
  }

  // ---------- Consultazione ----------

  async #recenti(max = 12) {
    const dir = path.join(this.cfg.archivio, '_JARVIS', 'registro');
    const elenco = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('_importazione.json')).sort().reverse();
    const out = [];
    for (const f of elenco) {
      const r = await leggiJSON(path.join(dir, f), null);
      if (!r || r.annullata) continue;
      for (const v of [...r.voci].reverse()) {
        if (out.length >= max) break;
        if (v.esito !== 'archiviato' || tipoDi(v.a) !== 'foto' || v.a.startsWith('Da scegliere')) continue;
        const p = path.join(this.cfg.archivio, v.a);
        if (await esiste(p)) out.push({ id: this.regista.registraMiniatura(p), nome: path.basename(v.a) });
      }
      if (out.length >= max) break;
    }
    return out;
  }

  async stato() {
    const s = await statisticheArchivio(this.cfg.archivio);
    const recenti = await this.#recenti();
    this.emetti({ t: 'archivio', statistiche: s, recenti });
    const ultimaImportazione = await leggiJSON(path.join(this.cfg.archivio, '_JARVIS', 'ultima_importazione.json'), null);
    const ultimoBackup = await leggiJSON(path.join(this.cfg.archivio, '_JARVIS', 'ultimo_backup.json'), null);
    let progresso = null;
    if (this.lavoroInCorso && this.progresso) {
      const p = this.progresso;
      progresso = p.t === 'file' ? `file ${numero(p.i)} di ${numero(p.n)}`
        : p.t === 'analisi' ? `${p.fase === 'copia' ? 'copia' : 'analisi'} ${numero(p.fatti)} di ${numero(p.n)}`
          : `${numero(p.fatti)} di ${numero(p.totFile)} file salvati (${byteLeggibili(p.byte)})`;
    }
    const inArrivi = await contaMultimediali(this.cfg.arrivi, 100000);
    const p = await this.promemoriaBackup();
    return {
      versione: VERSIONE,
      archivio: this.cfg.archivio, cartellaArrivi: this.cfg.arrivi, fileInArrivi: inArrivi,
      backupPredefinito: this.cfg.backup || '(non impostato)',
      totali: { foto: s.foto, video: s.video, screenshot: s.screenshot, daScegliere: s.daScegliere, spazio: byteLeggibili(s.byte) }, perAnno: s.perAnno,
      lavoroInCorso: this.lavoroInCorso ? { ...this.lavoroInCorso, progresso, daSecondi: Math.round((Date.now() - this.lavoroInCorso.inizio) / 1000) } : null,
      ultimoEsito: this.ultimoEsito ? sintesi(this.ultimoEsito) : null,
      ultimaImportazione: ultimaImportazione && { quando: ultimaImportazione.quando, sorgente: ultimaImportazione.sorgente, archiviati: ultimaImportazione.archiviati, doppioni: ultimaImportazione.doppioni },
      ultimoBackup: ultimoBackup && { quando: ultimoBackup.quando, destinazione: ultimoBackup.destinazione },
      promemoria: p?.daFare ? p.testo : null,
      pannello: this.regista.url,
    };
  }

  supporti() { return rilevaSupporti(); }
  daScegliere() { return elencaDaScegliere(this.cfg.archivio); }

  async rinominaGiornata(giorno, descrizione) {
    return rinominaGiornata(this.cfg.archivio, giorno, descrizione, nomeSicuro);
  }

  async ricostruisciIndice() {
    const i = new Indice(this.cfg.archivio);
    const n = await i.ricostruisci(this.emetti, this.cfg.simili);
    return { file: n };
  }

  // Controllo dell'installazione: utile se qualcosa non funziona sul PC.
  async diagnostica() {
    const d = { versione: VERSIONE, node: process.version, sistema: `${os.type()} ${os.release()} (${process.platform})`, archivio: this.cfg.archivio, controlli: {} };
    try {
      await fsp.mkdir(this.cfg.archivio, { recursive: true });
      const prova = path.join(this.cfg.archivio, `.jarvis-prova-${process.pid}`);
      await fsp.writeFile(prova, 'ok');
      await fsp.rm(prova);
      d.controlli.scritturaArchivio = 'ok';
    } catch (e) { d.controlli.scritturaArchivio = `ERRORE: ${e.message}`; }
    const sf = await fsp.statfs(this.cfg.archivio).catch(() => null);
    d.controlli.spazioLibero = sf ? byteLeggibili(sf.bavail * sf.bsize) : 'sconosciuto';
    d.controlli.pannello = (await this.regista.avvia()) || 'ERRORE: nessuna porta libera';
    d.controlli.backup = this.cfg.backup ? ((await esiste(this.cfg.backup)) ? `ok (${this.cfg.backup})` : `disco non collegato (${this.cfg.backup})`) : 'non impostato';
    if (process.platform === 'win32') {
      const voci = await eseguiPowerShell('Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + " [" + $_.VoiceInfo.Culture.Name + "]" }');
      const elenco = (voci || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      d.controlli.voci = elenco.length ? elenco : 'ERRORE: sintesi vocale non disponibile';
      d.controlli.voceItaliana = elenco.some((v) => /\[it/i.test(v)) ? 'ok' : 'nessuna voce italiana installata (Impostazioni → Ora e lingua → Voce)';
    } else d.controlli.voci = process.platform === 'darwin' ? 'say (macOS)' : 'non disponibile su questo sistema';
    d.controlli.sentinella = this.sentinellaAttiva ? 'attiva: ti chiede se importare quando inserisci schede/chiavette o riempi Arrivi'
      : (this.sentinellaAltrove || sentinellaInEsecuzione()) ? 'attiva in background (avvio automatico di Windows)'
        : process.platform !== 'win32' ? 'non disponibile (solo Windows)'
          : (this.cfg.sorveglianza ? 'NON attiva: menu JARVIS Foto, tasto 9 per avviarla' : 'disattivata nelle impostazioni');
    d.controlli.supporti = (await rilevaSupporti()).map((s) => `${s.percorso} ${s.nome} · ${s.tipo}${s.haDCIM ? ' · DCIM' : ''}`);
    d.controlli.fileInArrivi = await contaMultimediali(this.cfg.arrivi);
    return d;
  }
}

// Riepilogo leggibile (senza elenchi enormi) da restituire a Claude o mostrare in console.
export function sintesi(r) {
  if (!r) return r;
  if (r.inCorso) return { inCorso: true, messaggio: 'Lavoro ancora in corso: lo vedi sul pannello. Chiedimi "a che punto sei?" per aggiornamenti.' };
  const { statistiche, ...resto } = r;
  if (resto.byte !== undefined) resto.spazio = byteLeggibili(resto.byte);
  delete resto.byte;
  if (statistiche) resto.archivioTotale = { foto: statistiche.foto, video: statistiche.video, screenshot: statistiche.screenshot, daScegliere: statistiche.daScegliere, spazio: byteLeggibili(statistiche.byte) };
  return resto;
}
