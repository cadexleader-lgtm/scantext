import type { Ruling } from "../image/ocr-prep";
import type { BBox, OcrCell, OcrLine, OcrTable, OcrWord } from "../types";

/**
 * Reconstruction des tableaux à partir des mots reconnus.
 *
 *  - Tableau à règles : les traits horizontaux et verticaux repérés lors de la
 *    préparation de l'image forment une grille ; chaque mot va dans la case
 *    qui contient son centre. Les cases fusionnées (trait absent entre deux
 *    cases) sont respectées.
 *  - Tableau sans règles (mode « Tableau ») : des colonnes de blanc continues,
 *    communes à plusieurs lignes consécutives, séparent les colonnes.
 *
 * Le texte d'un tableau est rendu en colonnes séparées par des tabulations
 * (une ligne par rangée) : collé dans un tableur ou un traitement de texte, il
 * retrouve ses colonnes.
 */

const center = (b: BBox) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] as const;

export function unionBox(boxes: BBox[]): BBox {
  if (!boxes.length) return [0, 0, 0, 0];
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

/** Regroupe des positions proches (à tol près) ; renvoie les moyennes triées. */
function clusterPositions(values: number[], tol: number): number[] {
  const s = [...values].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const v of s) {
    const last = out[out.length - 1];
    if (last && v - last[last.length - 1] <= tol) last.push(v);
    else out.push([v]);
  }
  return out.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
}

/** Mots d'une case dans l'ordre de lecture (lignes de la case, puis gauche → droite). */
function readingOrder(words: OcrWord[]): OcrWord[] {
  const byY = [...words].sort((a, b) => a.b[1] + a.b[3] - b.b[1] - b.b[3]);
  const lines: OcrWord[][] = [];
  for (const w of byY) {
    const line = lines.find((l) => {
      const o = Math.min(l[0].b[3], w.b[3]) - Math.max(l[0].b[1], w.b[1]);
      return o > 0.5 * Math.min(l[0].b[3] - l[0].b[1], w.b[3] - w.b[1]);
    });
    if (line) line.push(w);
    else lines.push([w]);
  }
  return lines.flatMap((l) => l.sort((a, b) => a.b[0] - b.b[0]));
}

interface Grid {
  b: BBox;
  rows: number[];
  cols: number[];
  /** Pour chaque case de la grille : index de la case fusionnée. */
  owner: Int32Array;
  cells: { r: number; c: number; rs: number; cs: number }[];
  ruled: boolean;
}

