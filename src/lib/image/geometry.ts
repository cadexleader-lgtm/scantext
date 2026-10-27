import type { Point, Quad } from "../types";

export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Aire signée (formule du lacet). */
export function polygonArea(pts: Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export const quadArea = (q: Quad): number => Math.abs(polygonArea(q));

/** Range 4 points dans l'ordre haut-gauche, haut-droite, bas-droite, bas-gauche. */
export function orderQuad(pts: Point[]): Quad {
  if (pts.length !== 4) throw new Error("4 points attendus");
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  // tri angulaire autour du centre (sens horaire dans un repère y vers le bas)
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // point de départ : le plus proche du coin haut-gauche
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  const q = [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
  return [q[0], q[1], q[2], q[3]].map((p) => ({ x: p.x, y: p.y })) as Quad;
}

export function isConvexQuad(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Angles intérieurs en degrés. */
export function quadAngles(q: Quad): number[] {
  return q.map((p, i) => {
    const prev = q[(i + 3) % 4];
    const next = q[(i + 1) % 4];
    const a1 = Math.atan2(prev.y - p.y, prev.x - p.x);
    const a2 = Math.atan2(next.y - p.y, next.x - p.x);
    let d = Math.abs(a1 - a2) * (180 / Math.PI);
    if (d > 180) d = 360 - d;
    return d;
  });
}

export const fullQuad = (w: number, h: number): Quad => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

export const scaleQuad = (q: Quad, sx: number, sy = sx): Quad =>
  q.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad;

/** Resserre légèrement les coins vers le centre (évite un liseré de fond sur les bords). */
export function insetQuad(q: Quad, fraction: number): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return q.map((p) => ({ x: p.x + (cx - p.x) * fraction * 2, y: p.y + (cy - p.y) * fraction * 2 })) as Quad;
}

export function clampQuad(q: Quad, w: number, h: number): Quad {
  return q.map((p) => ({ x: Math.max(0, Math.min(w, p.x)), y: Math.max(0, Math.min(h, p.y)) })) as Quad;
}

type V3 = [number, number, number];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Proportions réelles (largeur / hauteur) d'un rectangle photographié en
 * perspective, d'après Zhang & He (« Whiteboard scanning and image
 * enhancement », 2007) : la focale est estimée à partir des 4 coins, en
 * supposant le centre optique au centre de l'image. Sans cette correction, une
 * page photographiée de biais paraît plus courte qu'elle ne l'est.
 * @returns null si l'estimation n'est pas fiable
 */
export function perspectiveAspect(q: Quad, imgW: number, imgH: number): number | null {
  const cx = imgW / 2;
  const cy = imgH / 2;
  const m = (p: Point): V3 => [p.x - cx, p.y - cy, 1];
  const [m1, m2, m4, m3] = [m(q[0]), m(q[1]), m(q[2]), m(q[3])]; // HG, HD, BD, BG
  const k2 = dot3(cross3(m1, m4), m3) / dot3(cross3(m2, m4), m3);
  const k3 = dot3(cross3(m1, m4), m2) / dot3(cross3(m3, m4), m2);
  if (!Number.isFinite(k2) || !Number.isFinite(k3)) return null;
  const n2: V3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3: V3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const denom = n2[2] * n3[2];
  const side = Math.max(imgW, imgH);
  let ratio: number;
  if (Math.abs(denom) < 1e-10) {
    // pas de fuite perspective (vue de face) : rapport affine
    ratio = Math.hypot(n2[0], n2[1]) / Math.hypot(n3[0], n3[1]);
  } else {
    const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / denom;
    // focale invraisemblable : quadrilatère trop bruité pour une estimation fiable
    if (!(f2 > 0) || Math.sqrt(f2) < 0.25 * side || Math.sqrt(f2) > 8 * side) return null;
    ratio = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / f2 + n2[2] ** 2) / Math.sqrt((n3[0] ** 2 + n3[1] ** 2) / f2 + n3[2] ** 2);
  }
  return Number.isFinite(ratio) && ratio > 0.2 && ratio < 5 ? ratio : null;
}

/**
 * Taille du document redressé. La plus grande longueur de côté est conservée
 * et l'autre dimension suit les proportions réelles estimées, si possible.
 */
export function quadOutputSize(q: Quad, imgW?: number, imgH?: number): { w: number; h: number } {
  let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const ratio = imgW && imgH ? perspectiveAspect(q, imgW, imgH) : null;
  if (ratio) {
    if (w >= h) h = w / ratio;
    else w = h * ratio;
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

/** Résout A·x = b (élimination de Gauss avec pivot partiel). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error("Système singulier");
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Homographie qui envoie les 4 points `from` sur les 4 points `to`.
 * Retourne [h0..h8] avec h8 = 1 : X = (h0 x + h1 y + h2) / (h6 x + h7 y + 1).
 */
export function homography(from: Quad, to: Quad): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: X, y: Y } = to[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  return [...solve(A, b), 1];
}

export function applyHomography(h: number[], p: Point): Point {
  const d = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / d, y: (h[3] * p.x + h[4] * p.y + h[5]) / d };
}

/** Enveloppe convexe (chaîne monotone d'Andrew). */
export function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Quadrilatère d'aire maximale inscrit dans une enveloppe convexe : part des
 * extrêmes diagonaux puis améliore chaque sommet tant que l'aire augmente.
 */
export function maxAreaQuad(hull: Point[]): Quad | null {
  if (hull.length < 4) return null;
  const n = hull.length;
  const pick = (score: (p: Point) => number) => {
    let best = 0;
    for (let i = 1; i < n; i++) if (score(hull[i]) > score(hull[best])) best = i;
    return best;
  };
  let idx = [
    pick((p) => -p.x - p.y), // haut-gauche
    pick((p) => p.x - p.y), // haut-droite
    pick((p) => p.x + p.y), // bas-droite
    pick((p) => -p.x + p.y), // bas-gauche
  ];
  if (new Set(idx).size < 4) return null;
  const area = (ids: number[]) => Math.abs(polygonArea(ids.map((i) => hull[i])));
  let best = area(idx);
  for (let iter = 0; iter < 20; iter++) {
    let improved = false;
    for (let k = 0; k < 4; k++) {
      for (let cand = 0; cand < n; cand++) {
        if (idx.includes(cand)) continue;
        const trial = [...idx];
        trial[k] = cand;
        // conserver l'ordre cyclique sur l'enveloppe
        const sortedTrial = [...trial].sort((a, b) => a - b);
        const a = area(sortedTrial);
        if (a > best + 1e-6) {
          best = a;
          idx = sortedTrial;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return orderQuad(idx.map((i) => hull[i]));
}
