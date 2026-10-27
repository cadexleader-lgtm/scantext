import type { OcrLayout, OcrParagraph } from "../types";
import { assembleText, pageOutputText, reflowText } from "../text";
import { lineText } from "../ocr/layout";

/**
 * Génération des fichiers exportés. Les bibliothèques (docx, pdf-lib) ne sont
 * chargées qu'au moment de l'export.
 */

export interface ExportPage {
  /** Texte courant (corrections incluses). */
  text: string;
  /** Vrai si le texte a été modifié depuis la reconnaissance : la structure OCR ne correspond plus. */
  edited: boolean;
  layout: OcrLayout | null;
  imageW: number;
  imageH: number;
  getImage?: () => Promise<Blob | undefined>;
}

export interface ExportOptions {
  title: string;
  /** Repères de page (TXT) / une page par page scannée (DOCX, PDF). */
  separators: boolean;
  reflow: boolean;
  docxMode: "simple" | "layout";
  includeImages: boolean;
}

// ------------------------------------------------------------------ TXT

export function buildTxt(pages: ExportPage[], opts: ExportOptions): Blob {
  const text = assembleText(pages, { separators: opts.separators, reflow: opts.reflow });
  // BOM UTF-8 : accents correctement affichés par les anciens Bloc-notes Windows
  return new Blob(["﻿" + text.replace(/\n/g, "\r\n")], { type: "text/plain;charset=utf-8" });
}

// ------------------------------------------------------------------ DOCX

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export interface ApproxParagraph {
  lines: string[];
  sizePt: number;
  bold: boolean;
  align: "left" | "center" | "right";
  indentRatio: number;
  spaceBeforeRatio: number;
}

/**
 * Mise en page approchée d'une page à partir de la géométrie OCR : taille
 * relative des caractères (titres), alignement, retrait et espacement.
 */
export function approximateLayout(layout: OcrLayout, reflow: boolean): ApproxParagraph[] {
  const paras = layout.paragraphs.filter((p) => p.lines.length);
  if (!paras.length) return [];
  const lineH = (p: OcrParagraph) => median(p.lines.map((l) => l.b[3] - l.b[1]));
  const allLines = paras.flatMap((p) => p.lines.map((l) => l.b[3] - l.b[1]));
  const bodyH = median(allLines) || 1;
  const minX = Math.min(...paras.map((p) => p.b[0]));
  const maxX = Math.max(...paras.map((p) => p.b[2]));
  const width = Math.max(1, maxX - minX);
  let prevBottom: number | null = null;
  return paras.map((p) => {
    const ratio = lineH(p) / bodyH;
    const leftGap = p.b[0] - minX;
    const rightGap = maxX - p.b[2];
    let align: ApproxParagraph["align"] = "left";
    if (leftGap > 0.1 * width && rightGap > 0.1 * width && Math.abs(leftGap - rightGap) < 0.12 * width) align = "center";
    else if (leftGap > 0.3 * width && rightGap < 0.05 * width) align = "right";
    const gap = prevBottom === null ? 0 : Math.max(0, p.b[1] - prevBottom);
    prevBottom = p.b[3];
    const lines = p.lines.map(lineText);
    return {
      lines: reflow ? [reflowText(lines.join("\n"))] : lines,
      sizePt: Math.max(8, Math.min(28, Math.round(11 * Math.min(ratio, 2.6)))),
      bold: ratio > 1.35,
      align,
      indentRatio: align === "left" ? leftGap / width : 0,
      spaceBeforeRatio: gap / bodyH,
    };
  });
}

const A4_TWIPS = { width: 11906, height: 16838, margin: 1134 }; // marges 2 cm
const CONTENT_PX = 600; // largeur utile ≈ 16 cm à 96 dpi

