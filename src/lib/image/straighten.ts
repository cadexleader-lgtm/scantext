import { compH, compW, extractRuns, inkMask, labelRuns, typicalCharHeight, type Component } from "./components";
import { rgbaToGray } from "./detect";
import { adaptiveThreshold, normalizeBackground, type RGBAImage } from "./ops";

/**
 * Redressement des lignes de texte : inclinaison et courbure.
 *
 * Même recadrée, une feuille photographiée a souvent des lignes légèrement
 * penchées ou bombées (page tenue à la main, livre ouvert, feuille gondolée).
 * Le moteur de reconnaissance fusionne alors deux lignes voisines et lit des
 * mots sans queue ni tête. Ici, les lignes de texte sont repérées sur la page
 * (caractères voisins enchaînés), chacune est modélisée par une courbe, puis
 * l'image est redressée :
 *  - une rotation corrige l'inclinaison générale ;
 *  - un champ de déplacement vertical, interpolé entre les lignes, aplatit la
 *    courbure restante.
 * Sans lignes de texte fiables (photo, schéma, page presque vide), l'image est
 * laissée telle quelle.
 */

export interface StraightenModel {
  /** Inclinaison générale (radians, positive = lignes qui descendent vers la droite). */
  angle: number;
  /** Déplacement vertical, en fraction de la hauteur, sur une grille gw × gh (null = pas de courbure). */
  field: Float32Array | null;
  gw: number;
  gh: number;
  /** Nombre de lignes de texte utilisées. */
  lines: number;
}

const ANALYSIS_SIDE = 1600;

interface Char {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  cx: number;
  cy: number;
  h: number;
}

interface Chain {
  x0: number;
  x1: number;
  pts: { x: number; y: number }[];
}

/** Réduction par moyenne de blocs (analyse plus rapide, sans crénelage). */
function downscaleGray(gray: Uint8ClampedArray, w: number, h: number, f: number): { g: Uint8ClampedArray; w: number; h: number } {
  if (f <= 1) return { g: gray, w, h };
  const nw = Math.max(1, Math.floor(w / f));
  const nh = Math.max(1, Math.floor(h / f));
  const sum = new Float32Array(nw * nh);
  const cnt = new Float32Array(nw * nh);
  for (let y = 0; y < h; y++) {
    const yy = Math.min(nh - 1, Math.floor(y / f));
    for (let x = 0; x < w; x++) {
      const i = yy * nw + Math.min(nw - 1, Math.floor(x / f));
      sum[i] += gray[y * w + x];
      cnt[i]++;
    }
  }
  const g = new Uint8ClampedArray(nw * nh);
  for (let i = 0; i < g.length; i++) g[i] = sum[i] / cnt[i];
  return { g, w: nw, h: nh };
}

/** Moindres carrés y = a + b·t + c·t² (t normalisé), avec rejet des points aberrants. */
function fitCurve(pts: { x: number; y: number }[], degree: 1 | 2, tol: number): { coef: number[]; mid: number; half: number; rms: number } | null {
  let use = pts;
  const xs = pts.map((p) => p.x);
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  const half = Math.max(1, (Math.max(...xs) - Math.min(...xs)) / 2);
  let coef: number[] = [];
  for (let pass = 0; pass < 3; pass++) {
    const n = degree + 1;
    const A = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
    for (const p of use) {
      const t = (p.x - mid) / half;
      const pw = [1, t, t * t];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) A[i][j] += pw[i] * pw[j];
        A[i][n] += pw[i] * p.y;
      }
    }
    // élimination de Gauss
    for (let i = 0; i < n; i++) {
      let piv = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
      [A[i], A[piv]] = [A[piv], A[i]];
      if (Math.abs(A[i][i]) < 1e-9) return null;
      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const f = A[r][i] / A[i][i];
        for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c];
      }
    }
    coef = A.map((row, i) => row[n] / row[i]);
    if (degree === 1) coef.push(0);
    const kept = use.filter((p) => Math.abs(evalCurve(coef, mid, half, p.x) - p.y) <= tol);
    if (kept.length === use.length || kept.length < 6) break;
    use = kept;
  }
  let se = 0;
  for (const p of use) se += (evalCurve(coef, mid, half, p.x) - p.y) ** 2;
  return { coef, mid, half, rms: Math.sqrt(se / use.length) };
}

function evalCurve(coef: number[], mid: number, half: number, x: number): number {
  const t = (x - mid) / half;
  return coef[0] + coef[1] * t + coef[2] * t * t;
}

