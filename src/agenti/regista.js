// AGENTE REGISTA
// Pannello olografico in tempo reale (pagina locale nel browser, http://127.0.0.1:7777) e voce di JARVIS.
// Il pannello serve solo il computer stesso (127.0.0.1): nessuno dalla rete può vederlo.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { miniaturaEXIF } from './simili.js';

const PAGINA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hud', 'index.html');
const FONT = path.join(path.dirname(PAGINA), 'font');
const DIRETTE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp']);

export class Regista extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.client = new Set();
    this.miniature = new Map();
    this.prossimoId = 1;
    this.stato = { t: 'stato', lavoro: null, archivio: cfg.archivio, nome: cfg.nome };
    this.server = null;
    this.url = null;
    this.ultimaApertura = 0;
    this.estensioni = []; // altre pagine del pannello (es. galleria): (url, richiesta, risposta) => true se gestita
  }

  async avvia() {
    if (this.server) return this.url;
    for (let porta = this.cfg.porta; porta < this.cfg.porta + 15; porta++) {
      try {
        await new Promise((resolve, reject) => {
          const s = http.createServer((q, r) => this.#gestisci(q, r));
          s.once('error', reject);
          s.listen(porta, '127.0.0.1', () => { this.server = s; resolve(); });
        });
        this.url = `http://127.0.0.1:${porta}/`;
        this.server.unref();
        return this.url;
      } catch { /* porta occupata: provo la successiva */ }
    }
    return null;
  }

  async #gestisci(q, r) {
    const u = new URL(q.url, 'http://x');
    for (const estensione of this.estensioni) {
      try {
        if (await estensione(u, q, r)) return;
      } catch { /* l'estensione ha già risposto o non era sua */ }
    }
    if (u.pathname === '/') {
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return fs.createReadStream(PAGINA).pipe(r);
    }
    const font = u.pathname.match(/^\/font\/([a-z0-9-]+\.woff2)$/);
    if (font && fs.existsSync(path.join(FONT, font[1]))) {
      r.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=86400' });
      return fs.createReadStream(path.join(FONT, font[1])).pipe(r);
    }
    if (u.pathname === '/eventi') {
      r.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      r.write(`data: ${JSON.stringify(this.stato)}\n\n`);
      this.client.add(r);
      const battito = setInterval(() => r.write(': battito\n\n'), 15000);
      q.on('close', () => { clearInterval(battito); this.client.delete(r); });
      return;
    }
    if (u.pathname.startsWith('/miniatura/')) {
      const file = this.miniature.get(Number(u.pathname.split('/')[2]));
      if (!file) { r.writeHead(404); return r.end(); }
      try {
        const ext = path.extname(file).toLowerCase();
        const anteprima = await miniaturaEXIF(file);
        if (anteprima?.length) {
          r.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
          return r.end(Buffer.from(anteprima));
        }
        const st = await fsp.stat(file);
        if (DIRETTE.has(ext) && st.size < 30 * 1024 * 1024) {
          r.writeHead(200, { 'content-type': ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' });
          return fs.createReadStream(file).pipe(r);
        }
      } catch { /* niente anteprima */ }
      r.writeHead(404);
      return r.end();
    }
    r.writeHead(404);
    r.end();
  }

  registraMiniatura(file) {
    const id = this.prossimoId++;
    this.miniature.set(id, file);
    if (this.miniature.size > 3000) this.miniature.delete(this.miniature.keys().next().value);
    return id;
  }

  emetti(evento) {
    if (evento.t === 'inizio') this.stato = { ...this.stato, lavoro: evento, ultimo: null };
    if (evento.t === 'fine') this.stato = { ...this.stato, lavoro: null, ultimo: evento };
    if (evento.t === 'archivio') this.stato = { ...this.stato, statistiche: evento.statistiche, recenti: evento.recenti };
    const riga = `data: ${JSON.stringify(evento)}\n\n`;
    for (const c of this.client) c.write(riga);
    this.emit('evento', evento);
  }

  // Apre il pannello nel browser se non è già aperto.
  async apri(forza = false) {
    const url = await this.avvia();
    if (!url) return null;
    if (!forza && (this.client.size > 0 || Date.now() - this.ultimaApertura < 20000)) return url;
    this.ultimaApertura = Date.now();
    return this.apriUrl(url);
  }

  async apriUrl(url) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try {
      spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
    } catch { /* nessun browser disponibile */ }
    return url;
  }

  async attendiClient(ms = 4000) {
    const fine = Date.now() + ms;
    while (this.client.size === 0 && Date.now() < fine) await new Promise((r) => setTimeout(r, 150));
    return this.client.size > 0;
  }

  // Voce di JARVIS: usa la sintesi vocale di Windows (voce italiana se installata) o "say" su Mac.
  parla(testo) {
    if (!this.cfg.voce || !testo) return;
    try {
      if (process.platform === 'win32') {
        const t = testo.replace(/'/g, "''");
        const script = "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer;" +
          "$v=$s.GetInstalledVoices()|Where-Object{$_.VoiceInfo.Culture.Name -like 'it*'}|Select-Object -First 1;" +
          `if($v){$s.SelectVoice($v.VoiceInfo.Name)}; $s.Rate=1; $s.Speak('${t}')`;
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true, detached: true })
          .on('error', () => {}).unref();
      } else if (process.platform === 'darwin') {
        spawn('say', ['-v', 'Alice', testo], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      }
    } catch { /* voce non disponibile */ }
  }

  chiudi() {
    for (const c of this.client) c.end();
    this.server?.close();
    this.server = null;
  }
}
