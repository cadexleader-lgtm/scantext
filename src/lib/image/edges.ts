import type { Point, Quad } from "../types";
import { boxBlur, detectDocument } from "./detect";
import { isConvexQuad, orderQuad, quadAngles, quadArea } from "./geometry";

/**
 * Détection des bords de la feuille par les contours (gradients) plutôt que
 * par la luminosité : fonctionne aussi sur un fond clair, texturé ou de
 * couleur proche du papier.
 *
 *  1. gradients (Sobel) + amincissement des contours ;
 *  2. transformée de Hough : les longs bords droits ressortent ;
 *  3. pour chaque combinaison de 2 lignes « horizontales » et 2 « verticales »,
 *     le quadrilatère obtenu est noté selon la présence réelle d'un bord tout
 *     le long de ses 4 côtés. Les textures (bruit) et le texte ne forment pas
 *     de bords continus et sont donc écartés.
 */

export interface EdgeMap {
  w: number;
  h: number;
  /** Amplitude du gradient après amincissement (0 = pas de contour). */
  mag: Float32Array;
  gx: Float32Array;
  gy: Float32Array;
}

const MIN_EDGE = 4;

/** Filtre min ou max séparable (érosion / dilatation en niveaux de gris), rayon r. */
function rankFilter(src: Uint8ClampedArray | Uint8Array, w: number, h: number, r: number, max: boolean): Uint8ClampedArray {
  const tmp = new Uint8ClampedArray(w * h);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = max ? 0 : 255;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) {
        const s = src[row + k];
        if (max ? s > v : s < v) v = s;
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = max ? 0 : 255;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h - 1, y + r);
      for (let k = y0; k <= y1; k++) {
        const s = tmp[k * w + x];
        if (max ? s > v : s < v) v = s;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Fermeture morphologique : efface les petits éléments sombres (le texte) en
 * conservant le contour des grandes zones claires (la feuille). Sans elle, les
 * lignes de texte forment de longs traits horizontaux qui masquent le bord.
 */
export function removeText(gray: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8ClampedArray {
  const r = Math.max(2, Math.round(Math.max(w, h) / 90));
  return rankFilter(rankFilter(gray, w, h, r, true), w, h, r, false);
}

export function edgeMap(gray: Uint8ClampedArray | Uint8Array, w: number, h: number): EdgeMap {
  // lisser d'abord (une texture de fond deviendrait sinon aussi claire que le papier), puis effacer le texte
  const g = boxBlur(removeText(boxBlur(boxBlur(gray, w, h, 2), w, h, 2), w, h), w, h, 1);
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const raw = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i - w - 1],
        b = g[i - w],
        c = g[i - w + 1],
        d = g[i - 1],
        f = g[i + 1],
        k = g[i + w - 1],
        l = g[i + w],
        m = g[i + w + 1];
      const sx = c + 2 * f + m - (a + 2 * d + k);
      const sy = k + 2 * l + m - (a + 2 * b + c);
      gx[i] = sx;
      gy[i] = sy;
      raw[i] = Math.hypot(sx, sy) / 4;
    }
  }
  // amincissement : on ne garde que le maximum dans la direction du gradient
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = raw[i];
      if (v < MIN_EDGE) continue;
      const ang = Math.atan2(gy[i], gx[i]);
      const a = ((ang * 180) / Math.PI + 180) % 180;
      // voisin dans la direction du gradient (0°, 45°, 90° ou 135°)
      const off = a < 22.5 || a >= 157.5 ? 1 : a < 67.5 ? w + 1 : a < 112.5 ? w : w - 1;
      if (v >= raw[i - off] && v >= raw[i + off]) mag[i] = v;
    }
  }
  return { w, h, mag, gx, gy };
}

export interface Line {
  /** Angle de la normale, en radians [0, π). */
  theta: number;
  rho: number;
  votes: number;
}

