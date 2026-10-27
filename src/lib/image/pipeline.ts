import type { ImageParams, Quad } from "../types";
import { rgbaToGray } from "./detect";
import { findPage } from "./edges";
import { insetQuad, scaleQuad } from "./geometry";
import { processImage, type RGBAImage } from "./ops";

/**
 * Traitement d'image côté navigateur : décodage, réduction, détection des
 * contours et rendu final. Les calculs lourds (perspective, filtres) tournent
 * dans un Web Worker pour garder l'interface fluide.
 */

export type DrawableSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement;

export class UnsupportedImageError extends Error {
  constructor() {
    super("Ce format d'image n'est pas pris en charge par votre navigateur (essayez JPEG ou PNG).");
    this.name = "UnsupportedImageError";
  }
}

function sourceSize(src: DrawableSource): { w: number; h: number } {
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  if (src instanceof HTMLImageElement) return { w: src.naturalWidth, h: src.naturalHeight };
  return { w: src.width, h: src.height };
}

/** Décode un fichier image (orientation EXIF respectée). */
export async function decodeImage(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {
      // repli sur <img> (anciens Safari, certains formats)
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new UnsupportedImageError();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function releaseSource(src: DrawableSource): void {
  if ("close" in src && typeof src.close === "function") src.close();
}

export function releaseCanvas(c: HTMLCanvasElement): void {
  c.width = 0;
  c.height = 0;
}

/** Dessine la source dans un canvas dont le plus grand côté vaut au plus maxSide. */
export function drawScaled(src: DrawableSource, maxSide: number): HTMLCanvasElement {
  const { w, h } = sourceSize(src);
  if (!w || !h) throw new UnsupportedImageError();
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  if (!ctx) throw new Error("Canvas indisponible sur ce navigateur.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (scale < 0.5 && !(src instanceof HTMLVideoElement)) {
    // réduction par étapes : évite le crénelage des fortes réductions
    let cur: DrawableSource = src;
    let curW = w;
    let curH = h;
    const steps: HTMLCanvasElement[] = [];
    while (curW * 0.5 > cw) {
      const step = document.createElement("canvas");
      step.width = Math.round(curW * 0.5);
      step.height = Math.round(curH * 0.5);
      const sctx = step.getContext("2d")!;
      sctx.imageSmoothingQuality = "high";
      sctx.drawImage(cur, 0, 0, step.width, step.height);
      steps.push(step);
      cur = step;
      curW = step.width;
      curH = step.height;
    }
    ctx.drawImage(cur, 0, 0, cw, ch);
    steps.forEach(releaseCanvas);
  } else {
    ctx.drawImage(src, 0, 0, cw, ch);
  }
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/jpeg", quality = 0.9): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Impossible d'encoder l'image."))), type, quality),
  );
}

export function readPixels(canvas: HTMLCanvasElement): RGBAImage {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: d.data, width: d.width, height: d.height };
}

export function pixelsToCanvas(img: RGBAImage, target?: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = target ?? document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return canvas;
}

/** Détecte les coins du document sur une source, dans le repère de cette source. */
export function detectQuad(src: DrawableSource, workSide = 400): Quad | null {
  const { w, h } = sourceSize(src);
  if (!w || !h) return null;
  const small = drawScaled(src, workSide);
  try {
    const px = readPixels(small);
    const res = findPage(rgbaToGray(px.data, px.width, px.height), px.width, px.height);
    if (!res) return null;
    return insetQuad(scaleQuad(res.quad, w / small.width, h / small.height), 0.006);
  } finally {
    releaseCanvas(small);
  }
}

// ------------------------------------------------------------ worker

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const jobs = new Map<number, { resolve: (img: RGBAImage) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (!worker) {
    try {
      worker = new Worker(new URL("./process.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; image?: RGBAImage; error?: string }>) => {
        const job = jobs.get(e.data.id);
        if (!job) return;
        jobs.delete(e.data.id);
        if (e.data.ok && e.data.image) job.resolve(e.data.image);
        else job.reject(new Error(e.data.error || "Échec du traitement de l'image."));
      };
      worker.onerror = () => {
        // worker inutilisable : bascule sur le thread principal
        workerBroken = true;
        worker = null;
        for (const [, job] of jobs) job.reject(new Error("worker-failed"));
        jobs.clear();
      };
    } catch {
      workerBroken = true;
      return null;
    }
  }
  return worker;
}

export async function processPixels(image: RGBAImage, params: ImageParams, maxSide: number): Promise<RGBAImage> {
  const w = getWorker();
  if (w) {
    try {
      return await new Promise<RGBAImage>((resolve, reject) => {
        const id = ++seq;
        jobs.set(id, { resolve, reject });
        w.postMessage({ id, image, params, maxSide }, [image.data.buffer]);
      });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== "worker-failed") throw err;
      throw new Error("Le traitement d'image a échoué, réessayez.");
    }
  }
  return processImage(image, params, maxSide);
}

export interface ProcessedImage {
  blob: Blob;
  thumb: Blob;
  w: number;
  h: number;
}

export const THUMB_SIDE = 360;

/** Petite vignette JPEG (évite de décoder l'image complète pour chaque miniature). */
export async function makeThumb(src: DrawableSource): Promise<Blob> {
  const c = drawScaled(src, THUMB_SIDE);
  try {
    return await canvasToBlob(c, "image/jpeg", 0.72);
  } finally {
    releaseCanvas(c);
  }
}

/** Rendu final d'une page à partir de son image d'origine. */
export async function renderPage(origBlob: Blob, params: ImageParams, maxSide: number): Promise<ProcessedImage> {
  const src = await decodeImage(origBlob);
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = drawScaled(src, Number.MAX_SAFE_INTEGER);
    const pixels = readPixels(canvas);
    releaseCanvas(canvas);
    // les coins sont exprimés dans le repère de l'image d'origine
    const out = await processPixels(pixels, params, maxSide);
    canvas = pixelsToCanvas(out);
    const isBW = params.filter === "bw";
    const blob = await canvasToBlob(canvas, isBW ? "image/png" : "image/jpeg", 0.88);
    const thumbCanvas = drawScaled(canvas, THUMB_SIDE);
    const thumb = await canvasToBlob(thumbCanvas, "image/jpeg", 0.75);
    releaseCanvas(thumbCanvas);
    return { blob, thumb, w: out.width, h: out.height };
  } finally {
    releaseSource(src);
    if (canvas) releaseCanvas(canvas);
  }
}

/** Aperçu rapide (réduit) du rendu, pour l'écran de vérification. */
export async function renderPreview(
  src: HTMLCanvasElement,
  params: ImageParams,
  srcScale: number,
  maxSide = 1100,
): Promise<HTMLCanvasElement> {
  const pixels = readPixels(src);
  const scaled: ImageParams = { ...params, quad: params.quad ? scaleQuad(params.quad, srcScale) : null };
  const out = await processPixels(pixels, scaled, maxSide);
  return pixelsToCanvas(out);
}
