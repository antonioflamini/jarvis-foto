#!/usr/bin/env node
// Server MCP di JARVIS Foto per Claude Desktop.
// Gira sul tuo computer: le foto non passano mai da internet, Claude riceve solo i riepiloghi.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Jarvis, sintesi, VERSIONE } from './jarvis.js';
import { Sentinella } from './agenti/sentinella.js';
import { caricaConfig } from './config.js';
import { byteLeggibili } from './util.js';

const cfg = caricaConfig();
const jarvis = new Jarvis(cfg);
// Claude Desktop interrompe gli strumenti che durano troppo: oltre ~50 s il lavoro prosegue
// in background e Claude può chiedere a che punto è con jarvis_stato.
const ATTESA_MAX = 50000;

const server = new McpServer(
  { name: 'jarvis-foto', version: VERSIONE },
  {
    instructions:
      'JARVIS Foto archivia le foto e i video dell\'utente sul suo computer. Flusso consigliato: ' +
      '1) jarvis_rileva_supporti se l\'utente parla di chiavetta/scheda/telefono/disco senza dare un percorso; ' +
      '2) jarvis_anteprima per mostrare cosa succederà (consigliato per sorgenti grandi o se l\'utente chiede "sposta"); ' +
      '3) jarvis_importa; 4) jarvis_backup su hard disk esterno; 5) jarvis_verifica_backup. ' +
      'Per il telefono collegato col cavo (che non appare come unità) spiega di copiare le foto nella cartella Arrivi e poi usa jarvis_importa_arrivi. ' +
      'Se un risultato contiene "promemoria", riferiscilo all\'utente. Se ci sono foto in "Da scegliere", spiega che sono quasi uguali ad altre e vanno guardate. ' +
      'Se qualcosa non funziona sul PC usa jarvis_diagnostica. ' +
      'Se un lavoro risulta "in corso", usa jarvis_stato per aggiornare l\'utente. ' +
      'Modalità predefinita: copia (gli originali restano intatti). Usa "sposta" solo se l\'utente lo chiede esplicitamente. ' +
      'Rispondi all\'utente in italiano, in modo breve, come un assistente alla JARVIS.',
  },
);

const testo = (dati) => ({ content: [{ type: 'text', text: typeof dati === 'string' ? dati : JSON.stringify(dati, null, 2) }] });
const errore = (e) => ({ content: [{ type: 'text', text: `Errore: ${e.message || e}` }], isError: true });
const sicuro = (fn) => async (args) => { try { return await fn(args || {}); } catch (e) { return errore(e); } };