/** Transformée de Hough orientée (chaque contour ne vote que près de sa propre direction). */
export function houghLines(e: EdgeMap, maxLines = 40): Line[] {
  const { w, h, mag, gx, gy } = e;
  const diag = Math.ceil(Math.hypot(w, h));
  const nT = 180;
  const nR = 2 * diag + 1;
  const acc = new Float32Array(nT * nR);
  const cos = new Float32Array(nT);
  const sin = new Float32Array(nT);
  for (let t = 0; t < nT; t++) {
    cos[t] = Math.cos((t * Math.PI) / nT);
    sin[t] = Math.sin((t * Math.PI) / nT);
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (!m) continue;
      const weight = Math.min(1, m / 25);
      let t0 = Math.round((((Math.atan2(gy[i], gx[i]) * 180) / Math.PI) + 360) % 180);
      if (t0 >= nT) t0 -= nT;
      for (let dt = -5; dt <= 5; dt++) {
        // (θ + 180°, ρ) et (θ, −ρ) sont la même droite : ρ recalculé pour l'angle ramené dans [0, 180)
        const t = (t0 + dt + nT) % nT;
        const r = x * cos[t] + y * sin[t];
        acc[t * nR + Math.round(r) + diag] += weight;
      }
    }
  }
  // maxima locaux
  const minVotes = 0.08 * Math.min(w, h);
  const peaks: Line[] = [];
  for (let t = 0; t < nT; t++) {
    for (let r = 0; r < nR; r++) {
      const v = acc[t * nR + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -4; dt <= 4 && isMax; dt++) {
        const tt = (t + dt + nT) % nT;
        for (let dr = -6; dr <= 6; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= nR || (dt === 0 && dr === 0)) continue;
          const o = acc[tt * nR + rr];
          if (o > v || (o === v && (dt < 0 || (dt === 0 && dr < 0)))) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ theta: (t * Math.PI) / nT, rho: r - diag, votes: v });
    }
  }
  return peaks.sort((a, b) => b.votes - a.votes).slice(0, maxLines);
}

function intersect(a: Line, b: Line): Point | null {
  const c1 = Math.cos(a.theta),
    s1 = Math.sin(a.theta),
    c2 = Math.cos(b.theta),
    s2 = Math.sin(b.theta);
  const det = c1 * s2 - s1 * c2;
  if (Math.abs(det) < 1e-6) return null;
  return { x: (a.rho * s2 - b.rho * s1) / det, y: (c1 * b.rho - c2 * a.rho) / det };
}

/** Part du côté [a,b] effectivement soutenue par un contour perpendiculaire. */
function sideSupport(e: EdgeMap, a: Point, b: Point): number {
  const { w, h, mag, gx, gy } = e;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 4) return 0;
  const dx = (b.x - a.x) / len;
  const dy = (b.y - a.y) / len;
  const nx = -dy;
  const ny = dx;
  const samples = Math.max(12, Math.min(80, Math.round(len / 3)));
  let inside = 0;
  let onBorder = 0;
  let hits = 0;
  for (let s = 0; s < samples; s++) {
    const t = (s + 0.5) / samples;
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    if (px < 1 || py < 1 || px > w - 2 || py > h - 2) continue;
    inside++;
    if (px < 4 || py < 4 || px > w - 5 || py > h - 5) {
      onBorder++;
      continue;
    }
    for (let o = -2; o <= 2; o++) {
      const qx = Math.round(px + nx * o);
      const qy = Math.round(py + ny * o);
      const i = qy * w + qx;
      const m = mag[i];
      if (!m) continue;
      const g = Math.hypot(gx[i], gy[i]) || 1;
      if (Math.abs((gx[i] * nx + gy[i] * ny) / g) > 0.9) {
        hits++;
        break;
      }
    }
  }
  if (!inside) return 0;
  // côté le long du bord de l'image : la feuille dépasse du cadre, ni preuve ni contre-preuve
  if (onBorder / inside > 0.6) return 0.5;
  const measured = inside - onBorder;
  return measured ? hits / measured : 0.5;
}

