import { compH, compW, extractRuns, inkMask, labelRuns, typicalCharHeight, type Component, type Labeled } from "./components";
import { rgbaToGray } from "./detect";
import { adaptiveThreshold, normalizeBackground, type RGBAImage } from "./ops";
import { encodeGrayPng } from "./png";
import { countTextLines } from "./straighten";

/**
 * Préparation d'une page pour la reconnaissance de texte.
 *
 * Le moteur lit beaucoup mieux un texte assez grand (≈ 300 dpi) sur un fond
 * uniforme, sans traits qui traversent les lettres. À partir de l'image
 * traitée (celle que voit l'utilisateur) :
 *  1. le fond est uniformisé (ombres, éclairage inégal) ;
 *  2. la taille des caractères est mesurée sur la page ;
 *  3. les règles de tableau, soulignements et traits parasites (bord d'une
 *     autre feuille, pli) sont effacés — les règles horizontales et verticales
 *     sont conservées à part pour reconstruire les tableaux ;
 *  4. les zones sombres collées au bord (fond resté après recadrage) sont
 *     blanchies ;
 *  5. l'image est agrandie (interpolation bicubique) pour que les minuscules
 *     mesurent ≈ TARGET_CHAR_H pixels.
 * Les pixels ne sont jamais déplacés, seulement agrandis : les positions des
 * mots reconnus se ramènent à l'image traitée en divisant par `scale`.
 */

/** Trait horizontal ou vertical, en pixels de l'image traitée (bornes exclues). */
export interface Ruling {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  horizontal: boolean;
}

export interface OcrPrep {
  /** Image à reconnaître (niveaux de gris), déjà agrandie. */
  gray: Uint8ClampedArray;
  w: number;
  h: number;
  /** Facteur d'agrandissement : pixel OCR = pixel de l'image traitée × scale. */
  scale: number;
  /** Hauteur typique des minuscules dans l'image traitée (null si pas de texte détecté). */
  charH: number | null;
  rulings: Ruling[];
  /** Résolution équivalente annoncée au moteur. */
  dpi: number;
  /** Nombre de pixels effacés (traits, bords). */
  erased: number;
  /** Boîtes des caractères repérés (x0, y0, x1, y1 à la suite), en pixels de l'image traitée. */
  charBoxes: Int32Array;
}

export interface OcrPrepOptions {
  /** Hauteur visée des minuscules après agrandissement. */
  targetCharH?: number;
  maxScale?: number;
  /** Taille maximale de l'image envoyée au moteur. */
  maxPixels?: number;
}

export const TARGET_CHAR_H = 24;
const DEFAULT_MAX_PIXELS = 14_000_000;

// ------------------------------------------------------------------ traits

/** Transposée d'un masque (pour traiter les traits verticaux comme des horizontaux). */
function transpose(mask: Uint8Array, w: number, h: number): Uint8Array {
  const t = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) t[x * h + y] = mask[row + x];
  }
  return t;
}

interface Segment {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Pixels d'encre du trait. */
  area: number;
  /** Segments d'encre du trait : [y, x0, x1] à plat. */
  pixels: number[];
}

/**
 * Traits horizontaux d'au moins minLen pixels. Une ligne de l'image et ses deux
 * voisines sont combinées, pour suivre un trait très légèrement incliné.
 */
function horizontalStrokes(mask: Uint8Array, w: number, h: number, minLen: number, maxThick: number): Segment[] {
  // pixels d'encre appartenant à une longue suite horizontale
  const marked = new Uint8Array(w * h);
  const or = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = y > 0 ? row - w : row;
    const down = y < h - 1 ? row + w : row;
    for (let x = 0; x < w; x++) or[x] = mask[row + x] | mask[up + x] | mask[down + x];
    let x = 0;
    while (x < w) {
      while (x < w && !or[x]) x++;
      const s = x;
      while (x < w && or[x]) x++;
      if (x - s >= minLen) for (let k = s; k < x; k++) marked[row + k] = mask[row + k];
    }
  }
  const lab = labelRuns(extractRuns(marked, w, h));
  const segs: Segment[] = [];
  const byComp = new Map<number, number[]>();
  for (let i = 0; i < lab.runs.n; i++) {
    const id = lab.label[i];
    let list = byComp.get(id);
    if (!list) byComp.set(id, (list = []));
    list.push(lab.runs.y[i], lab.runs.x0[i], lab.runs.x1[i]);
  }
  lab.comps.forEach((c, id) => {
    const len = compW(c);
    if (len < minLen) return;
    // épaisseur : médiane, colonne par colonne (des lettres qui touchent le trait ne la faussent pas)
    const pixels = byComp.get(id) ?? [];
    const counts = new Uint16Array(len);
    for (let k = 0; k < pixels.length; k += 3) for (let x = pixels[k + 1]; x < pixels[k + 2]; x++) counts[x - c.x0]++;
    const sorted = Array.from(counts).filter(Boolean).sort((a, b) => a - b);
    const thick = sorted[Math.floor(sorted.length / 2)] ?? 0;
    // (+2 : les lignes voisines combinées pour suivre un trait incliné)
    if (thick > maxThick + 2) return; // barre épaisse (bandeau, photo) : ce n'est pas un trait
    segs.push({ ...c, pixels });
  });
  return segs;
}