export async function buildDocx(pages: ExportPage[], opts: ExportOptions): Promise<Blob> {
  const { AlignmentType, Document, ImageRun, Packer, Paragraph, TextRun } = await import("docx");
  type Para = InstanceType<typeof Paragraph>;
  const children: Para[] = [];
  const alignOf = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT } as const;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pageBreak = opts.separators && i > 0;
    const pageParas: Para[] = [];

    if (opts.docxMode === "layout" && page.layout && !page.edited) {
      for (const ap of approximateLayout(page.layout, opts.reflow)) {
        pageParas.push(
          new Paragraph({
            alignment: alignOf[ap.align],
            indent: ap.indentRatio > 0.04 ? { left: Math.round(ap.indentRatio * (A4_TWIPS.width - 2 * A4_TWIPS.margin)) } : undefined,
            spacing: { before: Math.round(Math.min(ap.spaceBeforeRatio, 3) * 120), after: 60 },
            children: ap.lines.map((line, k) => new TextRun({ text: line, break: k > 0 ? 1 : 0, size: ap.sizePt * 2, bold: ap.bold })),
          }),
        );
      }
    } else {
      const text = pageOutputText(page, opts.reflow);
      for (const block of text.split(/\n\s*\n/)) {
        if (!block.trim()) continue;
        pageParas.push(
          new Paragraph({
            spacing: { after: 160 },
            children: block.split("\n").map((line, k) => new TextRun({ text: line, break: k > 0 ? 1 : 0 })),
          }),
        );
      }
    }

    if (opts.includeImages && page.getImage) {
      const blob = await page.getImage();
      if (blob) {
        const isPng = blob.type === "image/png";
        const ratio = Math.max(1, page.imageH) / Math.max(1, page.imageW);
        let w = CONTENT_PX;
        let h = Math.round(CONTENT_PX * ratio);
        if (h > 860) {
          h = 860;
          w = Math.round(860 / ratio);
        }
        pageParas.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 200, after: 200 },
            children: [
              new ImageRun({
                type: isPng ? "png" : "jpg",
                data: new Uint8Array(await blob.arrayBuffer()),
                transformation: { width: w, height: h },
              }),
            ],
          }),
        );
      }
    }

    if (!pageParas.length) pageParas.push(new Paragraph({ children: [] }));
    if (pageBreak) {
      // la première ligne de chaque page scannée commence une nouvelle page Word
      const first = pageParas[0];
      pageParas[0] = new Paragraph({ pageBreakBefore: true, children: [] });
      pageParas.splice(1, 0, first);
    }
    children.push(...pageParas);
  }

  const doc = new Document({
    creator: opts.title,
    title: opts.title,
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: A4_TWIPS.width, height: A4_TWIPS.height },
            margin: { top: A4_TWIPS.margin, bottom: A4_TWIPS.margin, left: A4_TWIPS.margin, right: A4_TWIPS.margin },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBlob(doc);
}

// ------------------------------------------------------------------ PDF

type PdfFont = Awaited<ReturnType<import("pdf-lib").PDFDocument["embedFont"]>>;

/**
 * Les polices standard PDF (Helvetica) couvrent le jeu WinAnsi (français,
 * anglais, langues d'Europe de l'Ouest). Les autres caractères sont remplacés.
 */
export function makeSanitizer(font: PdfFont): (s: string) => string {
  const cache = new Map<string, string>();
  const fallback: Record<string, string> = { " ": " ", " ": " ", " ": " ", "‑": "-", "‐": "-", "ﬁ": "fi", "ﬂ": "fl", "−": "-", "→": "->", "←": "<-", "≥": ">=", "≤": "<=" };
  return (s: string) => {
    let out = "";
    for (const ch of s.normalize("NFC")) {
      let r = cache.get(ch);
      if (r === undefined) {
        const candidate = fallback[ch] ?? ch;
        try {
          font.encodeText(candidate);
          r = candidate;
        } catch {
          const stripped = ch.normalize("NFD").replace(/\p{M}/gu, "");
          try {
            font.encodeText(stripped);
            r = stripped || "?";
          } catch {
            r = "?";
          }
        }
        cache.set(ch, r);
      }
      out += r;
    }
    return out;
  };
}

function wrapLine(text: string, font: PdfFont, size: number, maxWidth: number): string[] {
  if (!text) return [""];
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let cur = "";
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxWidth;
  for (const token of words) {
    const next = cur + token;
    if (fits(next)) {
      cur = next;
      continue;
    }
    if (cur.trim()) lines.push(cur.trimEnd());
    cur = token.trimStart();
    // mot plus long que la ligne : coupure forcée
    while (cur && !fits(cur)) {
      let k = cur.length - 1;
      while (k > 1 && !fits(cur.slice(0, k))) k--;
      lines.push(cur.slice(0, k));
      cur = cur.slice(k);
    }
  }
  if (cur.trim() || !lines.length) lines.push(cur.trimEnd());
  return lines;
}

