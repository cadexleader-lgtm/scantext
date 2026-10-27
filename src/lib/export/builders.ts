import type { OcrLayout, OcrLine, OcrParagraph } from "../types";
import { assembleText, pageOutputText, reflowText } from "../text";
import { alignTokens, layoutWords, tokenize } from "../ocr/align";
import { baselineAt, lineText } from "../ocr/layout";
import { tableToText } from "../ocr/tables";
import { parseBlocks } from "../text-blocks";

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
  /** Tableau : rangées de cases. */
  table?: string[][];
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
    const ratio = p.table ? 1 : lineH(p) / bodyH;
    const leftGap = p.b[0] - minX;
    const rightGap = maxX - p.b[2];
    let align: ApproxParagraph["align"] = "left";
    if (leftGap > 0.1 * width && rightGap > 0.1 * width && Math.abs(leftGap - rightGap) < 0.12 * width) align = "center";
    else if (leftGap > 0.3 * width && rightGap < 0.05 * width) align = "right";
    const gap = prevBottom === null ? 0 : Math.max(0, p.b[1] - prevBottom);
    prevBottom = p.b[3];
    const lines = p.table ? [] : p.lines.map(lineText);
    return {
      table: p.table ? tableToText(p.table).split("\n").map((r) => r.split("\t")) : undefined,
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
  const { AlignmentType, BorderStyle, Document, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import("docx");
  type Para = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
  const children: Para[] = [];
  const alignOf = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT } as const;
  const line = { style: BorderStyle.SINGLE, size: 4, color: "8A8A8A" };
  /** Vrai tableau Word (colonnes de largeur proportionnelle à leur contenu). */
  const wordTable = (rows: string[][]) => {
    const cols = Math.max(...rows.map((r) => r.length));
    const weight = Array.from({ length: cols }, (_, c) => Math.max(4, ...rows.map((r) => Math.min(40, (r[c] ?? "").length))));
    const total = weight.reduce((a, b) => a + b, 0);
    const usable = A4_TWIPS.width - 2 * A4_TWIPS.margin;
    const widths = weight.map((w) => Math.round((usable * w) / total));
    return new Table({
      width: { size: usable, type: WidthType.DXA },
      columnWidths: widths,
      borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
      rows: rows.map(
        (r) =>
          new TableRow({
            children: widths.map(
              (w, c) =>
                new TableCell({
                  width: { size: w, type: WidthType.DXA },
                  margins: { top: 40, bottom: 40, left: 80, right: 80 },
                  children: [new Paragraph({ children: [new TextRun({ text: r[c] ?? "" })] })],
                }),
            ),
          }),
      ),
    });
  };

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pageBreak = opts.separators && i > 0;
    const pageParas: Para[] = [];

    if (opts.docxMode === "layout" && page.layout && !page.edited) {
      for (const ap of approximateLayout(page.layout, opts.reflow)) {
        if (ap.table) {
          pageParas.push(wordTable(ap.table), new Paragraph({ spacing: { after: 60 }, children: [] }));
          continue;
        }
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
      for (const block of parseBlocks(pageOutputText(page, opts.reflow))) {
        if (block.kind === "table") {
          pageParas.push(wordTable(block.rows), new Paragraph({ spacing: { after: 100 }, children: [] }));
          continue;
        }
        pageParas.push(
          new Paragraph({
            spacing: { after: 160 },
            children: block.lines.map((l, k) => new TextRun({ text: l, break: k > 0 ? 1 : 0 })),
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
      // chaque page scannée commence une nouvelle page Word
      pageParas.unshift(new Paragraph({ pageBreakBefore: true, children: [] }));
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
      if (ch === "\n" || ch === "\t") {
        out += ch;
        continue;
      }
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
  const ink = rgb(0.07, 0.07, 0.1);
  const border = rgb(0.6, 0.6, 0.63);
  const drawTable = (rows: string[][]) => {
    const pad = 4;
    const cols = Math.max(...rows.map((r) => r.length));
    const natural = Array.from({ length: cols }, (_, c) => Math.max(30, ...rows.map((r) => font.widthOfTextAtSize(r[c] ?? "", size) + 2 * pad)));
    const sum = natural.reduce((a, b) => a + b, 0);
    const avail = W - 2 * M;
    const widths = sum <= avail ? natural : natural.map((n) => (n / sum) * avail);
    for (const r of rows) {
      const cells = widths.map((w, c) => wrapLine(r[c] ?? "", font, size, w - 2 * pad));
      const rowH = Math.max(...cells.map((l) => l.length)) * lh + 2 * pad - (lh - size);
      if (y - rowH < M) newPage();
      let x = M;
      cells.forEach((lines, c) => {
        page.drawRectangle({ x, y: y - rowH, width: widths[c], height: rowH, borderColor: border, borderWidth: 0.6 });
        lines.forEach((l, k) => page.drawText(l, { x: x + pad, y: y - pad - size - k * lh + 2, size, font, color: ink }));
        x += widths[c];
      });
      y -= rowH;
    }
    y -= lh * 0.4;
  };
  pages.forEach((p, i) => {
    if (opts.separators) {
      if (i > 0) newPage();
      page.drawText(sanitize(`Page ${i + 1}`), { x: M, y: H - 34, size: 8, font, color: rgb(0.55, 0.55, 0.6) });
    }
    parseBlocks(sanitize(pageOutputText(p, opts.reflow))).forEach((block, bi) => {
      if (bi > 0 || (!opts.separators && i > 0)) y -= lh * 0.6;
      if (block.kind === "table") {
        drawTable(block.rows);
        return;
      }
      for (const raw of block.lines) {
        for (const line of wrapLine(raw, font, size, W - 2 * M)) {
          if (y < M) newPage();
          page.drawText(line, { x: M, y: y - size, size, font, color: ink });
          y -= lh;
        }
      }
    });
  });
  return new Blob([(await pdf.save()) as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
}

export interface PlacedWord {
  text: string;
  /** Boîte du mot (pixels de l'image). */
  x0: number;
  x1: number;
  /** Ligne de base et taille des caractères (pixels de l'image). */
  baseline: number;
  size: number;
  /** Mots d'une même ligne : même valeur. */
  line: number;
}

/**
 * Position de chaque mot du texte courant sur l'image : le texte (corrigé ou
 * non) est aligné mot à mot sur les mots reconnus, si bien qu'un mot corrigé
 * garde l'emplacement exact du mot d'origine. Un mot ajouté à la main est
 * rattaché au mot reconnu qui le précède.
 */
export function placeWords(text: string, layout: OcrLayout): PlacedWord[] {
  const refs = layoutWords(layout);
  const tokens = tokenize(text);
  const match = alignTokens(
    tokens.map((t) => t.text),
    refs.map((r) => r.word.t),
  );
  const texts: string[][] = refs.map(() => []);
  let pending: string[] = [];
  let last = -1;
  tokens.forEach((t, i) => {
    const k = match[i];
    if (k >= 0) {
      texts[k].push(...pending, t.text);
      pending = [];
      last = k;
    } else if (last >= 0) texts[last].push(t.text);
    else pending.push(t.text);
  });
  if (pending.length && refs.length) texts[0].unshift(...pending);
  const heights = refs.map((r) => r.word.b[3] - r.word.b[1]).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 10;
  const lineIds = new Map<OcrLine, number>();
  const out: PlacedWord[] = [];
  refs.forEach((r, k) => {
    if (!texts[k].length) return; // mot supprimé du texte
    const w = r.word;
    let baseline: number;
    let size: number;
    let line: number;
    if (r.line) {
      if (!lineIds.has(r.line)) lineIds.set(r.line, lineIds.size);
      line = lineIds.get(r.line)!;
      const lh = r.line.rh ?? r.line.b[3] - r.line.b[1];
      // jambages compris, les lettres occupent ≈ 93 % du corps de la police
      size = lh / 0.93;
      baseline = r.line.bl ? baselineAt(r.line.bl, w.b[0]) : r.line.b[3] - 0.2 * size;
    } else {
      // mot de tableau : estimation à partir de sa propre boîte
      line = 100_000 + k;
      size = Math.max(w.b[3] - w.b[1], medH) / 0.72;
      baseline = w.b[3] - 0.12 * size;
    }
    out.push({ text: texts[k].join(" "), x0: w.b[0], x1: w.b[2], baseline, size, line });
  });
  return out;
}

/**
 * PDF recherchable : l'image de chaque page, avec par-dessus une couche de
 * texte invisible placée exactement sur les mots de l'image : chaque mot a la
 * largeur du mot photographié (étirement horizontal), suivi d'une espace qui
 * va jusqu'au mot suivant. Sélection, copie et recherche (Ctrl+F) tombent donc
 * sur le bon mot de la photo.
 */
export async function buildSearchablePdf(pages: ExportPage[], opts: ExportOptions): Promise<Blob> {
  const lib = await import("pdf-lib");
  const {
    PDFDocument,
    StandardFonts,
    beginText,
    endText,
    popGraphicsState,
    pushGraphicsState,
    setCharacterSqueeze,
    setFontAndSize,
    setTextMatrix,
    setTextRenderingMode,
    showText,
    TextRenderingMode,
  } = lib;
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
    const words = p.layout && p.layout.paragraphs.length ? placeWords(p.text, p.layout) : approximatePlacement(p.text, iw, ih);
    if (!words.length) continue;
    const key = page.node.newFontDictionary(font.name, font.ref);
    const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
    words.forEach((wd, k) => {
      const next = words[k + 1];
      const sameLine = next && next.line === wd.line && next.x0 > wd.x0;
      const t = sanitize(sameLine ? `${wd.text} ` : wd.text);
      if (!t.trim()) return;
      const size = Math.max(1, wd.size * s);
      const natural = font.widthOfTextAtSize(t, size);
      const target = ((sameLine ? next.x0 : wd.x1) - wd.x0) * s;
      const squeeze = natural > 0 ? Math.max(5, Math.min(1000, (100 * target) / natural)) : 100;
      ops.push(
        setFontAndSize(key, size),
        setCharacterSqueeze(squeeze),
        setTextMatrix(1, 0, 0, 1, wd.x0 * s, ph - wd.baseline * s),
        showText(font.encodeText(t)),
      );
    });
    ops.push(endText(), popGraphicsState());
    page.pushOperators(...ops);
  }
  return new Blob([(await pdf.save()) as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
}

/** Sans mots reconnus (texte saisi ou issu d'un PDF) : lignes réparties sur la page. */
function approximatePlacement(text: string, iw: number, ih: number): PlacedWord[] {
  const lines = text.split("\n").filter((l) => l.trim());
  const step = Math.min(ih / 40, (ih * 0.88) / Math.max(1, lines.length));
  return lines.map((l, k) => ({
    text: l.replace(/\t/g, " "),
    x0: iw * 0.08,
    x1: iw * 0.08 + Math.min(iw * 0.84, l.length * step * 0.5),
    baseline: ih * 0.06 + (k + 0.8) * step,
    size: step * 0.8,
    line: k,
  }));
}