/** Enchaîne les caractères voisins en lignes de texte. */
function chainChars(chars: Char[], charH: number): Chain[] {
  const cell = Math.max(4, Math.round(2 * charH));
  const buckets = new Map<number, number[]>();
  const key = (gx: number, gy: number) => gy * 100_000 + gx;
  chars.forEach((c, i) => {
    const k = key(Math.floor(c.x0 / cell), Math.floor(c.cy / cell));
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(i);
  });
  const next = new Int32Array(chars.length).fill(-1);
  const nextScore = new Float64Array(chars.length).fill(Infinity);
  const prev = new Int32Array(chars.length).fill(-1);
  const prevScore = new Float64Array(chars.length).fill(Infinity);
  const maxGap = 1.3 * charH;
  chars.forEach((a, i) => {
    const gx0 = Math.floor(a.x1 / cell) - 1;
    const gy = Math.floor(a.cy / cell);
    for (let gx = gx0; gx <= gx0 + 2; gx++)
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of buckets.get(key(gx, gy + dy)) ?? []) {
          if (j === i) continue;
          const b = chars[j];
          if (b.cx <= a.cx) continue;
          const gap = b.x0 - a.x1;
          const dyc = Math.abs(b.cy - a.cy);
          // même ligne : les deux caractères se recouvrent verticalement (zone des minuscules),
          // même si l'un monte (l, d) et l'autre descend (p, g)
          const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          if (gap > maxGap || gap < -0.4 * charH || dyc > 0.7 * charH || overlap < 0.45 * Math.min(a.h, b.h)) continue;
          const score = Math.max(0, gap) + 3 * dyc;
          if (score < nextScore[i]) {
            nextScore[i] = score;
            next[i] = j;
          }
        }
      }
  });
  // chaque caractère n'a qu'un prédécesseur : le plus proche
  chars.forEach((_, i) => {
    const j = next[i];
    if (j >= 0 && nextScore[i] < prevScore[j]) {
      if (prev[j] >= 0) next[prev[j]] = -1;
      prev[j] = i;
      prevScore[j] = nextScore[i];
    } else if (j >= 0) next[i] = -1;
  });
  const chains: Chain[] = [];
  chars.forEach((_, i) => {
    if (prev[i] >= 0) return;
    const members: Char[] = [];
    for (let k = i; k >= 0 && members.length < 5000; k = next[k]) members.push(chars[k]);
    if (members.length < 8) return;
    const x0 = Math.min(...members.map((m) => m.x0));
    const x1 = Math.max(...members.map((m) => m.x1));
    if (x1 - x0 < 8 * charH) return;
    // les caractères de hauteur « minuscule » donnent une position fiable de la ligne
    const core = members.filter((m) => m.h >= 0.75 * charH && m.h <= 1.3 * charH);
    const src = core.length >= 6 ? core : members;
    chains.push({ x0, x1, pts: src.map((m) => ({ x: m.cx, y: m.cy })) });
  });
  return chains;
}

/**
 * Recolle les morceaux d'une même ligne de texte (coupée par un espace large,
 * une lettre abîmée…) : deux morceaux voisins dont les courbes se prolongent.
 */
