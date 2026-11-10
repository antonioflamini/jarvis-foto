#!/usr/bin/env node
// JARVIS Foto da riga di comando (usato anche da JARVIS.bat).
//   node src/cli.js importa <cartella|zip|unità> [--sposta] [--no-effetti]
//   node src/cli.js anteprima <sorgente>
//   node src/cli.js backup [destinazione] [--completo]
//   node src/cli.js verifica [destinazione] [--profonda]
//   node src/cli.js arrivi | annulla | simili | sorveglia | diagnostica
//   node src/cli.js supporti | stato | pannello
import { Jarvis, sintesi } from './jarvis.js';
import { Sentinella } from './agenti/sentinella.js';
import { caricaConfig } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { numero, byteLeggibili } from './util.js';
import { RADICE_PROGETTO } from './config.js';

// Registro su file (jarvis.log nella cartella del programma), utile quando gira nascosto.
const FILE_LOG = path.join(RADICE_PROGETTO, 'jarvis.log');
function registra(testo) {
  try {
    if (fs.existsSync(FILE_LOG) && fs.statSync(FILE_LOG).size > 1024 * 1024) fs.renameSync(FILE_LOG, `${FILE_LOG}.1`);
    fs.appendFileSync(FILE_LOG, `${new Date().toLocaleString('it-IT')}  ${testo}\r\n`);
  } catch { /* registro non scrivibile */ }
}
function registroSuFile() {
  jarvis.regista.on('evento', (e) => {
    if (e.t === 'messaggio') registra(e.testo);
    if (e.t === 'inizio') registra(`Inizio ${e.modo} · ${e.sorgente || e.destinazione || ''}`);
    if (e.t === 'fine') registra(`Fine ${e.modo} · ${e.esito}${e.archiviati !== undefined ? ` · archiviati ${e.archiviati}, doppioni ${e.doppioni}` : ''}${e.errore ? ` · ${e.errore}` : ''}`);
  });
}

const [comando, ...resto] = process.argv.slice(2);
const flag = (f) => resto.includes(f);
const arg = resto.find((a) => !a.startsWith('--'));
const cfg = caricaConfig(flag('--no-effetti') ? { effetti: false } : {});
const jarvis = new Jarvis(cfg);

const C = { c: '\x1b[96m', g: '\x1b[92m', a: '\x1b[93m', r: '\x1b[91m', d: '\x1b[2m', x: '\x1b[0m' };
const intestazione = () => console.log(`${C.c}
   ╦╔═╗╦═╗╦  ╦╦╔═╗   ${C.d}Archivio foto personale${C.c}
   ║╠═╣╠╦╝╚╗╔╝║╚═╗   ${C.d}archivio: ${cfg.archivio}${C.c}
  ╚╝╩ ╩╩╚═ ╚╝ ╩╚═╝${C.x}
`);

function barra(p, larg = 32) {
  const n = Math.round(p * larg);
  return `${C.c}${'█'.repeat(n)}${C.d}${'░'.repeat(larg - n)}${C.x} ${String(Math.round(p * 100)).padStart(3)}%`;
}

jarvis.regista.on('evento', (e) => {
  if (e.t === 'analisi') process.stdout.write(`\r  Analisi   ${barra(e.fatti / e.n)} ${numero(e.fatti)}/${numero(e.n)}   `);
  if (e.t === 'fase' && e.fase === 'archiviazione') process.stdout.write('\n');
  if (e.t === 'file') process.stdout.write(`\r  Archivio  ${barra(e.i / e.n)} ${numero(e.i)}/${numero(e.n)}   `);
  if (e.t === 'zip_prog') process.stdout.write(`\r  Backup    ${barra(e.totByte ? e.byte / e.totByte : 0)} ${byteLeggibili(e.byte)}   `);
  if (e.t === 'zip_fine') process.stdout.write(`\r  ${e.ok ? C.g + '✔' : C.r + '✖'} ${e.k}${C.x}${' '.repeat(40)}\n`);
  if (e.t === 'messaggio') process.stdout.write(`\r  ${C.d}${e.testo}${C.x}${' '.repeat(10)}\n`);
});

async function attendiPannello() {
  // lascia al pannello il tempo di finire l'animazione prima di chiudere
  if (cfg.effetti && jarvis.regista.client.size) await new Promise((r) => setTimeout(r, 25000));
}

