// AGENTE CUSTODE
// Backup zippato e incrementale su hard disk esterno, uno zip per ogni mese (così si riscrive solo
// quello che è cambiato). Zip in modalità "store": le foto sono già compresse, così è molto più veloce.
// Gli zip oltre 3,8 GB vengono divisi in parti, così funzionano anche su chiavette FAT32.
// Ogni zip viene verificato prima di sostituire il precedente.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import yauzl from 'yauzl';
import { ZipArchive } from 'archiver';
import { leggiJSON, scriviJSON, byteLeggibili, esiste } from '../util.js';
import { tipoDi } from './esploratore.js';

const LIMITE_PARTE = 3.8 * 1024 ** 3;
const CARTELLA_BACKUP = 'JARVIS_Backup';

function chiaveGruppo(rel) {
  const p = rel.split(/[\\/]/);
  if (p[0] === '_JARVIS') return ['registro', 'indice.json', 'ultima_importazione.json'].includes(p[1]) ? 'Registro' : null;
  if (p[0] === 'Arrivi' || p.length < 2) return null;
  if (p[0] === 'Da scegliere') return 'DaScegliere';
  if (['Foto', 'Video'].includes(p[0]) && /^\d{4}$/.test(p[1]) && /^\d{2} /.test(p[2] || '')) return `${p[1]}-${p[2].slice(0, 2)}`;
  if (p[0] === 'Screenshot' && /^\d{4}$/.test(p[1])) return `${p[1]}-Screenshot`;
  return 'Altro';
}

async function elencaArchivio(archivio) {
  const gruppi = new Map();
  async function cammina(dir) {
    for (const v of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, v.name);
      if (v.isDirectory()) await cammina(p);
      else if (v.isFile() && !v.name.endsWith('.tmp') && !v.name.endsWith('.jarvis-tmp')) {
        const rel = path.relative(archivio, p);
        const k = chiaveGruppo(rel);
        if (!k || (k !== 'Registro' && !tipoDi(v.name))) continue;
        const st = await fsp.stat(p);
        if (!gruppi.has(k)) gruppi.set(k, []);
        gruppi.get(k).push({ rel: rel.split(path.sep).join('/'), assoluto: p, dimensione: st.size, mtime: st.mtimeMs });
      }
    }
  }
  await cammina(archivio);
  for (const lista of gruppi.values()) lista.sort((a, b) => a.rel.localeCompare(b.rel));
  return gruppi;
}

function improntaGruppo(lista) {
  const h = crypto.createHash('sha1');
  for (const f of lista) h.update(`${f.rel}|${f.dimensione}|${Math.round(f.mtime)}\n`);
  return h.digest('hex');
}

function dividiInParti(lista) {
  const parti = [[]];
  let tot = 0;
  for (const f of lista) {
    if (tot + f.dimensione > LIMITE_PARTE && parti[parti.length - 1].length) { parti.push([]); tot = 0; }
    parti[parti.length - 1].push(f);
    tot += f.dimensione;
  }
  return parti;
}

function nomeZip(chiave, parte, totParti) {
  const anno = chiave.slice(0, 4);
  const sotto = /^\d{4}/.test(chiave) ? anno : '';
  const suff = totParti > 1 ? `_parte${parte + 1}` : '';
  return path.join(sotto, `JARVIS_Foto_${chiave}${suff}.zip`);
}

function creaZip(fileZip, lista, suProgresso) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(fileZip);
    const zip = new ZipArchive({ store: true });
    out.on('close', () => resolve(zip.pointer()));
    out.on('error', reject);
    zip.on('error', reject);
    zip.on('warning', (e) => (e.code === 'ENOENT' ? null : reject(e)));
    zip.on('progress', (p) => suProgresso?.(p.entries.processed, p.fs.processedBytes));
    zip.pipe(out);
    for (const f of lista) zip.file(f.assoluto, { name: f.rel, date: new Date(f.mtime) });
    zip.finalize();
  });
}