server.registerTool('jarvis_stato', {
  title: 'Stato di JARVIS',
  description: 'Mostra lo stato dell\'archivio foto (quante foto/video per anno, spazio), l\'eventuale lavoro in corso con il suo avanzamento, l\'ultima importazione e l\'ultimo backup.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, sicuro(async () => testo(await jarvis.stato())));

server.registerTool('jarvis_rileva_supporti', {
  title: 'Rileva supporti collegati',
  description: 'Elenca le unità collegate al computer (chiavette, schede SD, hard disk esterni, telefoni montati come unità) indicando quali contengono una cartella DCIM di foto.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, sicuro(async () => {
  const s = await jarvis.supporti();
  return testo(s.map((x) => ({ ...x, dimensione: x.dimensione ? byteLeggibili(x.dimensione) : null, libero: x.libero ? byteLeggibili(x.libero) : null })));
}));

server.registerTool('jarvis_anteprima', {
  title: 'Anteprima importazione',
  description: 'Simula un\'importazione senza toccare nulla: quante foto nuove, quanti doppioni, periodo coperto, distribuzione per mese, giornate speciali e alcuni esempi di nuovi nomi.',
  inputSchema: { sorgente: z.string().describe('Cartella, file .zip o lettera di unità (es. "E:", "C:\\Users\\Antonio\\Downloads\\foto.zip")') },
  annotations: { readOnlyHint: true },
}, sicuro(async ({ sorgente }) => testo(await jarvis.anteprima(sorgente))));

server.registerTool('jarvis_importa', {
  title: 'Importa e archivia foto',
  description: 'Prende foto e video da una cartella, uno zip (anche annidato) o un supporto, legge la data vera di scatto, scarta i doppioni, rinomina (AAAA-MM-GG_HH-MM-SS_dispositivo) e archivia in Foto/Anno/Mese (con cartelle dedicate per le giornate con molte foto), Video/… e Screenshot/…. Apre il pannello olografico sul PC. Predefinito: copia, gli originali restano intatti.',
  inputSchema: {
    sorgente: z.string().describe('Cartella, file .zip o lettera di unità da cui prendere le foto'),
    modalita: z.enum(['copia', 'sposta']).optional().describe('"copia" (predefinito, sicuro) oppure "sposta" (cancella dalla sorgente dopo copia verificata; i doppioni vanno in _JARVIS/Doppioni)'),
    effetti: z.boolean().optional().describe('Mostra il pannello olografico (predefinito: impostazione dell\'utente)'),
  },
}, sicuro(async ({ sorgente, modalita, effetti }) => testo(sintesi(await jarvis.importa(sorgente, { modalita, effetti, attesaMax: ATTESA_MAX })))));

server.registerTool('jarvis_backup', {
  title: 'Backup su disco esterno',
  description: 'Crea o aggiorna il backup zippato dell\'archivio su un hard disk esterno: uno zip per mese, solo i mesi cambiati (incrementale), ogni zip verificato prima di sostituire il precedente. Non cancella mai foto dal backup.',
  inputSchema: {
    destinazione: z.string().optional().describe('Unità o cartella del disco esterno (es. "F:" o "F:\\Backup"). Se omessa usa quella impostata.'),
    completo: z.boolean().optional().describe('true = riscrive tutti gli zip anche se invariati'),
  },
}, sicuro(async ({ destinazione, completo }) => testo(sintesi(await jarvis.backup({ destinazione: destinazione && /^[a-zA-Z]:$/.test(destinazione) ? `${destinazione}\\` : destinazione, completo, attesaMax: ATTESA_MAX })))));

server.registerTool('jarvis_verifica_backup', {
  title: 'Verifica il backup',
  description: 'Controlla che gli zip del backup siano leggibili e completi. Con profonda=true ricalcola l\'impronta di ogni foto e la confronta con l\'archivio (più lento, massima sicurezza). Segnala anche i mesi non ancora salvati.',
  inputSchema: {
    destinazione: z.string().optional().describe('Unità o cartella del disco esterno con il backup'),
    profonda: z.boolean().optional(),
  },
  annotations: { readOnlyHint: true },
}, sicuro(async ({ destinazione, profonda }) => testo(sintesi(await jarvis.verifica({ destinazione: destinazione && /^[a-zA-Z]:$/.test(destinazione) ? `${destinazione}\\` : destinazione, profonda, attesaMax: ATTESA_MAX })))));

server.registerTool('jarvis_dai_nome_giornata', {
  title: 'Dai un nome a una giornata',
  description: 'Dà un nome a un giorno dell\'archivio, es. 2025-08-14 → "2025-08-14 Giovedì - Ferragosto al mare". Se le foto di quel giorno sono sciolte nel mese, crea la cartella e ce le sposta. Le importazioni future di quel giorno finiranno nella stessa cartella.',
  inputSchema: {
    giorno: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data nel formato AAAA-MM-GG'),
    descrizione: z.string().min(1).max(60).describe('Nome dell\'evento, es. "Raccolta AVIS" o "Compleanno Angelica"'),
  },
}, sicuro(async ({ giorno, descrizione }) => testo(await jarvis.rinominaGiornata(giorno, descrizione))));

server.registerTool('jarvis_apri_pannello', {
  title: 'Apri il pannello olografico',
  description: 'Apre nel browser del PC il pannello di JARVIS con le statistiche dell\'archivio.',
  inputSchema: {},
}, sicuro(async () => {
  const url = await jarvis.regista.apri(true);
  await jarvis.stato();
  return testo(url ? `Pannello aperto: ${url}` : 'Non riesco ad aprire il pannello.');
}));

server.registerTool('jarvis_ricostruisci_indice', {
  title: 'Ricostruisci indice doppioni',
  description: 'Ricalcola l\'impronta di tutti i file dell\'archivio. Da usare se l\'utente ha aggiunto o tolto foto a mano nell\'archivio.',
  inputSchema: {},
}, sicuro(async () => testo(await jarvis.ricostruisciIndice())));

server.registerTool('jarvis_importa_arrivi', {
  title: 'Sistema la cartella Arrivi',
  description: 'Prende tutto quello che c\'è nella cartella Arrivi dell\'archivio (foto, cartelle, zip, esportazioni di Google Foto o del telefono), lo mette in ordine nell\'archivio e svuota Arrivi. I file vengono spostati con verifica; zip elaborati e file non riconosciuti vanno in _JARVIS, mai cancellati.',
  inputSchema: {},
}, sicuro(async () => testo(sintesi(await jarvis.importaArrivi({ attesaMax: ATTESA_MAX })))));

server.registerTool('jarvis_annulla_ultima_importazione', {
  title: 'Annulla l\'ultima importazione',
  description: 'Annulla l\'ultima importazione: i file spostati tornano dov\'erano, le copie vengono messe da parte in _JARVIS/Annullati (gli originali esistono ancora). Chiedi conferma all\'utente prima di usarlo.',
  inputSchema: {},
  annotations: { destructiveHint: true },
}, sicuro(async () => testo(await jarvis.annullaUltimaImportazione())));

server.registerTool('jarvis_da_scegliere', {
  title: 'Foto quasi uguali da scegliere',
  description: 'Elenca i gruppi di foto quasi uguali (copie ridotte, raffiche) messi nella cartella "Da scegliere", con la foto a cui somigliano.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, sicuro(async () => testo(await jarvis.daScegliere())));

server.registerTool('jarvis_diagnostica', {
  title: 'Diagnostica',
  description: 'Controlla l\'installazione sul PC: scrittura nell\'archivio, spazio libero, pannello, voci della sintesi vocale, sentinella, supporti, disco del backup.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, sicuro(async () => testo(await jarvis.diagnostica())));

await server.connect(new StdioServerTransport());

// La sentinella chiede se importare quando inserisci una scheda o una chiavetta (e se aggiornare il backup).
if (cfg.sorveglianza) {
  const sentinella = new Sentinella(jarvis);
  const esito = await sentinella.avvia();
  jarvis.sentinellaAttiva = esito === true;
  if (esito === 'gia-attiva') jarvis.sentinellaAltrove = true;
}
console.error(`[jarvis-foto] ${VERSIONE} pronto · archivio: ${cfg.archivio}${jarvis.sentinellaAttiva ? ' · sentinella attiva' : ''}`);
