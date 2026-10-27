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

/**
 * Regroupe les lignes en paragraphes d'après leur géométrie : Tesseract détecte
 * mal les paragraphes (souvent un seul pour toute la page). Une nouvelle ligne
 * ouvre un paragraphe si l'interligne est nettement plus grand, si la hauteur
 * de ligne change franchement (titre) ou si la ligne est en retrait.
 */
export function buildLayout(blocks: TessBlock[], w: number, h: number): OcrLayout {
  const paragraphs: OcrParagraph[] = [];
  for (const block of blocks) {
    const lines: { line: OcrLine; text: string }[] = [];
    for (const p of block.paragraphs)
      for (const l of p.lines) {
        const words = l.words
          .filter((wd) => wd.text.trim())
          .map((wd) => ({ t: wd.text, c: Math.round(wd.confidence), b: toBBox(wd.bbox) }));
        if (!words.length) continue;
        lines.push({ line: { b: toBBox(l.bbox), words }, text: l.text });
      }
    if (!lines.length) continue;
    const heights = lines.map(({ line }) => line.b[3] - line.b[1]);
    const medH = median(heights) || 1;
    const blockLeft = Math.min(...lines.map(({ line }) => line.b[0]));
    let current: OcrLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      const { line } = lines[i];
      if (current.length) {
        const prev = current[current.length - 1];
        const gap = line.b[1] - prev.b[3];
        const hPrev = prev.b[3] - prev.b[1];
        const hCur = line.b[3] - line.b[1];
        const sizeJump = Math.max(hPrev, hCur) / Math.max(1, Math.min(hPrev, hCur)) > 1.35;
        const bigGap = gap > 0.75 * medH;
        const indent = line.b[0] - blockLeft > 1.5 * medH && prev.b[0] - blockLeft < 0.5 * medH;
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
 * Variante qui conserve l'espacement produit par Tesseract à l'intérieur des
 * lignes (mode tableau : colonnes alignées par des espaces).
 */
export function layoutToTextWithSpacing(layout: OcrLayout, rawLines: Map<string, string>): string {
  return layout.paragraphs
    .map((p) => p.lines.map((l) => (rawLines.get(l.b.join(",")) ?? lineText(l)).replace(/\s+$/, "")).join("\n"))
    .join("\n\n");
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
