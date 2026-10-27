import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * Lecture de PDF avec pdf.js (chargé uniquement à l'import d'un PDF).
 * Chaque page est rendue en image ; si le PDF contient déjà du texte
 * (PDF « numérique »), ce texte est aussi extrait : il est exact, contrairement
 * à une reconnaissance sur image.
 */

export class PdfPasswordError extends Error {
  constructor() {
    super("Ce PDF est protégé par un mot de passe : il ne peut pas être importé.");
    this.name = "PdfPasswordError";
  }
}

async function pdfjs() {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!lib.GlobalWorkerOptions.workerSrc) {
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
    lib.GlobalWorkerOptions.workerSrc = worker.default;
  }
  return lib;
}

export async function openPdf(file: Blob): Promise<PDFDocumentProxy> {
  const lib = await pdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  try {
    return await lib.getDocument({ data }).promise;
  } catch (err) {
    if (err instanceof Error && err.name === "PasswordException") throw new PdfPasswordError();
    throw new Error("Ce fichier PDF est illisible ou endommagé.");
  }
}

interface TextItemLike {
  str: string;
  hasEOL?: boolean;
  transform: number[];
  height: number;
}

/** Texte d'une page PDF, avec sauts de ligne et de paragraphe déduits des positions. */
export async function extractPageText(pdf: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  try {
    const content = await page.getTextContent();
    const items = content.items.filter((i): i is TextItemLike & typeof i => "str" in i) as unknown as TextItemLike[];
    let out = "";
    let lastY: number | null = null;
    let lastH = 0;
    for (const it of items) {
      const y = it.transform[5];
      const h = Math.abs(it.height) || Math.abs(it.transform[3]) || 10;
      if (lastY !== null && out && !out.endsWith("\n")) {
        const dy = Math.abs(lastY - y);
        if (dy > Math.max(lastH, h) * 0.5) out += "\n";
      }
      if (lastY !== null && out.endsWith("\n")) {
        const dy = Math.abs(lastY - y);
        if (dy > Math.max(lastH, h) * 1.8 && !out.endsWith("\n\n")) out += "\n";
      }
      out += it.str;
      if (it.hasEOL && !out.endsWith("\n")) out += "\n";
      if (it.str.trim() || it.hasEOL) {
        lastY = y;
        lastH = h;
      }
    }
    return out
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } finally {
    page.cleanup();
  }
}

/** Le PDF contient-il du texte exploitable (sur les premières pages) ? */
export async function pdfHasText(pdf: PDFDocumentProxy): Promise<boolean> {
  const n = Math.min(pdf.numPages, 3);
  let chars = 0;
  for (let i = 1; i <= n; i++) chars += (await extractPageText(pdf, i)).replace(/\s/g, "").length;
  return chars >= 30 * n;
}

/** Rend une page PDF dans un canvas dont le plus grand côté vaut maxSide. */
export async function renderPdfPage(pdf: PDFDocumentProxy, pageNumber: number, maxSide: number): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, maxSide / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return canvas;
  } finally {
    page.cleanup();
  }
}
