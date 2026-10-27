import type { Ruling } from "../image/ocr-prep";
import type { BBox, LayoutMode, OcrLayout, OcrLine, OcrParagraph, OcrTable } from "../types";
import { borderlessTables, fillGrid, gridsFromRulings, tableToText } from "./tables";

/** Forme minimale des blocs renvoyés par Tesseract.js (sortie `blocks`). */
export interface TessBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface TessWord {
  text: string;
  confidence: number;
  bbox: TessBBox;
}
export interface TessLine {
  text: string;
  confidence: number;
  bbox: TessBBox;
  words: TessWord[];
  baseline?: TessBBox & { has_baseline?: boolean };
  rowAttributes?: { rowHeight: number; descenders: number; ascenders: number };
}
export interface TessBlock {
  bbox: TessBBox;
  paragraphs: { bbox: TessBBox; lines: TessLine[] }[];
}

const toBBox = (b: TessBBox): BBox => [b.x0, b.y0, b.x1, b.y1];
const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function unionBox(boxes: BBox[]): BBox {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

interface RowLine {
  line: OcrLine;
  block: number;
}

const height = (b: BBox) => b[3] - b[1];
/** Ordonnée de la ligne de base en x (prolongée au-delà de ses extrémités). */
export function baselineAt(bl: BBox, x: number): number {
  const dx = bl[2] - bl[0];
  return dx ? bl[1] + ((bl[3] - bl[1]) * (x - bl[0])) / dx : bl[1];
}
/** Recouvrement vertical relatif de deux lignes (0 = aucun, 1 = même hauteur). */
function verticalOverlap(a: BBox, b: BBox): number {
  const o = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return o <= 0 ? 0 : o / Math.max(1, Math.min(height(a), height(b)));
}

/**
 * Une puce typographique (•) est souvent lue comme « . », « e », « « »… :
 * premier « mot » d'une seule marque, très étroit, suivi d'autres mots.
 */
const BULLET_LIKE = /^[.,;:·•«»*°o©¢e-]$/;
function normalizeBullet(line: OcrLine): OcrLine {
  const [first, ...rest] = line.words;
  if (!first || !rest.length || !BULLET_LIKE.test(first.t)) return line;
  const w = first.b[2] - first.b[0];
  if (w > 0.8 * height(line.b)) return line;
  if (first.t === "-") return line; // tiret de liste : conservé tel quel
  return { ...line, words: [{ ...first, t: "•" }, ...rest] };
}

/**
 * Reconstruit l'ordre de lecture et les paragraphes à partir de la géométrie.
 *
 * Tesseract découpe parfois une même ligne en plusieurs morceaux (page un peu
 * inclinée ou courbée) et les range dans des blocs différents : le texte sort
 * alors dans le désordre. Ici :
 *  1. les morceaux situés sur la même ligne et proches sont recollés ;
 *  2. s'il n'y a qu'une colonne, les lignes sont lues de haut en bas ;
 *     sinon (colonnes, tableau), l'ordre des blocs de Tesseract est conservé ;
 *  3. un paragraphe commence après un interligne nettement plus grand, un
 *     changement franc de taille de caractères (titre) ou un retrait.
 */
export function buildLayout(
  blocks: TessBlock[],
  w: number,
  h: number,
  opts: { rulings?: Ruling[]; mode?: LayoutMode } = {},
): OcrLayout {
  let rows: RowLine[] = [];
  blocks.forEach((block, bi) => {
    for (const p of block.paragraphs)
      for (const l of p.lines) {
        const words = l.words
          .filter((wd) => wd.text.trim())
          .map((wd) => ({ t: wd.text, c: Math.round(wd.confidence), b: toBBox(wd.bbox) }));
        if (!words.length) continue;
        const line: OcrLine = { b: unionBox(words.map((x) => x.b)), words };
        if (l.baseline && l.baseline.x1 > l.baseline.x0) line.bl = toBBox(l.baseline);
        if (l.rowAttributes?.rowHeight) line.rh = l.rowAttributes.rowHeight;
        rows.push({ line, block: bi });
      }
  });
  if (!rows.length) return { w, h, paragraphs: [] };
  const medH = median(rows.map((r) => height(r.line.b))) || 1;

  // 1. recoller les morceaux d'une même ligne
  for (let changed = true; changed; ) {
    changed = false;
    outer: for (let i = 0; i < rows.length; i++)
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i].line.b;
        const b = rows[j].line.b;
        // même ligne : centres à la même hauteur (deux lignes voisines penchées se chevauchent
        // aussi, mais leurs centres sont décalés d'un interligne) ; avec les lignes de base,
        // le prolongement de l'une doit rejoindre l'autre
        if (verticalOverlap(a, b) < 0.6) continue;
        const gap = Math.max(b[0] - a[2], a[0] - b[2]);
        if (gap > 1.2 * medH) continue;
        const [left, right] = a[0] <= b[0] ? [rows[i].line, rows[j].line] : [rows[j].line, rows[i].line];
        const mismatch =
          left.bl && right.bl
            ? Math.abs(baselineAt(left.bl, right.b[0]) - baselineAt(right.bl, right.b[0]))
            : Math.abs(a[1] + a[3] - b[1] - b[3]) / 2;
        if (mismatch > 0.35 * medH) continue;
        const words = [...left.words, ...right.words].sort((x, y) => x.b[0] - y.b[0]);
        const merged: OcrLine = { b: unionBox([a, b]), words };
        if (left.bl && right.bl) merged.bl = [left.bl[0], left.bl[1], right.bl[2], right.bl[3]];
        if (left.rh || right.rh) merged.rh = Math.max(left.rh ?? 0, right.rh ?? 0);
        rows[i] = { line: merged, block: Math.min(rows[i].block, rows[j].block) };
        rows.splice(j, 1);
        changed = true;
        break outer;
      }
  }
  rows = rows.map((r) => ({ ...r, line: normalizeBullet(r.line) }));

  // 2. tableaux : grilles de traits, puis (mode Tableau) colonnes séparées par des blancs
  const tables: OcrTable[] = [];
  const tol = Math.max(3, 0.5 * medH);
  for (const grid of gridsFromRulings(opts.rulings ?? [], tol)) {
    const res = fillGrid(
      grid,
      rows.map((r) => r.line),
      tol,
    );
    if (!res) continue;
    tables.push(res.table);
    rows = rows.flatMap((r, i) => (res.rest[i] ? [{ ...r, line: res.rest[i]! }] : []));
  }
  {
    const found = borderlessTables(
      rows.map((r) => r.line),
      medH,
      opts.mode !== "table",
    );
    tables.push(...found.tables);
    rows = rows.filter((_, i) => !found.used.has(i));
  }

  // 3. ordre de lecture
  const sideBySide = rows.some((r, i) => rows.some((o, j) => j > i && verticalOverlap(r.line.b, o.line.b) >= 0.5));
  const groups: OcrLine[][] = [];
  if (!sideBySide) {
    groups.push(rows.map((r) => r.line).sort((a, b) => a.b[1] + a.b[3] - (b.b[1] + b.b[3])));
  } else {
    const byBlock = new Map<number, OcrLine[]>();
    for (const r of rows) byBlock.set(r.block, [...(byBlock.get(r.block) ?? []), r.line]);
    for (const k of [...byBlock.keys()].sort((a, b) => a - b)) groups.push(byBlock.get(k)!.sort((a, b) => a.b[1] - b.b[1]));
  }

  // 4. paragraphes
  const paragraphs: OcrParagraph[] = [];
  for (const lines of groups) {
    const left = Math.min(...lines.map((l) => l.b[0]));
    let current: OcrLine[] = [];
    for (const line of lines) {
      if (current.length) {
        const prev = current[current.length - 1];
        const gap = line.b[1] - prev.b[3];
        const hPrev = height(prev.b);
        const hCur = height(line.b);
        const sizeJump = Math.max(hPrev, hCur) / Math.max(1, Math.min(hPrev, hCur)) > 1.35;
        const bigGap = gap > 0.9 * medH;
        const indent = line.b[0] - left > 1.5 * medH && prev.b[0] - left < 0.5 * medH;
        if (bigGap || sizeJump || indent) {
          paragraphs.push({ b: unionBox(current.map((l) => l.b)), lines: current });
          current = [];
        }
      }
      current.push(line);
    }
    if (current.length) paragraphs.push({ b: unionBox(current.map((l) => l.b)), lines: current });
  }

  // 5. chaque tableau prend place avant le premier paragraphe situé plus bas
  for (const t of tables.sort((a, b) => a.b[1] - b.b[1])) {
    const para: OcrParagraph = { b: t.b, lines: t.cells.map((c) => ({ b: c.b, words: c.words })), table: t };
    const k = paragraphs.findIndex(
      (p) => !p.table && p.b[1] > t.b[1] && (!sideBySide || Math.min(p.b[2], t.b[2]) > Math.max(p.b[0], t.b[0])),
    );
    if (k < 0) paragraphs.push(para);
    else paragraphs.splice(k, 0, para);
  }
  return { w, h, paragraphs };
}

/** Texte d'une ligne : mots séparés par une espace. */
export const lineText = (line: OcrLine): string => line.words.map((wd) => wd.t).join(" ");

/** Texte d'un paragraphe (un tableau : colonnes séparées par des tabulations). */
export const paragraphText = (p: OcrParagraph): string => (p.table ? tableToText(p.table) : p.lines.map(lineText).join("\n"));

/** Texte de la page : lignes séparées par un saut de ligne, paragraphes par une ligne vide. */
export function layoutToText(layout: OcrLayout): string {
  return layout.paragraphs.map(paragraphText).filter(Boolean).join("\n\n");
}

export function wordStats(layout: OcrLayout): { count: number; lowConfidence: number; meanConfidence: number } {
  let count = 0;
  let low = 0;
  let sum = 0;
  for (const p of layout.paragraphs)
    for (const l of p.lines)
      for (const wd of l.words) {
        count++;
        sum += wd.c;
        if (wd.c < 60) low++;
      }
  return { count, lowConfidence: low, meanConfidence: count ? sum / count : 0 };
}