const near = (a: Segment, b: Segment, tol: number) =>
  a.x0 - tol <= b.x1 && b.x0 - tol <= a.x1 && a.y0 - tol <= b.y1 && b.y0 - tol <= a.y1;

/** Repère les traits horizontaux et verticaux, en évitant de prendre un mot pour un trait. */
function findRulings(mask: Uint8Array, w: number, h: number, charH: number): { h: Segment[]; v: Segment[] } {
  const maxThick = Math.max(3, Math.round(0.35 * charH));
  // un mot très long, aux lettres soudées, peut dépasser 15 caractères : seuil large ;
  // un trait vertical de texte ne dépasse pas ≈ 2 hauteurs de caractère
  const hAll = horizontalStrokes(mask, w, h, Math.max(24, Math.round(5 * charH)), maxThick);
  const t = transpose(mask, w, h);
  const vAll = horizontalStrokes(t, h, w, Math.max(12, Math.round(2.5 * charH)), maxThick).map((s) => ({
    x0: s.y0,
    x1: s.y1,
    y0: s.x0,
    y1: s.x1,
    area: s.area,
    // [y, x0, x1] dans le repère transposé = [x, y0, y1]
    pixels: s.pixels,
  }));
  const longH = (s: Segment) => s.x1 - s.x0 >= 20 * charH;
  const longV = (s: Segment) => s.y1 - s.y0 >= 6 * charH;
  const tol = Math.max(2, Math.round(0.6 * charH));
  const hs = hAll.filter(longH);
  const vs = vAll.filter(longV);
  // traits plus courts acceptés seulement s'ils touchent un trait perpendiculaire (grille de tableau)
  for (const s of vAll) if (!longV(s) && hs.some((o) => near(s, o, tol))) vs.push(s);
  for (const s of hAll) if (!longH(s) && vs.some((o) => near(s, o, tol))) hs.push(s);
  return { h: hs, v: vs };
}

// ------------------------------------------------------------------ traits obliques

/**
 * Cherche dans une composante un trait droit oblique (bord de feuille, pli,
 * rature) par transformée de Hough ; renvoie les pixels du trait. Les
 * orientations proches de l'horizontale et de la verticale sont exclues : ce
 * sont celles des lignes de texte et des règles, traitées à part.
 */