/** Grilles formées par des traits qui se croisent (au moins 2 × 2 cases). */
export function gridsFromRulings(rulings: Ruling[], tol: number): Grid[] {
  const hs = rulings.filter((r) => r.horizontal);
  const vs = rulings.filter((r) => !r.horizontal);
  if (hs.length < 2 || vs.length < 2) return [];
  const all = [...hs, ...vs];
  const parent = all.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  hs.forEach((h, i) => {
    const hy = (h.y0 + h.y1) / 2;
    vs.forEach((v, j) => {
      const vx = (v.x0 + v.x1) / 2;
      if (vx >= h.x0 - tol && vx <= h.x1 + tol && hy >= v.y0 - tol && hy <= v.y1 + tol) parent[find(i)] = find(hs.length + j);
    });
  });
  const groups = new Map<number, number[]>();
  all.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });
  const grids: Grid[] = [];
  for (const members of groups.values()) {
    const gh = members.filter((i) => i < hs.length).map((i) => hs[i]);
    const gv = members.filter((i) => i >= hs.length).map((i) => vs[i - hs.length]);
    if (gh.length < 2 || gv.length < 2) continue;
    const b: BBox = [
      Math.min(...gh.map((r) => r.x0), ...gv.map((r) => r.x0)),
      Math.min(...gh.map((r) => r.y0), ...gv.map((r) => r.y0)),
      Math.max(...gh.map((r) => r.x1), ...gv.map((r) => r.x1)),
      Math.max(...gh.map((r) => r.y1), ...gv.map((r) => r.y1)),
    ];
    const rows = clusterPositions(
      gh.map((r) => (r.y0 + r.y1) / 2),
      tol,
    );
    const cols = clusterPositions(
      gv.map((r) => (r.x0 + r.x1) / 2),
      tol,
    );
    // bord extérieur sans trait : la grille s'arrête au bout des traits
    if (rows[0] - b[1] > tol) rows.unshift(b[1]);
    if (b[3] - rows[rows.length - 1] > tol) rows.push(b[3]);
    if (cols[0] - b[0] > tol) cols.unshift(b[0]);
    if (b[2] - cols[cols.length - 1] > tol) cols.push(b[2]);
    const nr = rows.length - 1;
    const nc = cols.length - 1;
    if (nr < 1 || nc < 2 || (nr < 2 && nc < 2)) continue;
    // séparateurs présents entre cases voisines ?
    const covers = (lo: number, hi: number, a: number, b2: number) => Math.max(0, Math.min(hi, b2) - Math.max(lo, a)) >= 0.5 * (b2 - a);
    const vSep = (k: number, r: number) =>
      gv.some((v) => Math.abs((v.x0 + v.x1) / 2 - cols[k]) <= tol && covers(v.y0, v.y1, rows[r], rows[r + 1]));
    const hSep = (k: number, c: number) =>
      gh.some((h) => Math.abs((h.y0 + h.y1) / 2 - rows[k]) <= tol && covers(h.x0, h.x1, cols[c], cols[c + 1]));
    const uf = Array.from({ length: nr * nc }, (_, i) => i);
    const f = (i: number): number => (uf[i] === i ? i : (uf[i] = f(uf[i])));
    for (let r = 0; r < nr; r++)
      for (let c = 0; c < nc; c++) {
        if (c + 1 < nc && !vSep(c + 1, r)) uf[f(r * nc + c)] = f(r * nc + c + 1);
        if (r + 1 < nr && !hSep(r + 1, c)) uf[f(r * nc + c)] = f((r + 1) * nc + c);
      }
    const rects = new Map<number, { r0: number; r1: number; c0: number; c1: number }>();
    for (let r = 0; r < nr; r++)
      for (let c = 0; c < nc; c++) {
        const k = f(r * nc + c);
        const e = rects.get(k);
        if (!e) rects.set(k, { r0: r, r1: r, c0: c, c1: c });
        else {
          e.r0 = Math.min(e.r0, r);
          e.r1 = Math.max(e.r1, r);
          e.c0 = Math.min(e.c0, c);
          e.c1 = Math.max(e.c1, c);
        }
      }
    const owner = new Int32Array(nr * nc).fill(-1);
    const cells: Grid["cells"] = [];
    for (const e of [...rects.values()].sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0)) {
      let free = false;
      for (let r = e.r0; r <= e.r1; r++) for (let c = e.c0; c <= e.c1; c++) if (owner[r * nc + c] < 0) free = true;
      if (!free) continue;
      const id = cells.length;
      for (let r = e.r0; r <= e.r1; r++) for (let c = e.c0; c <= e.c1; c++) if (owner[r * nc + c] < 0) owner[r * nc + c] = id;
      cells.push({ r: e.r0, c: e.c0, rs: e.r1 - e.r0 + 1, cs: e.c1 - e.c0 + 1 });
    }
    // une grille entièrement fusionnée n'est qu'un cadre autour d'un texte
    if (cells.length < 2) continue;
    grids.push({ b, rows, cols, owner, cells, ruled: true });
  }
  return grids;
}

const idx = (pos: number[], v: number) => {
  let i = 0;
  while (i < pos.length - 2 && v >= pos[i + 1]) i++;
  return i;
};

/**
 * Range les mots dans les cases. `rest[i]` est la ligne i privée des mots
 * passés dans le tableau (null si elle y est entièrement).
 */
export function fillGrid(grid: Grid, lines: OcrLine[], tol: number): { table: OcrTable; rest: (OcrLine | null)[] } | null {
  const nc = grid.cols.length - 1;
  const buckets: OcrWord[][] = grid.cells.map(() => []);
  const rest: (OcrLine | null)[] = [];
  let used = 0;
  for (const line of lines) {
    const keep: OcrWord[] = [];
    for (const w of line.words) {
      const [cx, cy] = center(w.b);
      if (cx < grid.b[0] - tol || cx > grid.b[2] + tol || cy < grid.b[1] - tol || cy > grid.b[3] + tol) {
        keep.push(w);
        continue;
      }
      const id = grid.owner[idx(grid.rows, cy) * nc + idx(grid.cols, cx)];
      buckets[id].push(w);
      used++;
    }
    if (keep.length === line.words.length) rest.push(line);
    else rest.push(keep.length ? { b: unionBox(keep.map((w) => w.b)), words: keep } : null);
  }
  if (!used) return null;
  const cells: OcrCell[] = grid.cells.map((c, i) => ({
    ...c,
    b: [grid.cols[c.c], grid.rows[c.r], grid.cols[c.c + c.cs], grid.rows[c.r + c.rs]],
    words: readingOrder(buckets[i]),
  }));
  return { table: { b: grid.b, nr: grid.rows.length - 1, nc, cells, ruled: grid.ruled }, rest };
}

/**
 * Tableaux sans règles : suites d'au moins trois rangées consécutives
 * partageant des colonnes de blanc (gouttières) assez larges. Les morceaux de
 * ligne côte à côte (le moteur découpe souvent un tableau en colonnes) sont
 * d'abord regroupés en rangées.
 *
 * `strict` (lecture automatique) : n'accepte que des cases courtes (≤ 3 mots
 * en médiane), pour ne pas transformer une page en colonnes de texte suivi en
 * tableau.
 * Renvoie les tableaux et les index des lignes qu'ils ont absorbées.
 */
