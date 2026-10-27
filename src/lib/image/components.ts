/**
 * Composantes connexes d'un masque binaire, calculées par segments (suites de
 * pixels d'encre sur une ligne) : peu de mémoire, même sur une page de
 * plusieurs millions de pixels. Sert à mesurer la taille du texte, à repérer
 * les lignes de texte et à isoler les traits (règles, bords, ombres).
 */

export interface Runs {
  /** Ligne, début (inclus) et fin (exclue) de chaque segment. */
  y: Int32Array;
  x0: Int32Array;
  x1: Int32Array;
  n: number;
  /** Index du premier segment de chaque ligne (taille h + 1). */
  rowStart: Int32Array;
  w: number;
  h: number;
}

/** Segments d'encre (mask[i] = 1) ligne par ligne. */
export function extractRuns(mask: Uint8Array, w: number, h: number): Runs {
  let cap = 1 << 16;
  let ys = new Int32Array(cap);
  let x0s = new Int32Array(cap);
  let x1s = new Int32Array(cap);
  const rowStart = new Int32Array(h + 1);
  let n = 0;
  for (let y = 0; y < h; y++) {
    rowStart[y] = n;
    const row = y * w;
    let x = 0;
    while (x < w) {
      while (x < w && !mask[row + x]) x++;
      if (x >= w) break;
      const s = x;
      while (x < w && mask[row + x]) x++;
      if (n === cap) {
        cap *= 2;
        const grow = (a: Int32Array) => {
          const b = new Int32Array(cap);
          b.set(a);
          return b;
        };
        ys = grow(ys);
        x0s = grow(x0s);
        x1s = grow(x1s);
      }
      ys[n] = y;
      x0s[n] = s;
      x1s[n] = x;
      n++;
    }
  }
  rowStart[h] = n;
  return { y: ys, x0: x0s, x1: x1s, n, rowStart, w, h };
}

export interface Component {
  x0: number;
  y0: number;
  /** Bornes exclues. */
  x1: number;
  y1: number;
  /** Nombre de pixels d'encre. */
  area: number;
}

export interface Labeled {
  runs: Runs;
  /** Composante de chaque segment. */
  label: Int32Array;
  comps: Component[];
}

/** Étiquetage en 8-connexité. */
export function labelRuns(runs: Runs): Labeled {
  const { n, rowStart, h } = runs;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let y = 1; y < h; y++) {
    let j = rowStart[y - 1];
    const jEnd = rowStart[y];
    for (let i = rowStart[y]; i < rowStart[y + 1]; i++) {
      // 8-connexité : chevauchement à un pixel près
      while (j < jEnd && runs.x1[j] < runs.x0[i]) j++;
      for (let k = j; k < jEnd && runs.x0[k] <= runs.x1[i]; k++) {
        const a = find(i);
        const b = find(k);
        if (a !== b) parent[a < b ? b : a] = a < b ? a : b;
      }
    }
  }
  const label = new Int32Array(n);
  const ids = new Int32Array(n).fill(-1);
  const comps: Component[] = [];
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let id = ids[r];
    if (id < 0) {
      id = ids[r] = comps.length;
      comps.push({ x0: runs.x0[i], y0: runs.y[i], x1: runs.x1[i], y1: runs.y[i] + 1, area: 0 });
    }
    label[i] = id;
    const c = comps[id];
    if (runs.x0[i] < c.x0) c.x0 = runs.x0[i];
    if (runs.x1[i] > c.x1) c.x1 = runs.x1[i];
    if (runs.y[i] + 1 > c.y1) c.y1 = runs.y[i] + 1;
    c.area += runs.x1[i] - runs.x0[i];
  }
  return { runs, label, comps };
}

export const compW = (c: Component) => c.x1 - c.x0;
export const compH = (c: Component) => c.y1 - c.y0;

/**
 * Hauteur typique d'un caractère (≈ hauteur des minuscules), en pixels.
 * null s'il n'y a pas assez de caractères pour l'estimer.
 */
export function typicalCharHeight(comps: Component[], imgH: number): number | null {
  const hs: number[] = [];
  for (const c of comps) {
    const ch = compH(c);
    const cw = compW(c);
    if (ch < 4 || cw < 2 || ch > imgH / 12 || cw > 3 * ch || c.area < 6) continue;
    hs.push(ch);
  }
  if (hs.length < 20) return null;
  hs.sort((a, b) => a - b);
  // les points, virgules et accents tirent la médiane vers le bas : on écarte le quart inférieur
  const upper = hs.slice(Math.floor(hs.length / 4));
  return upper[Math.floor(upper.length / 2)];
}

/** Masque d'encre (1) d'une image binarisée (0 = noir). */
export function inkMask(bin: Uint8ClampedArray | Uint8Array): Uint8Array {
  const m = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) m[i] = bin[i] < 128 ? 1 : 0;
  return m;
}