export function scoreQuad(e: EdgeMap, q: Quad): number {
  const s = [0, 1, 2, 3].map((i) => sideSupport(e, q[i], q[(i + 1) % 4]));
  const areaFrac = quadArea(q) / (e.w * e.h);
  const mean = s.reduce((x, y) => x + y, 0) / 4;
  return mean * Math.min(...s) * Math.pow(Math.min(1, areaFrac), 0.2);
}

function validQuad(q: Quad, w: number, h: number): boolean {
  const mx = 0.04 * w;
  const my = 0.04 * h;
  if (q.some((p) => p.x < -mx || p.y < -my || p.x > w + mx || p.y > h + my)) return false;
  if (!isConvexQuad(q)) return false;
  if (quadArea(q) < 0.12 * w * h) return false;
  return quadAngles(q).every((a) => a > 50 && a < 130);
}

export interface EdgeDetection {
  quad: Quad;
  score: number;
}

/** Meilleur quadrilatère formé par les bords détectés (null si aucun n'est convaincant). */
export function detectByEdges(e: EdgeMap, extraCandidates: Quad[] = []): EdgeDetection | null {
  const { w, h } = e;
  const lines = houghLines(e);
  const horiz: Line[] = [];
  const vert: Line[] = [];
  for (const l of lines) {
    const deg = (l.theta * 180) / Math.PI;
    if (deg >= 50 && deg <= 130) horiz.push(l);
    else if (deg < 40 || deg > 140) vert.push(l);
  }
  // bords de l'image : la feuille peut sortir du cadre
  horiz.push({ theta: Math.PI / 2, rho: 1, votes: 0 }, { theta: Math.PI / 2, rho: h - 2, votes: 0 });
  vert.push({ theta: 0, rho: 1, votes: 0 }, { theta: 0, rho: w - 2, votes: 0 });
  const H = horiz.slice(0, 10).concat(horiz.slice(-2));
  const V = vert.slice(0, 10).concat(vert.slice(-2));
  const uniq = <T,>(a: T[]) => [...new Set(a)];
  let best: EdgeDetection | null = null;
  const consider = (q: Quad) => {
    if (!validQuad(q, w, h)) return;
    const score = scoreQuad(e, q);
    if (!best || score > best.score) best = { quad: q, score };
  };
  const Hs = uniq(H);
  const Vs = uniq(V);
  for (let i = 0; i < Hs.length; i++)
    for (let j = i + 1; j < Hs.length; j++)
      for (let k = 0; k < Vs.length; k++)
        for (let m = k + 1; m < Vs.length; m++) {
          const pts = [intersect(Hs[i], Vs[k]), intersect(Hs[i], Vs[m]), intersect(Hs[j], Vs[k]), intersect(Hs[j], Vs[m])];
          if (pts.some((p) => !p)) continue;
          consider(orderQuad(pts as Point[]));
        }
  for (const q of extraCandidates) consider(q);
  return best;
}

/** Score minimal pour accepter un cadre (le cadre « image entière » vaut ≈ 0,25). */
export const MIN_PAGE_SCORE = 0.3;

/**
 * Trouve la feuille sur une image réduite (≈ 240-480 px) en niveaux de gris.
 * Combine la détection par contours et l'ancienne détection par luminosité
 * (utilisée comme candidat supplémentaire), puis garde le cadre le mieux
 * soutenu par de vrais bords.
 */
export function findPage(gray: Uint8ClampedArray | Uint8Array, w: number, h: number): EdgeDetection | null {
  if (w * h < 400) return null;
  const e = edgeMap(gray, w, h);
  const byBrightness = detectDocument(gray, w, h);
  const res = detectByEdges(e, byBrightness ? [byBrightness.quad] : []);
  return res && res.score >= MIN_PAGE_SCORE ? res : null;
}
