// VOLTI: trova i volti nelle foto (YuNet, licenza MIT) e ne calcola l'impronta (SFace, licenza Apache 2.0),
// i modelli ufficiali di OpenCV. Poi raggruppa i volti simili: tu dai un nome a un gruppo e JARVIS
// ritrova quella persona in tutte le foto. Tutto avviene sul computer.

const LATO_RIL = 640; // YuNet lavora su un'immagine 640×640
const PASSI = [8, 16, 32];
// Posizione "standard" di occhi, naso e angoli della bocca in un volto 112×112 (quella usata da SFace/ArcFace)
const MODELLO_PUNTI = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
export const SOGLIA_STESSA_PERSONA = 0.45; // somiglianza (coseno) oltre la quale due volti sono la stessa persona

/**
 * Prepara l'ingresso di YuNet: immagine ridotta dentro 640×640 (bordo nero a destra/sotto), in BGR 0-255.
 * @param {Buffer} rgb pixel RGB già ridotti in modo che il lato lungo sia 640
 */
export function ingressoRilevatore(rgb, w, h) {
  const n = LATO_RIL * LATO_RIL;
  const t = new Float32Array(3 * n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      const d = y * LATO_RIL + x;
      t[d] = rgb[s + 2]; t[n + d] = rgb[s + 1]; t[2 * n + d] = rgb[s];
    }
  }
  return t;
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return i / (a.w * a.h + b.w * b.h - i || 1);
}

/** Decodifica le uscite di YuNet in volti {x,y,w,h,punteggio,punti[5][2]} nelle coordinate 640. */
export function decodificaVolti(uscite, sogliaPunteggio = 0.85) {
  const trovati = [];
  for (const s of PASSI) {
    const cls = uscite[`cls_${s}`].data, obj = uscite[`obj_${s}`].data;
    const box = uscite[`bbox_${s}`].data, kps = uscite[`kps_${s}`].data;
    const colonne = LATO_RIL / s;
    for (let i = 0; i < cls.length; i++) {
      const punteggio = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
      if (punteggio < sogliaPunteggio) continue;
      const r = Math.floor(i / colonne), c = i % colonne;
      const cx = (c + box[i * 4]) * s, cy = (r + box[i * 4 + 1]) * s;
      const w = Math.exp(box[i * 4 + 2]) * s, h = Math.exp(box[i * 4 + 3]) * s;
      const punti = [];
      for (let k = 0; k < 5; k++) punti.push([(kps[i * 10 + 2 * k] + c) * s, (kps[i * 10 + 2 * k + 1] + r) * s]);
      trovati.push({ x: cx - w / 2, y: cy - h / 2, w, h, punteggio, punti });
    }
  }
  trovati.sort((a, b) => b.punteggio - a.punteggio);
  const tenuti = [];
  for (const v of trovati) if (tenuti.every((t) => iou(t, v) < 0.3)) tenuti.push(v);
  return tenuti;
}

/** Trasformazione di similitudine (scala, rotazione, spostamento) che porta i punti del volto su quelli standard. */
export function trasformazione(src, dst = MODELLO_PUNTI) {
  const n = src.length;
  let mx = 0, my = 0, nx = 0, ny = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; nx += dst[i][0]; ny += dst[i][1]; }
  mx /= n; my /= n; nx /= n; ny /= n;
  let a = 0, b = 0, v = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - mx, sy = src[i][1] - my, dx = dst[i][0] - nx, dy = dst[i][1] - ny;
    a += sx * dx + sy * dy;
    b += sx * dy - sy * dx;
    v += sx * sx + sy * sy;
  }
  const ka = a / v, kb = b / v; // x' = ka*x - kb*y + tx ; y' = kb*x + ka*y + ty
  return { ka, kb, tx: nx - (ka * mx - kb * my), ty: ny - (kb * mx + ka * my) };
}

/**
 * Ritaglia il volto raddrizzato 112×112 (interpolazione bilineare) e lo prepara per SFace (RGB 0-255).
 * @param {Buffer} rgb pixel dell'immagine (larghezza w, altezza h)
 */
export function voltoAllineato(rgb, w, h, punti) {
  const { ka, kb, tx, ty } = trasformazione(punti);
  // inversa: dall'uscita (u,v) all'immagine (x,y)
  const det = ka * ka + kb * kb;
  const n = 112 * 112;
  const t = new Float32Array(3 * n);
  for (let v = 0; v < 112; v++) {
    for (let u = 0; u < 112; u++) {
      const du = u - tx, dv = v - ty;
      const x = (ka * du + kb * dv) / det, y = (-kb * du + ka * dv) / det;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      for (let c = 0; c < 3; c++) {
        const px = (xx, yy) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : rgb[(yy * w + xx) * 3 + c]);
        const val = px(x0, y0) * (1 - fx) * (1 - fy) + px(x0 + 1, y0) * fx * (1 - fy) + px(x0, y0 + 1) * (1 - fx) * fy + px(x0 + 1, y0 + 1) * fx * fy;
        t[c * n + v * 112 + u] = val;
      }
    }
  }
  return t;
}

export function normalizza(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return Float32Array.from(v, (x) => x / s);
}

/**
 * Raggruppa i volti simili (ogni volto va nel gruppo col centro più vicino, se abbastanza simile).
 * @param {{id:string, e:Float32Array}[]} volti
 * @param {{id:string, nome?:string, centro:Float32Array, n:number}[]} gruppi gruppi esistenti (modificati sul posto)
 * @returns {Map<string,string>} volto → gruppo
 */
export function raggruppa(volti, gruppi, soglia = SOGLIA_STESSA_PERSONA) {
  const assegnati = new Map();
  let prossimo = gruppi.reduce((m, g) => Math.max(m, Number(String(g.id).replace(/\D/g, '')) || 0), 0) + 1;
  for (const v of volti) {
    let migliore = null, s = -1;
    for (const g of gruppi) {
      let d = 0;
      for (let i = 0; i < 128; i++) d += g.centro[i] * v.e[i];
      if (d > s) { s = d; migliore = g; }
    }
    if (migliore && s >= soglia) {
      // il centro si sposta un poco verso il nuovo volto
      const k = 1 / (migliore.n + 1);
      migliore.centro = normalizza(migliore.centro.map((x, i) => x * (1 - k) + v.e[i] * k));
      migliore.n++;
      assegnati.set(v.id, migliore.id);
    } else {
      const g = { id: `p${prossimo++}`, centro: Float32Array.from(v.e), n: 1 };
      gruppi.push(g);
      assegnati.set(v.id, g.id);
    }
  }
  return assegnati;
}