export function borderlessTables(lines: OcrLine[], medH: number, strict = false): { tables: OcrTable[]; used: Set<number> } {
  const minGutter = (strict ? 1.8 : 1.4) * medH;
  // rangées visuelles
  const order = lines.map((_, i) => i).sort((a, b) => lines[a].b[1] + lines[a].b[3] - lines[b].b[1] - lines[b].b[3]);
  const rows: { idx: number[]; b: BBox; words: OcrWord[] }[] = [];
  for (const i of order) {
    const l = lines[i];
    const last = rows[rows.length - 1];
    const o = last ? Math.min(last.b[3], l.b[3]) - Math.max(last.b[1], l.b[1]) : 0;
    if (last && o > 0.5 * Math.min(last.b[3] - last.b[1], l.b[3] - l.b[1])) {
      last.idx.push(i);
      last.b = unionBox([last.b, l.b]);
      last.words.push(...l.words);
    } else rows.push({ idx: [i], b: l.b, words: [...l.words] });
  }
  for (const r of rows) r.words.sort((a, b) => a.b[0] - b.b[0]);
  const gutters = (run: typeof rows): [number, number][] => {
    const boxes = run.flatMap((r) => r.words.map((w) => [w.b[0], w.b[2]] as [number, number])).sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    let end = boxes[0]?.[1] ?? 0;
    for (const [x0, x1] of boxes) {
      if (x0 - end >= minGutter) out.push([end, x0]);
      end = Math.max(end, x1);
    }
    return out;
  };
  const splits = (r: (typeof rows)[number]) => {
    let n = 0;
    for (let i = 1; i < r.words.length; i++) if (r.words[i].b[0] - r.words[i - 1].b[2] >= minGutter) n++;
    return n;
  };
  const tables: OcrTable[] = [];
  const used = new Set<number>();
  let i = 0;
  while (i < rows.length) {
    if (!splits(rows[i])) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < rows.length) {
      if (rows[j].b[1] - rows[j - 1].b[3] > 2.5 * medH) break;
      if (!gutters(rows.slice(i, j + 1)).length) break;
      j++;
    }
    const run = rows.slice(i, j);
    const g = gutters(run);
    const multi = run.filter((r) => splits(r) > 0).length;
    if (run.length < 3 || !g.length || multi < Math.ceil(run.length * 0.6)) {
      i++;
      continue;
    }
    const b = unionBox(run.map((r) => r.b));
    const cols = [b[0], ...g.map(([a, c]) => (a + c) / 2), b[2]];
    const nc = cols.length - 1;
    // une rangée qui n'a de texte que dans une colonne autre que la première
    // prolonge la case du dessus (texte de case sur plusieurs lignes)
    const rowsWords: OcrWord[][][] = [];
    const rowBoxes: BBox[] = [];
    for (const r of run) {
      const cellsW: OcrWord[][] = Array.from({ length: nc }, () => []);
      for (const w of r.words) cellsW[idx(cols, (w.b[0] + w.b[2]) / 2)].push(w);
      const filled = cellsW.map((c, k) => (c.length ? k : -1)).filter((k) => k >= 0);
      if (rowsWords.length && filled.length === 1 && filled[0] > 0) {
        rowsWords[rowsWords.length - 1][filled[0]].push(...cellsW[filled[0]]);
        rowBoxes[rowBoxes.length - 1] = unionBox([rowBoxes[rowBoxes.length - 1], r.b]);
        continue;
      }
      rowsWords.push(cellsW);
      rowBoxes.push(r.b);
    }
    if (strict) {
      const counts = rowsWords.flatMap((cw) => cw.filter((c) => c.length).map((c) => c.length)).sort((a, b) => a - b);
      if (rowsWords.length < 3 || counts[Math.floor(counts.length / 2)] > 3) {
        i++;
        continue;
      }
    }
    const yb = [b[1], ...rowBoxes.slice(1).map((rb, k) => (rowBoxes[k][3] + rb[1]) / 2), b[3]];
    const cells: OcrCell[] = [];
    rowsWords.forEach((cw, r) =>
      cw.forEach((words, c) => cells.push({ r, c, rs: 1, cs: 1, b: [cols[c], yb[r], cols[c + 1], yb[r + 1]], words: readingOrder(words) })),
    );
    tables.push({ b, nr: rowsWords.length, nc, cells, ruled: false });
    for (const r of run) for (const k of r.idx) used.add(k);
    i = j;
  }
  return { tables, used };
}

/** Texte d'un tableau : une rangée par ligne, cases séparées par des tabulations. */
export function tableToText(t: OcrTable): string {
  const grid: string[][] = Array.from({ length: t.nr }, () => new Array<string>(t.nc).fill(""));
  for (const c of t.cells) grid[c.r][c.c] = c.words.map((w) => w.t).join(" ");
  return grid
    .filter((row) => row.some((v) => v))
    .map((row) => row.join("\t"))
    .join("\n");
}