function mergeChains(chains: Chain[], charH: number): Chain[] {
  const fitOf = (c: Chain) => fitCurve(c.pts, c.x1 - c.x0 >= 15 * charH ? 2 : 1, 0.3 * charH);
  type Item = { c: Chain; f: NonNullable<ReturnType<typeof fitCurve>> };
  let list: Item[] = chains.map((c) => ({ c, f: fitOf(c) })).filter((x): x is Item => !!x.f);
  const at = (it: Item, x: number) => evalCurve(it.f.coef, it.f.mid, it.f.half, x);
  const slope = (it: Item, x: number) => (at(it, x + 1) - at(it, x - 1)) / 2;
  for (let changed = true; changed; ) {
    changed = false;
    list.sort((a, b) => a.c.x0 - b.c.x0);
    for (let i = 0; i < list.length && !changed; i++) {
      const A = list[i];
      let best = -1;
      let bestGap = Infinity;
      for (let j = 0; j < list.length; j++) {
        const B = list[j];
        if (j === i || B.c.x0 <= A.c.x0 || B.c.x1 <= A.c.x1) continue;
        const gap = B.c.x0 - A.c.x1;
        if (gap > 6 * charH || gap < -2 * charH) continue;
        const ya = at(A, A.c.x1);
        const yb = at(B, B.c.x0);
        if (Math.abs(ya - yb) > 0.8 * charH) continue;
        const xm = (A.c.x1 + B.c.x0) / 2;
        const pa = ya + slope(A, A.c.x1) * (xm - A.c.x1);
        const pb = yb + slope(B, B.c.x0) * (xm - B.c.x0);
        if (Math.abs(pa - pb) > 0.35 * charH) continue;
        if (gap < bestGap) {
          bestGap = gap;
          best = j;
        }
      }
      if (best < 0) continue;
      const B = list[best];
      const merged: Chain = { x0: A.c.x0, x1: Math.max(A.c.x1, B.c.x1), pts: [...A.c.pts, ...B.c.pts] };
      const f = fitOf(merged);
      if (!f || f.rms > 0.22 * charH) continue;
      list = list.filter((_, k) => k !== i && k !== best);
      list.push({ c: merged, f });
      changed = true;
    }
  }
  return list.map((it) => it.c);
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** Lignes de texte repérées et modélisées (courbe par ligne). */
function fitTextLines(comps: Component[], charH: number) {
  const chars: Char[] = comps
    .filter((c) => {
      const ch = compH(c);
      // les lettres soudées (mot entier d'un seul tenant) indiquent aussi la position de la ligne
      return ch >= 0.5 * charH && ch <= 2.2 * charH && compW(c) <= 10 * charH && c.area >= 3;
    })
    .map((c) => ({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, cx: (c.x0 + c.x1) / 2, cy: (c.y0 + c.y1) / 2, h: compH(c) }));
  if (chars.length < 8) return [];
  return mergeChains(chainChars(chars, charH), charH)
    .map((ch) => {
      const span = ch.x1 - ch.x0;
      const fit = fitCurve(ch.pts, span >= 15 * charH ? 2 : 1, 0.3 * charH);
      return fit && fit.rms <= 0.22 * charH ? { ...ch, ...fit, span } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

/**
 * Nombre de lignes de texte crédibles (caractères alignés) : distingue une
 * page de texte d'une photo, d'un dessin ou d'une image bruitée.
 */
export function countTextLines(comps: Component[], charH: number): number {
  return fitTextLines(comps, charH).length;
}

/** Analyse la page et renvoie le modèle de redressement (null si rien à corriger). */
export function estimateStraighten(img: RGBAImage): StraightenModel | null {
  const { width: W, height: H } = img;
  const f = Math.max(1, Math.max(W, H) / ANALYSIS_SIDE);
  const { g, w, h } = downscaleGray(rgbaToGray(img.data, W, H), W, H, f);
  const mask = inkMask(adaptiveThreshold(normalizeBackground(g, w, h), w, h));
  const lab = labelRuns(extractRuns(mask, w, h));
  const charH = typicalCharHeight(lab.comps, h);
  if (!charH || charH < 4) return null;
  const fits = fitTextLines(lab.comps, charH);
  if (fits.length < 3) return null;

  // inclinaison générale : pente médiane au centre des lignes, pondérée par leur longueur
  const slopes: number[] = [];
  for (const ft of fits) {
    const slope = ft.coef[1] / ft.half;
    for (let k = 0; k < Math.max(1, Math.round(ft.span / (10 * charH))); k++) slopes.push(slope);
  }
  let angle = Math.atan(median(slopes));
  if (Math.abs(angle) > (15 * Math.PI) / 180) return null; // texte tourné : hors de portée
  if (Math.abs(angle) < (0.05 * Math.PI) / 180) angle = 0;

  // lignes dans le repère redressé (rotation inverse autour du centre)
  const cx = w / 2;
  const cy = h / 2;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const rot = (p: { x: number; y: number }) => ({
    x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
    y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
  });
  const lines = fits
    .map((ft) => {
      const pts = ft.pts.map(rot);
      const fit = fitCurve(pts, ft.span >= 15 * charH ? 2 : 1, 0.3 * charH);
      if (!fit) return null;
      const xs = pts.map((p) => p.x);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      let mean = 0;
      for (let k = 0; k <= 20; k++) mean += evalCurve(fit.coef, fit.mid, fit.half, x0 + ((x1 - x0) * k) / 20) / 21;
      return { x0, x1, fit, yref: mean };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => a.yref - b.yref);

  // champ de déplacement sur une grille (pas ≈ 2 hauteurs de caractère)
  const step = Math.max(4, 2 * charH);
  const gw = Math.max(2, Math.ceil(w / step) + 1);
  const gh = Math.max(2, Math.ceil(h / step) + 1);
  const field = new Float32Array(gw * gh);
  const has = new Uint8Array(gw);
  let maxDev = 0;
  for (let gx = 0; gx < gw; gx++) {
    const x = (gx / (gw - 1)) * w;
    const reach = 8 * charH;
    const col = lines
      .filter((l) => x >= l.x0 - reach && x <= l.x1 + reach)
      .map((l) => {
        // au-delà de la ligne : prolongement selon la pente de son extrémité
        const xc = Math.min(l.x1, Math.max(l.x0, x));
        const y = (t: number) => evalCurve(l.fit.coef, l.fit.mid, l.fit.half, t);
        const slope = xc === x ? 0 : (y(xc + 1) - y(xc - 1)) / 2;
        return { y: l.yref, d: y(xc) + slope * (x - xc) - l.yref };
      });
    if (col.length < 2) continue;
    // médiane glissante : une ligne mal estimée ne déforme pas ses voisines
    const ds = col.map((c, i) => median([col[Math.max(0, i - 1)].d, c.d, col[Math.min(col.length - 1, i + 1)].d]));
    has[gx] = 1;
    for (let gy = 0; gy < gh; gy++) {
      const y = (gy / (gh - 1)) * h;
      let d: number;
      if (y <= col[0].y) d = ds[0];
      else if (y >= col[col.length - 1].y) d = ds[col.length - 1];
      else {
        let k = 1;
        while (col[k].y < y) k++;
        const t = (y - col[k - 1].y) / Math.max(1e-6, col[k].y - col[k - 1].y);
        d = ds[k - 1] * (1 - t) + ds[k] * t;
      }
      field[gy * gw + gx] = d;
      maxDev = Math.max(maxDev, Math.abs(d));
    }
  }
  // colonnes sans ligne : recopie de la colonne renseignée la plus proche
  if (!has.some(Boolean)) maxDev = 0;
  else
    for (let gx = 0; gx < gw; gx++) {
      if (has[gx]) continue;
      let best = -1;
      for (let o = 1; o < gw && best < 0; o++) best = gx - o >= 0 && has[gx - o] ? gx - o : gx + o < gw && has[gx + o] ? gx + o : -1;
      for (let gy = 0; gy < gh; gy++) field[gy * gw + gx] = field[gy * gw + best];
    }
  // lissage
  for (let pass = 0; pass < 2; pass++) {
    const src = field.slice();
    for (let gy = 0; gy < gh; gy++)
      for (let gx = 0; gx < gw; gx++) {
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const yy = gy + dy;
            const xx = gx + dx;
            if (yy < 0 || yy >= gh || xx < 0 || xx >= gw) continue;
            s += src[yy * gw + xx];
            n++;
          }
        field[gy * gw + gx] = s / n;
      }
  }
  const curved = lines.length >= 4 && maxDev >= 0.2 * charH && maxDev <= 6 * charH;
  if (curved) for (let i = 0; i < field.length; i++) field[i] /= h;
  if (!curved && angle === 0) return null;
  return { angle, field: curved ? field : null, gw, gh, lines: lines.length };
}

/** Applique le modèle : chaque pixel redressé est lu dans l'image d'origine (bilinéaire, fond blanc). */
export function applyStraighten(img: RGBAImage, m: StraightenModel): RGBAImage {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  const cx = w / 2;
  const cy = h / 2;
  const cos = Math.cos(m.angle);
  const sin = Math.sin(m.angle);
  const { field, gw, gh } = m;
  const fx = (gw - 1) / w;
  const fy = (gh - 1) / h;
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    let o = y * w * 4;
    for (let x = 0; x < w; x++, o += 4) {
      const px = x + 0.5;
      let yy = py;
      if (field) {
        const u = Math.min(gw - 1.001, px * fx);
        const v = Math.min(gh - 1.001, py * fy);
        const u0 = u | 0;
        const v0 = v | 0;
        const tu = u - u0;
        const tv = v - v0;
        const i = v0 * gw + u0;
        yy +=
          h *
          (field[i] * (1 - tu) * (1 - tv) + field[i + 1] * tu * (1 - tv) + field[i + gw] * (1 - tu) * tv + field[i + gw + 1] * tu * tv);
      }
      const sx = cx + (px - cx) * cos - (yy - cy) * sin - 0.5;
      const sy = cy + (px - cx) * sin + (yy - cy) * cos - 0.5;
      if (sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255;
        continue;
      }
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const ax = Math.min(1, Math.max(0, sx - x0));
      const ay = Math.min(1, Math.max(0, sy - y0));
      const i00 = (y0 * w + x0) * 4;
      const i10 = (y0 * w + x1) * 4;
      const i01 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      const w00 = (1 - ax) * (1 - ay);
      const w10 = ax * (1 - ay);
      const w01 = (1 - ax) * ay;
      const w11 = ax * ay;
      out[o] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
      out[o + 1] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
      out[o + 2] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** Redresse l'image si nécessaire (renvoie l'image d'origine sinon). */
export function straightenImage(img: RGBAImage): RGBAImage {
  const model = estimateStraighten(img);
  return model ? applyStraighten(img, model) : img;
}
