// Tokenizzatore multilingue (modello "Unigram" in stile SentencePiece, quello di XLM-R e MiniLM multilingue).
// Trasforma una frase in numeri che il modello di intelligenza artificiale capisce. Scritto qui, senza librerie
// esterne, per tenere JARVIS leggero: legge il file tokenizer.json scaricato insieme al modello.
import fs from 'node:fs';

export class Tokenizzatore {
  /** @param {string} fileTokenizer percorso di tokenizer.json */
  constructor(fileTokenizer) {
    const t = JSON.parse(fs.readFileSync(fileTokenizer, 'utf8'));
    if (t.model?.type !== 'Unigram') throw new Error('tokenizer non supportato');
    this.pezzi = new Map();
    let minimo = 0;
    t.model.vocab.forEach(([pezzo, punteggio], id) => {
      if (!this.pezzi.has(pezzo)) this.pezzi.set(pezzo, [id, punteggio]);
      if (punteggio < minimo) minimo = punteggio;
    });
    this.idSconosciuto = t.model.unk_id ?? 3;
    this.punteggioSconosciuto = minimo - 10;
    this.lunghezzaMax = 0;
    for (const p of this.pezzi.keys()) this.lunghezzaMax = Math.max(this.lunghezzaMax, [...p].length);
    this.lunghezzaMax = Math.min(this.lunghezzaMax, 48);
    const speciale = (nome, predefinito) => t.added_tokens?.find((a) => a.content === nome)?.id ?? predefinito;
    this.inizio = speciale('<s>', 0);
    this.fine = speciale('</s>', 2);
    this.riempi = speciale('<pad>', 1);
  }

  // Divide una parola nei pezzi più probabili (algoritmo di Viterbi).
  #parola(parola) {
    const c = [...parola];
    const n = c.length;
    const migliore = new Array(n + 1).fill(-Infinity);
    const da = new Array(n + 1).fill(-1);
    const idDi = new Array(n + 1).fill(-1);
    migliore[0] = 0;
    for (let i = 0; i < n; i++) {
      if (migliore[i] === -Infinity) continue;
      let trovato = false;
      let pezzo = '';
      for (let j = i; j < Math.min(n, i + this.lunghezzaMax); j++) {
        pezzo += c[j];
        const v = this.pezzi.get(pezzo);
        if (!v) continue;
        if (j === i) trovato = true;
        const s = migliore[i] + v[1];
        if (s > migliore[j + 1]) { migliore[j + 1] = s; da[j + 1] = i; idDi[j + 1] = v[0]; }
      }
      if (!trovato) {
        const s = migliore[i] + this.punteggioSconosciuto;
        if (s > migliore[i + 1]) { migliore[i + 1] = s; da[i + 1] = i; idDi[i + 1] = this.idSconosciuto; }
      }
    }
    const ids = [];
    for (let k = n; k > 0; k = da[k]) ids.push(idDi[k]);
    ids.reverse();
    // più caratteri sconosciuti di fila diventano un solo <unk>, come fa SentencePiece
    return ids.filter((id, i) => !(id === this.idSconosciuto && ids[i - 1] === this.idSconosciuto));
  }

  /** Numeri della frase, con <s> all'inizio e </s> alla fine, portati alla lunghezza richiesta. */
  codifica(testo, lunghezza = 77) {
    const pulito = String(testo).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ');
    const ids = [this.inizio];
    for (const p of pulito.split(/\s+/).filter(Boolean)) ids.push(...this.#parola(`▁${p}`));
    ids.push(this.fine);
    if (ids.length > lunghezza) { ids.length = lunghezza; ids[lunghezza - 1] = this.fine; }
    const maschera = ids.map(() => 1);
    while (ids.length < lunghezza) { ids.push(this.riempi); maschera.push(0); }
    return { ids, maschera };
  }
}