// Legge l'indice dello zip e, se richiesto, ricalcola l'impronta di ogni file contenuto.
function leggiZip(fileZip, profonda) {
  return new Promise((resolve, reject) => {
    yauzl.open(fileZip, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);
      const voci = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(voci));
      zip.on('entry', (e) => {
        if (e.fileName.endsWith('/')) return zip.readEntry();
        const voce = { nome: e.fileName, dimensione: e.uncompressedSize };
        voci.push(voce);
        if (!profonda) return zip.readEntry();
        zip.openReadStream(e, (e2, s) => {
          if (e2) return reject(e2);
          const h = crypto.createHash('sha256');
          s.on('data', (c) => h.update(c));
          s.on('error', reject);
          s.on('end', () => { voce.sha256 = h.digest('hex'); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

function controllaContenuto(voci, lista) {
  if (voci.length !== lista.length) return `contiene ${voci.length} file invece di ${lista.length}`;
  const attesi = new Map(lista.map((f) => [f.rel, f.dimensione]));
  for (const v of voci) {
    if (!attesi.has(v.nome)) return `file inatteso: ${v.nome}`;
    if (attesi.get(v.nome) !== v.dimensione) return `dimensione diversa: ${v.nome}`;
  }
  return null;
}

export async function backup(cfg, { destinazione, completo = false, emetti = () => {} }) {
  const radiceDest = destinazione || cfg.backup;
  if (!radiceDest) throw new Error('Non so dove fare il backup: indica la cartella o l\'unità dell\'hard disk esterno (es. "F:\\").');
  if (!(await esiste(radiceDest))) throw new Error(`Non trovo "${radiceDest}". L'hard disk esterno è collegato?`);
  if (!(await esiste(cfg.archivio))) throw new Error(`L'archivio "${cfg.archivio}" è ancora vuoto: prima importa delle foto.`);
  const dest = path.join(radiceDest, CARTELLA_BACKUP);
  if (path.resolve(dest).toLowerCase().startsWith(path.resolve(cfg.archivio).toLowerCase())) {
    throw new Error('Il backup non può stare dentro l\'archivio stesso: scegli un altro disco.');
  }
  await fsp.mkdir(dest, { recursive: true });
  const fileManifesto = path.join(dest, 'backup_jarvis.json');
  const manifesto = await leggiJSON(fileManifesto, { versione: 1, gruppi: {} });

  emetti({ t: 'messaggio', testo: 'Censimento dell\'archivio…' });
  const gruppi = await elencaArchivio(cfg.archivio);
  const daFare = [];
  for (const [k, lista] of gruppi) {
    const imp = improntaGruppo(lista);
    const prec = manifesto.gruppi[k];
    const presenti = prec && (await Promise.all(prec.zip.map((z) => esiste(path.join(dest, z))))).every(Boolean);
    if (completo || !prec || prec.impronta !== imp || !presenti) daFare.push({ k, lista, imp });
  }
  // Mesi spariti dall'archivio: li lascio nel backup (non si cancella mai nulla), ma li segnalo.
  const orfani = Object.keys(manifesto.gruppi).filter((k) => !gruppi.has(k));

  const byteDaScrivere = daFare.reduce((s, g) => s + g.lista.reduce((t, f) => t + f.dimensione, 0), 0);
  const sf = await fsp.statfs(dest).catch(() => null);
  if (sf && sf.bavail * sf.bsize < byteDaScrivere * 1.02 + 50 * 1024 ** 2) {
    throw new Error(`Spazio insufficiente sul disco di backup: servono ${byteDaScrivere ? byteLeggibili(byteDaScrivere) : '?'}, liberi ${byteLeggibili(sf.bavail * sf.bsize)}.`);
  }

  const totFile = daFare.reduce((s, g) => s + g.lista.length, 0);
  emetti({ t: 'backup_piano', gruppi: daFare.map((g) => ({ k: g.k, n: g.lista.length })), invariati: gruppi.size - daFare.length,
    totFile, byte: byteDaScrivere });

  let fileFatti = 0;
  let byteFatti = 0;
  const esiti = [];
  for (const g of daFare) {
    const parti = dividiInParti(g.lista);
    const nomi = parti.map((_, i) => nomeZip(g.k, i, parti.length));
    emetti({ t: 'zip_inizio', k: g.k, n: g.lista.length, parti: parti.length });
    let errore = null;
    let byteGruppo = 0;
    for (let i = 0; i < parti.length && !errore; i++) {
      const finale = path.join(dest, nomi[i]);
      await fsp.mkdir(path.dirname(finale), { recursive: true });
      const tmp = `${finale}.tmp`;
      const base = fileFatti;
      const baseByte = byteFatti;
      try {
        let ultimo = 0;
        const scritti = await creaZip(tmp, parti[i], (fatti, byte) => {
          const adesso = Date.now();
          if (adesso - ultimo > 150) {
            ultimo = adesso;
            emetti({ t: 'zip_prog', k: g.k, fatti: base + fatti, totFile, byte: baseByte + byte, totByte: byteDaScrivere });
          }
        });
        const problema = controllaContenuto(await leggiZip(tmp, false), parti[i]);
        if (problema) throw new Error(`verifica fallita (${problema})`);
        await fsp.rename(tmp, finale);
        byteGruppo += scritti;
        fileFatti = base + parti[i].length;
        byteFatti = baseByte + parti[i].reduce((s, f) => s + f.dimensione, 0);
      } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        errore = e.message;
      }
    }
    if (!errore) {
      // Elimino solo eventuali parti in più di un backup precedente dello stesso mese (ormai sostituite).
      for (const vecchio of manifesto.gruppi[g.k]?.zip || []) {
        if (!nomi.includes(vecchio)) await fsp.rm(path.join(dest, vecchio), { force: true }).catch(() => {});
      }
      manifesto.gruppi[g.k] = { impronta: g.imp, zip: nomi, file: g.lista.length, byte: byteGruppo, quando: new Date().toISOString() };
      await scriviJSON(fileManifesto, manifesto);
    }
    esiti.push({ k: g.k, ok: !errore, errore, file: g.lista.length, zip: nomi });
    emetti({ t: 'zip_fine', k: g.k, ok: !errore, errore, byte: byteGruppo });
  }

  manifesto.ultimoBackup = new Date().toISOString();
  manifesto.archivio = cfg.archivio;
  await scriviJSON(fileManifesto, manifesto);
  const riepilogo = {
    quando: manifesto.ultimoBackup, destinazione: dest, aggiornati: esiti.filter((e) => e.ok).length,
    invariati: gruppi.size - daFare.length, errori: esiti.filter((e) => !e.ok), file: totFile, byte: byteDaScrivere, orfani,
  };
  await scriviJSON(path.join(cfg.archivio, '_JARVIS', 'ultimo_backup.json'), riepilogo);
  return riepilogo;
}

export async function verificaBackup(cfg, { destinazione, profonda = false, emetti = () => {} }) {
  const radiceDest = destinazione || cfg.backup;
  if (!radiceDest) throw new Error('Indica dove si trova il backup (es. "F:\\").');
  const dest = path.join(radiceDest, CARTELLA_BACKUP);
  const manifesto = await leggiJSON(path.join(dest, 'backup_jarvis.json'), null);
  if (!manifesto) throw new Error(`Nessun backup JARVIS trovato in "${radiceDest}".`);
  const gruppi = await elencaArchivio(cfg.archivio);
  const indice = await leggiJSON(path.join(cfg.archivio, '_JARVIS', 'indice.json'), { file: {} });
  const hashPerPercorso = new Map(Object.entries(indice.file || {}).map(([h, r]) => [r.split(path.sep).join('/').replace(/\\/g, '/'), h]));

  const chiavi = Object.keys(manifesto.gruppi).sort();
  emetti({ t: 'verifica_piano', gruppi: chiavi.map((k) => ({ k, n: manifesto.gruppi[k].file })) });
  const risultati = [];
  for (const k of chiavi) {
    const g = manifesto.gruppi[k];
    const problemi = [];
    let voci = [];
    for (const z of g.zip) {
      const pz = path.join(dest, z);
      if (!(await esiste(pz))) { problemi.push(`manca ${z}`); continue; }
      try {
        voci = voci.concat(await leggiZip(pz, profonda));
      } catch (e) {
        problemi.push(`${z} danneggiato: ${e.message}`);
      }
    }
    if (voci.length !== g.file) problemi.push(`contiene ${voci.length} file, attesi ${g.file}`);
    if (profonda) {
      for (const v of voci) {
        const atteso = hashPerPercorso.get(v.nome);
        if (atteso && v.sha256 && atteso !== v.sha256) problemi.push(`contenuto diverso: ${v.nome}`);
      }
    }
    const attuale = gruppi.get(k);
    const aggiornato = attuale ? improntaGruppo(attuale) === g.impronta : true;
    risultati.push({ k, ok: !problemi.length, problemi: problemi.slice(0, 5), aggiornato });
    emetti({ t: 'verifica_gruppo', k, ok: !problemi.length, aggiornato });
  }
  const nonSalvati = [...gruppi.keys()].filter((k) => !manifesto.gruppi[k]);
  return {
    destinazione: dest, ultimoBackup: manifesto.ultimoBackup, controllati: risultati.length,
    integri: risultati.filter((r) => r.ok).length, danneggiati: risultati.filter((r) => !r.ok),
    daAggiornare: risultati.filter((r) => r.ok && !r.aggiornato).map((r) => r.k), nonSalvati, profonda,
  };
}
