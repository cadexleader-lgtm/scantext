import type { BBox, OcrLayout, OcrLine, OcrParagraph } from "../types";

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
export function buildLayout(blocks: TessBlock[], w: number, h: number): OcrLayout {
  let rows: RowLine[] = [];
  blocks.forEach((block, bi) => {
    for (const p of block.paragraphs)
      for (const l of p.lines) {
        const words = l.words
          .filter((wd) => wd.text.trim())
          .map((wd) => ({ t: wd.text, c: Math.round(wd.confidence), b: toBBox(wd.bbox) }));
        if (words.length) rows.push({ line: { b: unionBox(words.map((x) => x.b)), words }, block: bi });
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
        // aussi, mais leurs centres sont décalés d'un interligne)
        if (verticalOverlap(a, b) < 0.6 || Math.abs(a[1] + a[3] - b[1] - b[3]) / 2 > 0.35 * medH) continue;
        const gap = Math.max(b[0] - a[2], a[0] - b[2]);
        if (gap > 1.2 * medH) continue;
        const words = [...rows[i].line.words, ...rows[j].line.words].sort((x, y) => x.b[0] - y.b[0]);
        rows[i] = { line: { b: unionBox([a, b]), words }, block: Math.min(rows[i].block, rows[j].block) };
        rows.splice(j, 1);
        changed = true;
        break outer;
      }
  }
  rows = rows.map((r) => ({ ...r, line: normalizeBullet(r.line) }));

  // 2. ordre de lecture
  const sideBySide = rows.some((r, i) => rows.some((o, j) => j > i && verticalOverlap(r.line.b, o.line.b) >= 0.5));
  const groups: OcrLine[][] = [];
  if (!sideBySide) {
    groups.push(rows.map((r) => r.line).sort((a, b) => a.b[1] + a.b[3] - (b.b[1] + b.b[3])));
  } else {
    const byBlock = new Map<number, OcrLine[]>();
    for (const r of rows) byBlock.set(r.block, [...(byBlock.get(r.block) ?? []), r.line]);
    for (const k of [...byBlock.keys()].sort((a, b) => a - b)) groups.push(byBlock.get(k)!.sort((a, b) => a.b[1] - b.b[1]));
  }

  // 3. paragraphes
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
  return { w, h, paragraphs };
}

/** Texte d'une ligne : mots séparés par une espace. */
export const lineText = (line: OcrLine): string => line.words.map((wd) => wd.t).join(" ");

/** Texte de la page : lignes séparées par un saut de ligne, paragraphes par une ligne vide. */
export function layoutToText(layout: OcrLayout): string {
  return layout.paragraphs.map((p) => p.lines.map(lineText).join("\n")).join("\n\n");
}

/**
 * Variante « tableau » : l'écart entre deux mots est rendu par un nombre
 * d'espaces proportionnel à sa largeur, pour garder les colonnes alignées.
 */
export function lineTextSpaced(line: OcrLine): string {
  const chars = line.words.reduce((n, wd) => n + wd.t.length, 0) || 1;
  const charW = Math.max(1, line.words.reduce((n, wd) => n + (wd.b[2] - wd.b[0]), 0) / chars);
  let out = "";
  line.words.forEach((wd, i) => {
    if (i) out += " ".repeat(Math.max(1, Math.round((wd.b[0] - line.words[i - 1].b[2]) / charW)));
    out += wd.t;
  });
  return out;
}

export function layoutToTextSpaced(layout: OcrLayout): string {
  return layout.paragraphs.map((p) => p.lines.map(lineTextSpaced).join("\n")).join("\n\n");
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