function mostra(r) {
  console.log('\n');
  const s = sintesi(r);
  if (s.esito === 'errore') console.log(`  ${C.r}✖ ${s.errore}${C.x}`);
  for (const [k, v] of Object.entries(s)) {
    if (['modo', 'quando'].includes(k) || v === null || v === undefined) continue;
    console.log(`  ${C.d}${k.padEnd(16)}${C.x} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
}

try {
  intestazione();
  switch (comando) {
    case 'importa':
      if (!arg) throw new Error('Indica la cartella, lo zip o l\'unità da importare.');
      mostra(await jarvis.importa(arg, { modalita: flag('--sposta') ? 'sposta' : 'copia' }));
      await attendiPannello();
      break;
    case 'anteprima':
      if (!arg) throw new Error('Indica la sorgente.');
      console.log(JSON.stringify(await jarvis.anteprima(arg), null, 2));
      break;
    case 'backup':
      mostra(await jarvis.backup({ destinazione: arg, completo: flag('--completo') }));
      await attendiPannello();
      break;
    case 'verifica':
      mostra(await jarvis.verifica({ destinazione: arg, profonda: flag('--profonda') }));
      await attendiPannello();
      break;
    case 'arrivi':
      mostra(await jarvis.importaArrivi());
      await attendiPannello();
      break;
    case 'annulla':
      console.log(JSON.stringify(await jarvis.annullaUltimaImportazione(), null, 2));
      break;
    case 'simili':
      console.log(JSON.stringify(await jarvis.daScegliere(), null, 2));
      break;
    case 'diagnostica':
      console.log(JSON.stringify(await jarvis.diagnostica(), null, 2));
      break;
    case 'sorveglia': {
      // Modalità autonoma: parte con Windows (nascosta) e resta in ascolto.
      const s = new Sentinella(jarvis);
      const esito = await s.avvia();
      if (esito === 'gia-attiva') { console.log('  La sentinella è già attiva in background.'); break; }
      if (esito !== true) throw new Error('La sorveglianza dei supporti funziona solo su Windows.');
      registroSuFile();
      registra(`Sentinella avviata · archivio ${cfg.archivio}`);
      console.log(`  ${C.g}● In ascolto.${C.x} Inserisci una scheda o una chiavetta, o copia file in Arrivi: ti chiederò cosa fare. (Ctrl+C per uscire)`);
      await jarvis.regista.avvia();
      jarvis.regista.server?.ref();
      await jarvis.stato(); // il pannello mostra subito l'archivio e gli ultimi arrivi
      jarvis.regista.on('evento', (e) => { if (e.t === 'fine') setTimeout(() => jarvis.stato().catch(() => {}), 1500); });
      await new Promise(() => {});
      break;
    }
    case 'supporti':
      for (const s of await jarvis.supporti()) {
        console.log(`  ${s.haDCIM ? C.g + '📷' : '  '} ${s.percorso}${C.x}  ${s.nome || ''}  ${C.d}${s.tipo}${s.libero ? ' · liberi ' + byteLeggibili(s.libero) : ''}${C.x}`);
      }
      break;
    case 'stato':
      console.log(JSON.stringify(await jarvis.stato(), null, 2));
      break;
    case 'pannello': {
      // Se la sentinella è già attiva in background, apro il suo pannello invece di avviarne un altro.
      const attivo = await fetch(`http://127.0.0.1:${cfg.porta}/`, { signal: AbortSignal.timeout(1500) })
        .then((r) => r.text()).then((t) => t.includes('J.A.R.V.I.S.')).catch(() => false);
      if (attivo) {
        await jarvis.regista.apriUrl(`http://127.0.0.1:${cfg.porta}/`);
        console.log('  Pannello della sentinella aperto nel browser.');
        break;
      }
      console.log(`  Pannello: ${await jarvis.regista.apri(true)}  (Ctrl+C per chiudere)`);
      await jarvis.stato();
      jarvis.regista.server?.ref();
      await new Promise(() => {});
      break;
    }
    default:
      console.log('  Comandi: importa <sorgente> [--sposta] · anteprima <sorgente> · backup [destinazione] [--completo]');
      console.log('           verifica [destinazione] [--profonda] · arrivi · annulla · simili · sorveglia');
      console.log('           diagnostica · supporti · stato · pannello');
  }
} catch (e) {
  console.error(`\n  ${C.r}✖ ${e.message}${C.x}`);
  process.exitCode = 1;
} finally {
  jarvis.regista.chiudi();
}