/** PDF texte : le texte (corrigé) mis en page proprement, lisible et imprimable. */
export async function buildTextPdf(pages: ExportPage[], opts: ExportOptions): Promise<Blob> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(opts.title);
  pdf.setLanguage("fr-FR");
  pdf.setProducer(opts.title);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sanitize = makeSanitizer(font);
  const W = 595.28;
  const H = 841.89;
  const M = 56;
  const size = 11;
  const lh = 15.5;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const newPage = () => {
    page = pdf.addPage([W, H]);
    y = H - M;
  };
  pages.forEach((p, i) => {
    if (opts.separators) {
      if (i > 0) newPage();
      page.drawText(sanitize(`Page ${i + 1}`), { x: M, y: H - 34, size: 8, font, color: rgb(0.55, 0.55, 0.6) });
    }
    const text = sanitize(pageOutputText(p, opts.reflow));
    const blocks = text.split(/\n\s*\n/);
    blocks.forEach((block, bi) => {
      if (!block.trim()) return;
      if (bi > 0 || (!opts.separators && i > 0)) y -= lh * 0.6;
      for (const raw of block.split("\n")) {
        for (const line of wrapLine(raw, font, size, W - 2 * M)) {
          if (y < M) newPage();
          page.drawText(line, { x: M, y: y - size, size, font, color: rgb(0.07, 0.07, 0.1) });
          y -= lh;
        }
      }
    });
  });
  return new Blob([(await pdf.save()) as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
}

/**
 * PDF recherchable : l'image de chaque page, avec par-dessus une couche de
 * texte invisible (mode de rendu 3) placée à l'emplacement des mots reconnus.
 * Le texte est sélectionnable et trouvable avec Ctrl+F dans les lecteurs PDF.
 */
export async function buildSearchablePdf(pages: ExportPage[], opts: ExportOptions): Promise<Blob> {
  const lib = await import("pdf-lib");
  const { PDFDocument, StandardFonts, popGraphicsState, pushGraphicsState, setTextRenderingMode, TextRenderingMode } = lib;
  const pdf = await PDFDocument.create();
  pdf.setTitle(opts.title);
  pdf.setLanguage("fr-FR");
  pdf.setProducer(opts.title);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sanitize = makeSanitizer(font);

  for (const p of pages) {
    const blob = await p.getImage?.();
    const iw = Math.max(1, p.imageW);
    const ih = Math.max(1, p.imageH);
    // largeur A4 (ou hauteur A4 pour une page en paysage)
    const pw = iw >= ih ? 841.89 : 595.28;
    const s = pw / iw;
    const ph = ih * s;
    const page = pdf.addPage([pw, ph]);
    if (blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const img = blob.type === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
    }
    page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
    const drawFitted = (text: string, x0: number, y0: number, x1: number, y1: number) => {
      const t = sanitize(text);
      if (!t.trim()) return;
      const boxW = Math.max(1, (x1 - x0) * s);
      const boxH = Math.max(1, (y1 - y0) * s);
      const unit = font.widthOfTextAtSize(t, 1) || 1;
      const size = Math.max(boxH * 0.5, Math.min(boxW / unit, boxH * 1.6));
      page.drawText(t, { x: x0 * s, y: ph - y1 * s + boxH * 0.18, size, font });
    };
    if (p.layout && !p.edited) {
      for (const para of p.layout.paragraphs)
        for (const line of para.lines)
          line.words.forEach((wd, k) => {
            const spaced = k < line.words.length - 1 ? `${wd.t} ` : wd.t;
            const next = line.words[k + 1];
            drawFitted(spaced, wd.b[0], wd.b[1], next ? next.b[0] : wd.b[2], wd.b[3]);
          });
    } else {
      // texte corrigé : chaque ligne est placée sur une ligne détectée (position approchée)
      const textLines = p.text.split("\n").filter((l) => l.trim());
      const ocrLines = p.layout ? p.layout.paragraphs.flatMap((pa) => pa.lines.map((l) => l.b)) : [];
      const step = ocrLines.length > 1 ? (ocrLines[ocrLines.length - 1][1] - ocrLines[0][1]) / (ocrLines.length - 1) : ih / 50;
      const left = ocrLines.length ? Math.min(...ocrLines.map((b) => b[0])) : iw * 0.08;
      const right = ocrLines.length ? Math.max(...ocrLines.map((b) => b[2])) : iw * 0.92;
      textLines.forEach((line, k) => {
        const b = ocrLines[k];
        if (b) drawFitted(line, b[0], b[1], b[2], b[3]);
        else {
          const last = ocrLines[ocrLines.length - 1];
          const top = (last ? last[3] : ih * 0.06) + (k - ocrLines.length) * step + step * 0.2;
          drawFitted(line, left, top, right, top + step * 0.7);
        }
      });
    }
    page.pushOperators(popGraphicsState());
  }
  return new Blob([(await pdf.save()) as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
}
