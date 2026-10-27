import type { Point, Quad } from "../types";
import { convexHull, isConvexQuad, maxAreaQuad, polygonArea, quadAngles, quadArea } from "./geometry";

/**
 * Détection des contours d'une page sur une photo, sans bibliothèque externe.
 *
 * Principe : sur une version réduite de l'image, la feuille (claire) est séparée
 * du fond par un seuil d'Otsu ; la plus grande zone claire est retenue, puis on
 * cherche le quadrilatère d'aire maximale dans son enveloppe convexe.
 * Fonctionne bien pour une feuille claire sur un fond plus sombre ; retourne
 * null quand le résultat n'est pas fiable (l'image entière est alors utilisée).
 */

export function otsuThreshold(gray: ArrayLike<number>): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** Flou par moyenne mobile (séparable), rayon r. */
export function boxBlur(src: Uint8ClampedArray | Uint8Array, w: number, h: number, r: number): Uint8ClampedArray {
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

interface Component {
  area: number;
  rowMin: Int32Array;
  rowMax: Int32Array;
  touches: number; // nombre de bords de l'image touchés
}

/** Composantes connexes (4-connexité) d'un masque binaire ; garde les plus grandes. */
function components(mask: Uint8Array, w: number, h: number, keep: number): Component[] {
  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const found: Component[] = [];
  let label = 0;
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    const rowMin = new Int32Array(h).fill(w);
    const rowMax = new Int32Array(h).fill(-1);
    let area = 0;
    let top = false,
      bottom = false,
      left = false,
      right = false;
    let sp = 0;
    const visit = (j: number) => {
      if (mask[j] && labels[j] === -1) {
        labels[j] = label;
        stack[sp++] = j;
      }
    };
    stack[sp++] = start;
    labels[start] = label;
    while (sp) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i - x) / w;
      area++;
      if (x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
      if (y === 0) top = true;
      if (y === h - 1) bottom = true;
      if (x === 0) left = true;
      if (x === w - 1) right = true;
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    label++;
    found.push({ area, rowMin, rowMax, touches: +top + +bottom + +left + +right });
  }
  return found.sort((a, b) => b.area - a.area).slice(0, keep);
}

export interface DetectionResult {
  quad: Quad;
  /** 0-1 : à quel point la zone détectée ressemble à un quadrilatère. */
  score: number;
}

/**
 * @param gray niveaux de gris (une valeur par pixel) d'une image réduite (≈ 200-400 px)
 * @returns coins dans le repère de cette image réduite, ou null
 */
export function detectDocument(gray: Uint8ClampedArray | Uint8Array, w: number, h: number): DetectionResult | null {
  const total = w * h;
  if (total < 400) return null;
  const blurred = boxBlur(boxBlur(gray, w, h, 2), w, h, 2);
  const t = otsuThreshold(blurred);
  // contraste insuffisant entre la feuille et le fond
  let lo = 0,
    hi = 0,
    nLo = 0,
    nHi = 0;
  for (let i = 0; i < total; i++) {
    if (blurred[i] > t) {
      hi += blurred[i];
      nHi++;
    } else {
      lo += blurred[i];
      nLo++;
    }
  }
  if (!nLo || !nHi || hi / nHi - lo / nLo < 25) return null;

  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i++) mask[i] = blurred[i] > t ? 1 : 0;

  let best: DetectionResult | null = null;
  for (const comp of components(mask, w, h, 3)) {
    if (comp.area < total * 0.1) break;
    // une zone qui touche les 4 bords est le fond (ou une feuille qui remplit le cadre)
    if (comp.touches >= 4) continue;
    const pts: Point[] = [];
    for (let y = 0; y < h; y++) {
      if (comp.rowMax[y] < 0) continue;
      pts.push({ x: comp.rowMin[y], y }, { x: comp.rowMax[y] + 1, y });
      pts.push({ x: comp.rowMin[y], y: y + 1 }, { x: comp.rowMax[y] + 1, y: y + 1 });
    }
    const hull = convexHull(pts);
    const quad = maxAreaQuad(hull);
    if (!quad || !isConvexQuad(quad)) continue;
    const qa = quadArea(quad);
    const hullArea = Math.abs(polygonArea(hull));
    if (qa < total * 0.12) continue;
    const fit = qa / hullArea; // ≈ 1 pour un quadrilatère
    const solidity = comp.area / hullArea; // ≈ 1 pour une feuille pleine
    const angles = quadAngles(quad);
    if (angles.some((a) => a < 35 || a > 145)) continue;
    if (fit < 0.88 || solidity < 0.75) continue;
    const score = fit * Math.min(1, solidity + 0.15);
    if (!best || score > best.score) best = { quad, score };
  }
  return best;
}

/** Luminance d'une image RGBA. */
export function rgbaToGray(data: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  return g;
}