export function obliqueLine(
  points: Int32Array,
  count: number,
  minLen: number,
  band: number,
): { pts: Int32Array; nx: number; ny: number } | null {
  const nT = 360; // pas de 0,5°
  const exclude = 8; // ± 4° autour de 0° et 90°
  let maxR = 0;
  for (let i = 0; i < count; i++) maxR = Math.max(maxR, Math.hypot(points[2 * i], points[2 * i + 1]));
  const off = Math.ceil(maxR) + 1;
  const nR = 2 * off + 1;
  const thetas: number[] = [];
  for (let t = 0; t < nT; t++) if (t > exclude && t < nT - exclude && Math.abs(t - nT / 2) > exclude) thetas.push(t);
  const cos = thetas.map((t) => Math.cos((t * Math.PI) / nT));
  const sin = thetas.map((t) => Math.sin((t * Math.PI) / nT));
  const acc = new Uint32Array(thetas.length * nR);
  for (let i = 0; i < count; i++) {
    const x = points[2 * i];
    const y = points[2 * i + 1];
    for (let k = 0; k < thetas.length; k++) acc[k * nR + Math.round(x * cos[k] + y * sin[k]) + off]++;
  }
  let best = 0;
  let bk = 0;
  let br = 0;
  for (let i = 0; i < acc.length; i++)
    if (acc[i] > best) {
      best = acc[i];
      bk = (i / nR) | 0;
      br = (i % nR) - off;
    }
  if (best < minLen) return null;
  // pixels proches de la droite, puis plus longue portion continue
  const c = cos[bk];
  const s = sin[bk];
  const along: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = points[2 * i];
    const y = points[2 * i + 1];
    if (Math.abs(x * c + y * s - br) <= band) {
      along.push(-x * s + y * c);
      idx.push(i);
    }
  }
  if (along.length < minLen) return null;
  const order = along.map((_, i) => i).sort((a, b) => along[a] - along[b]);
  const maxGap = Math.max(3, band * 2);
  let bestStart = 0;
  let bestEnd = 0;
  let start = 0;
  for (let k = 1; k <= order.length; k++) {
    if (k === order.length || along[order[k]] - along[order[k - 1]] > maxGap) {
      if (along[order[k - 1]] - along[order[start]] > along[order[bestEnd]] - along[order[bestStart]]) {
        bestStart = start;
        bestEnd = k - 1;
      }
      start = k;
    }
  }
  const length = along[order[bestEnd]] - along[order[bestStart]];
  if (length < minLen) return null;
  // un vrai trait est continu : presque chaque position le long de la droite est encrée
  const seen = new Set<number>();
  for (let k = bestStart; k <= bestEnd; k++) seen.add(Math.floor(along[order[k]]));
  if (seen.size < 0.75 * length) return null;
  const out = new Int32Array((bestEnd - bestStart + 1) * 2);
  for (let k = bestStart, o = 0; k <= bestEnd; k++, o += 2) {
    const i = idx[order[k]];
    out[o] = points[2 * i];
    out[o + 1] = points[2 * i + 1];
  }
  return { pts: out, nx: c, ny: s };
}

/** Pixels d'une composante, relatifs au coin de sa boîte. */
function componentPoints(lab: Labeled, c: Component, members: number[]): { pts: Int32Array; n: number } {
  let n = 0;
  for (const r of members) n += lab.runs.x1[r] - lab.runs.x0[r];
  const pts = new Int32Array(n * 2);
  let o = 0;
  for (const r of members) {
    const y = lab.runs.y[r] - c.y0;
    for (let x = lab.runs.x0[r]; x < lab.runs.x1[r]; x++) {
      pts[o++] = x - c.x0;
      pts[o++] = y;
    }
  }
  return { pts, n };
}

// ------------------------------------------------------------------ agrandissement

/** Noyau bicubique (Catmull-Rom). */
function cubic(t: number): number {
  const a = Math.abs(t);
  if (a < 1) return 1.5 * a * a * a - 2.5 * a * a + 1;
  if (a < 2) return -0.5 * a * a * a + 2.5 * a * a - 4 * a + 2;
  return 0;
}

/** Redimensionnement bicubique séparable d'une image en niveaux de gris. */
export function resizeGray(src: Uint8ClampedArray, w: number, h: number, nw: number, nh: number): Uint8ClampedArray {
  if (nw === w && nh === h) return src;
  const weights = (n: number, from: number) => {
    const idx = new Int32Array(n * 4);
    const wt = new Float32Array(n * 4);
    const ratio = from / n;
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) * ratio - 0.5;
      const base = Math.floor(s);
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const p = base - 1 + k;
        const v = cubic(s - p);
        idx[i * 4 + k] = Math.min(from - 1, Math.max(0, p));
        wt[i * 4 + k] = v;
        sum += v;
      }
      for (let k = 0; k < 4; k++) wt[i * 4 + k] /= sum;
    }
    return { idx, wt };
  };
  const wx = weights(nw, w);
  const wy = weights(nh, h);
  const tmp = new Float32Array(nw * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const o = y * nw;
    for (let x = 0; x < nw; x++) {
      const k = x * 4;
      tmp[o + x] =
        src[row + wx.idx[k]] * wx.wt[k] +
        src[row + wx.idx[k + 1]] * wx.wt[k + 1] +
        src[row + wx.idx[k + 2]] * wx.wt[k + 2] +
        src[row + wx.idx[k + 3]] * wx.wt[k + 3];
    }
  }
  const out = new Uint8ClampedArray(nw * nh);
  for (let y = 0; y < nh; y++) {
    const k = y * 4;
    const r0 = wy.idx[k] * nw;
    const r1 = wy.idx[k + 1] * nw;
    const r2 = wy.idx[k + 2] * nw;
    const r3 = wy.idx[k + 3] * nw;
    const w0 = wy.wt[k];
    const w1 = wy.wt[k + 1];
    const w2 = wy.wt[k + 2];
    const w3 = wy.wt[k + 3];
    const o = y * nw;
    for (let x = 0; x < nw; x++) out[o + x] = tmp[r0 + x] * w0 + tmp[r1 + x] * w1 + tmp[r2 + x] * w2 + tmp[r3 + x] * w3;
  }
  return out;
}

