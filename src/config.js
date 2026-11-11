// Configurazione di JARVIS Foto.
// Ordine di priorità: variabili d'ambiente (impostate da Claude Desktop) > jarvis.config.json > valori predefiniti.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RADICE_PROGETTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function leggiFileConfig() {
  const file = path.join(RADICE_PROGETTO, 'jarvis.config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function siNo(valore, predefinito) {
  if (valore === undefined || valore === null || valore === '') return predefinito;
  if (typeof valore === 'boolean') return valore;
  return !['false', 'no', '0', 'off'].includes(String(valore).trim().toLowerCase());
}

// Claude Desktop sostituisce i campi vuoti con stringhe tipo "${user_config.x}" se non compilati: li ignoriamo.
function pulito(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t || t.startsWith('${')) return undefined;
  return t;
}

export function caricaConfig(sovrascritture = {}) {
  const f = leggiFileConfig();
  const env = process.env;
  const archivio =
    pulito(sovrascritture.archivio) ??
    pulito(env.JARVIS_ARCHIVIO) ??
    pulito(f.archivio) ??
    path.join(os.homedir(), 'Pictures', 'JARVIS_Foto');
  const radice = path.resolve(archivio);
  return {
    archivio: radice,
    // La cartella Arrivi può stare su un altro disco (es. sul PC quando l'archivio è su un disco esterno)
    arrivi: path.resolve(pulito(sovrascritture.arrivi) ?? pulito(env.JARVIS_ARRIVI) ?? pulito(f.arrivi) ?? path.join(radice, 'Arrivi')),
    backup: pulito(sovrascritture.backup) ?? pulito(env.JARVIS_BACKUP) ?? pulito(f.backup) ?? '',
    effetti: siNo(sovrascritture.effetti ?? pulito(env.JARVIS_EFFETTI) ?? f.effetti, true),
    voce: siNo(sovrascritture.voce ?? pulito(env.JARVIS_VOCE) ?? f.voce, true),
    nome: pulito(sovrascritture.nome) ?? pulito(env.JARVIS_NOME) ?? pulito(f.nome) ?? '',
    // Foto quasi uguali in "Da scegliere"
    simili: siNo(sovrascritture.simili ?? pulito(env.JARVIS_SIMILI) ?? f.simili, true),
    // Chiede se importare quando inserisci una scheda/chiavetta (solo Windows)
    sorveglianza: siNo(sovrascritture.sorveglianza ?? pulito(env.JARVIS_SORVEGLIANZA) ?? f.sorveglianza, true),
    porta: Number(pulito(env.JARVIS_PORTA) ?? f.porta ?? 7777) || 7777,
    // Quante foto nello stesso giorno servono per creare una cartella "giornata" dedicata
    sogliaGiornata: Number(pulito(env.JARVIS_SOGLIA_GIORNATA) ?? f.sogliaGiornata ?? 12) || 12,
  };
}
