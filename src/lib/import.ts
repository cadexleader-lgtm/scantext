import { detectQuad, drawScaled, canvasToBlob, decodeImage, releaseCanvas, releaseSource } from "./image/pipeline";
import { getSettings, QUALITY_MAX_SIDE } from "./settings";
import { addPages, createDoc, getState, type NewPageInput } from "./store";
import { errorMessage } from "./toast";
import type { FilterId, Quad } from "./types";

export interface ImportProgress {
  done: number;
  total: number;
  label: string;
}

export interface ImportResult {
  docId: string;
  added: number;
  failed: string[];
}

export const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
export const isImage = (f: File) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(f.name);

/** Image d'origine conservée (réduite à la qualité choisie) + contours détectés. */
export async function prepareCapture(
  canvas: HTMLCanvasElement,
  opts: { detect?: boolean; quad?: Quad | null } = {},
): Promise<{ blob: Blob; w: number; h: number; quad: Quad | null }> {
  const maxSide = QUALITY_MAX_SIDE[getSettings().imageQuality];
  const scaled = canvas.width > maxSide || canvas.height > maxSide ? drawScaled(canvas, maxSide) : canvas;
  try {
    const s = scaled.width / canvas.width;
    let quad: Quad | null = opts.quad === undefined ? null : opts.quad;
    if (opts.quad === undefined && opts.detect !== false) quad = detectQuad(scaled);
    else if (quad && s !== 1) quad = quad.map((p) => ({ x: p.x * s, y: p.y * s })) as Quad;
    const blob = await canvasToBlob(scaled, "image/jpeg", 0.9);
    return { blob, w: scaled.width, h: scaled.height, quad };
  } finally {
    if (scaled !== canvas) releaseCanvas(scaled);
  }
}

async function ensureDoc(docId: string | null, nameHint?: string): Promise<string> {
  if (docId && getState().docs[docId]) return docId;
  const doc = await createDoc(nameHint);
  return doc.id;
}

export async function importImages(
  files: File[],
  opts: { docId: string | null; atIndex?: number; onProgress?: (p: ImportProgress) => void; signal?: AbortSignal },
): Promise<ImportResult> {
  const filter: FilterId = getSettings().defaultFilter;
  const nameHint = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, "") : undefined;
  const docId = await ensureDoc(opts.docId, nameHint);
  const failed: string[] = [];
  let added = 0;
  let at = opts.atIndex;
  for (let i = 0; i < files.length; i++) {
    if (opts.signal?.aborted) break;
    const f = files[i];
    opts.onProgress?.({ done: i, total: files.length, label: `Image ${i + 1} sur ${files.length}` });
    let src: Awaited<ReturnType<typeof decodeImage>> | null = null;
    let canvas: HTMLCanvasElement | null = null;
    try {
      src = await decodeImage(f);
      canvas = drawScaled(src, QUALITY_MAX_SIDE[getSettings().imageQuality]);
      const cap = await prepareCapture(canvas);
      const input: NewPageInput = {
        source: "image",
        orig: { blob: cap.blob, w: cap.w, h: cap.h },
        params: { quad: cap.quad, rotation: 0, filter, sharpen: false },
      };
      await addPages(docId, [input], at);
      if (at !== undefined) at++;
      added++;
    } catch (err) {
      failed.push(`${f.name} : ${errorMessage(err)}`);
    } finally {
      if (src) releaseSource(src);
      if (canvas) releaseCanvas(canvas);
    }
  }
  opts.onProgress?.({ done: files.length, total: files.length, label: "Terminé" });
  return { docId, added, failed };
}

export async function inspectPdf(file: File): Promise<{ pages: number; hasText: boolean }> {
  const { openPdf, pdfHasText } = await import("./pdf/import");
  const pdf = await openPdf(file);
  try {
    return { pages: pdf.numPages, hasText: await pdfHasText(pdf) };
  } finally {
    void pdf.destroy();
  }
}

export async function importPdf(
  file: File,
  opts: {
    docId: string | null;
    atIndex?: number;
    useText: boolean;
    onProgress?: (p: ImportProgress) => void;
    signal?: AbortSignal;
  },
): Promise<ImportResult> {
  const { openPdf, extractPageText, renderPdfPage } = await import("./pdf/import");
  const pdf = await openPdf(file);
  const failed: string[] = [];
  let added = 0;
  try {
    const docId = await ensureDoc(opts.docId, file.name.replace(/\.pdf$/i, ""));
    let at = opts.atIndex;
    const maxSide = QUALITY_MAX_SIDE[getSettings().imageQuality];
    for (let n = 1; n <= pdf.numPages; n++) {
      if (opts.signal?.aborted) break;
      opts.onProgress?.({ done: n - 1, total: pdf.numPages, label: `Page ${n} sur ${pdf.numPages}` });
      let canvas: HTMLCanvasElement | null = null;
      try {
        canvas = await renderPdfPage(pdf, n, maxSide);
        const text = opts.useText ? await extractPageText(pdf, n) : null;
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
        await addPages(
          docId,
          [
            {
              source: "pdf",
              orig: { blob, w: canvas.width, h: canvas.height },
              params: { quad: null, rotation: 0, filter: "color", sharpen: false },
              pdfText: text,
              // page sans texte dans un PDF « mixte » (page scannée) : reconnaissance OCR
              usePdfText: opts.useText && !!text && text.replace(/\s/g, "").length >= 10,
            },
          ],
          at,
        );
        if (at !== undefined) at++;
        added++;
      } catch (err) {
        failed.push(`Page ${n} : ${errorMessage(err)}`);
      } finally {
        if (canvas) releaseCanvas(canvas);
      }
    }
    opts.onProgress?.({ done: pdf.numPages, total: pdf.numPages, label: "Terminé" });
    return { docId, added, failed };
  } finally {
    void pdf.destroy();
  }
}