// ------------------------------------------------------------------ chaîne complète

export function prepareOcrImage(img: RGBAImage, opts: OcrPrepOptions = {}): OcrPrep {
  const { width: w, height: h } = img;
  const norm = normalizeBackground(rgbaToGray(img.data, w, h), w, h);
  const mask = inkMask(adaptiveThreshold(norm, w, h));
  const lab = labelRuns(extractRuns(mask, w, h));
  const sized = typicalCharHeight(lab.comps, h);
  // sans lignes de texte alignées (photo, dessin, image bruitée), la mesure n'a pas de sens :
  // pas d'agrandissement ni d'effacement, pour ne pas faire travailler le moteur pour rien
  const measured = sized && countTextLines(lab.comps, sized) >= 2 ? sized : null;
  // sans texte mesurable : taille d'un texte courant sur une page A4
  const charH = measured ?? Math.max(6, (Math.min(w, h) / 8.27) * 0.069);

  // 2 = pixel du trait (effacé), 1 = liseré (effacé seulement s'il est clair :
  // une lettre qui touche le trait garde son encre)
  const erase = new Uint8Array(w * h);
  let erased = 0;
  const R = 2;
  const mark = (x: number, y: number) => {
    const i = y * w + x;
    if (erase[i] === 2) return;
    erase[i] = 2;
    erased++;
    for (let dy = -R; dy <= R; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < w && !erase[yy * w + xx]) erase[yy * w + xx] = 1;
      }
    }
  };

  const rulings: Ruling[] = [];
  if (measured) {
    // 1. règles horizontales et verticales
    const found = findRulings(mask, w, h, charH);
    const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
    // une lettre qui traverse le trait a de l'encre des deux côtés : ses pixels sont gardés
    const erasePerpendicular = (pixels: number[], horizontal: boolean) => {
      const lo = new Map<number, number>();
      const hi = new Map<number, number>();
      for (let k = 0; k < pixels.length; k += 3)
        for (let t = pixels[k + 1]; t < pixels[k + 2]; t++) {
          const v = pixels[k];
          lo.set(t, Math.min(lo.get(t) ?? v, v));
          hi.set(t, Math.max(hi.get(t) ?? v, v));
        }
      const crossed = (t: number) => {
        const a = lo.get(t)!;
        const b = hi.get(t)!;
        return horizontal ? (ink(t, a - 2) || ink(t, a - 3)) && (ink(t, b + 2) || ink(t, b + 3)) : (ink(a - 2, t) || ink(a - 3, t)) && (ink(b + 2, t) || ink(b + 3, t));
      };
      for (let k = 0; k < pixels.length; k += 3)
        for (let t = pixels[k + 1]; t < pixels[k + 2]; t++) {
          if (crossed(t)) continue;
          if (horizontal) mark(t, pixels[k]);
          else mark(pixels[k], t);
        }
    };
    for (const s of found.h) {
      erasePerpendicular(s.pixels, true);
      rulings.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, horizontal: true });
    }
    for (const s of found.v) {
      // repère transposé : [x, y0, y1]
      erasePerpendicular(s.pixels, false);
      rulings.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, horizontal: false });
    }

    // 2. traits obliques et zones sombres collées au bord, composante par composante
    const members = new Map<number, number[]>();
    const candidate = (c: Component) => {
      const cw = compW(c);
      const ch = compH(c);
      const border = c.x0 === 0 || c.y0 === 0 || c.x1 === w || c.y1 === h;
      const sparse = cw >= 6 * charH && ch >= 6 * charH && c.area < 0.15 * cw * ch;
      if (border && c.area >= 15 * charH * charH && Math.max(cw, ch) >= 3 * charH)
        return c.area >= 0.35 * cw * ch ? "solid" : sparse ? "border-sparse" : "border";
      return sparse ? "oblique" : null;
    };
    const kinds = lab.comps.map(candidate);
    for (let r = 0; r < lab.runs.n; r++) {
      const id = lab.label[r];
      if (!kinds[id]) continue;
      let list = members.get(id);
      if (!list) members.set(id, (list = []));
      list.push(r);
    }
    const band = Math.max(1.5, 0.2 * charH);
    for (const [id, runs] of members) {
      const c = lab.comps[id];
      const kind = kinds[id];
      if (kind !== "oblique") {
        // zone sombre pleine : effacée entièrement ; sinon seulement ses parties épaisses,
        // pour ne pas effacer des lettres qui la toucheraient
        for (const r of runs)
          if (kind === "solid" || lab.runs.x1[r] - lab.runs.x0[r] >= 1.5 * charH)
            for (let x = lab.runs.x0[r]; x < lab.runs.x1[r]; x++) mark(x, lab.runs.y[r]);
        if (kind !== "border-sparse") continue;
      }
      let { pts, n } = componentPoints(lab, c, runs);
      if (n > 400_000) continue; // trop gros pour être un simple trait
      for (let iter = 0; iter < 4; iter++) {
        const found = obliqueLine(pts, n, 6 * charH, band);
        if (!found) break;
        const line = found.pts;
        const gone = new Set<number>();
        // le trait n'est effacé que hors du texte (marges, interlignes) : là où il traverse
        // une ligne de texte, l'effacer emporterait des morceaux de lettres
        const offsets = [band + 2, band + 0.3 * charH, band + 0.6 * charH];
        for (let k = 0; k < line.length; k += 2) {
          const x = line[k] + c.x0;
          const y = line[k + 1] + c.y0;
          gone.add(line[k + 1] * w + line[k]);
          const nearText = offsets.some(
            (d) => ink(Math.round(x + found.nx * d), Math.round(y + found.ny * d)) || ink(Math.round(x - found.nx * d), Math.round(y - found.ny * d)),
          );
          if (!nearText) mark(x, y);
        }
        const rest = new Int32Array(pts.length);
        let m = 0;
        for (let i = 0; i < n; i++)
          if (!gone.has(pts[2 * i + 1] * w + pts[2 * i])) {
            rest[2 * m] = pts[2 * i];
            rest[2 * m + 1] = pts[2 * i + 1];
            m++;
          }
        pts = rest;
        n = m;
      }
    }
  }

  for (let i = 0; i < erase.length; i++) if (erase[i] === 2 || (erase[i] === 1 && norm[i] > 110)) norm[i] = 255;

  const target = opts.targetCharH ?? TARGET_CHAR_H;
  const maxPixels = opts.maxPixels ?? DEFAULT_MAX_PIXELS;
  let scale = sized && !measured ? 1 : Math.min(opts.maxScale ?? 3, Math.max(1, target / charH));
  scale = Math.max(1, Math.min(scale, Math.sqrt(maxPixels / (w * h))));
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  const gray = resizeGray(norm, w, h, nw, nh);
  scale = nw / w;
  // résolution équivalente pour un texte courant (minuscules ≈ 0,069 pouce en corps 10)
  const dpi = Math.round(Math.max(150, Math.min(600, (charH * scale) / 0.069)));
  const boxes: number[] = [];
  if (measured)
    for (const c of lab.comps) {
      const ch = compH(c);
      if (ch >= 0.5 * charH && ch <= 2.5 * charH && compW(c) <= 10 * charH && c.area >= 4) boxes.push(c.x0, c.y0, c.x1, c.y1);
    }
  return { gray, w: nw, h: nh, scale, charH: measured, rulings, dpi, erased, charBoxes: Int32Array.from(boxes) };
}

/** Image préparée pour la reconnaissance, encodée en PNG dans le worker. */
export interface OcrPrepMessage {
  png: Uint8Array;
  w: number;
  h: number;
  scale: number;
  dpi: number;
  charH: number | null;
  rulings: Ruling[];
  charBoxes: Int32Array;
}

/** Exécuté dans le worker (ou ici si les workers sont indisponibles). */
export function runOcrPrep(image: RGBAImage): OcrPrepMessage {
  const p = prepareOcrImage(image);
  return {
    png: encodeGrayPng(p.gray, p.w, p.h),
    w: p.w,
    h: p.h,
    scale: p.scale,
    dpi: p.dpi,
    charH: p.charH,
    rulings: p.rulings,
    charBoxes: p.charBoxes,
  };
}

