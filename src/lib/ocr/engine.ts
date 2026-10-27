import type { Worker as TessWorker, LoggerMessage } from "tesseract.js";
import type { LayoutMode, OcrLang, OcrLayout } from "../types";
import type { Ruling } from "../image/ocr-prep";
import { buildLayout, layoutToText, wordStats, type TessBlock } from "./layout";

/**
 * Moteur OCR local (Tesseract.js, WebAssembly, dans un Web Worker).
 * Les fichiers du moteur et des langues sont servis par l'application
 * (dossier tesseract/) : aucune image n'est envoyée à un serveur.
 */

export interface OcrOutcome {
  text: string;
  confidence: number;
  layout: OcrLayout;
  blank: boolean;
  /** Résultat jugé peu fiable : à vérifier par l'utilisateur. */
  uncertain: boolean;
}

export class OcrAbortedError extends Error {
  constructor() {
    super("Reconnaissance interrompue.");
    this.name = "OcrAbortedError";
  }
}

export function ocrAssetsBase(): string {
  return new URL("tesseract/", document.baseURI).href;
}

/** Clé de cache des modèles de langue (changer si les fichiers de langue changent). */
const LANG_CACHE_KEY = "scantext-lang-4.0.0_best_int";

let workerPromise: Promise<TessWorker> | null = null;
let workerLang: OcrLang | null = null;
let onProgress: ((p: number) => void) | null = null;
let onStatus: ((s: string) => void) | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let abortCurrent: ((e: Error) => void) | null = null;

const IDLE_MS = 90_000;

function friendlyLoadError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch|network|load|importScripts|NetworkError|Failed/i.test(msg)) {
    return new Error(
      navigator.onLine
        ? "Impossible de charger le moteur de reconnaissance. Rechargez la page puis réessayez."
        : "Le moteur de reconnaissance n'est pas encore disponible hors ligne. Connectez-vous à internet une première fois pour le télécharger.",
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

function statusLabel(status: string): string {
  if (status.includes("core")) return "Chargement du moteur OCR…";
  if (status.includes("traineddata") || status.includes("language")) return "Chargement de la langue…";
  if (status.includes("initializ")) return "Initialisation…";
  if (status.includes("recognizing")) return "Reconnaissance du texte…";
  return "Préparation…";
}

async function createTessWorker(lang: OcrLang): Promise<TessWorker> {
  const { createWorker } = await import("tesseract.js");
  const base = ocrAssetsBase();
  return createWorker(lang.split("+"), 1, {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}core`,
    langPath: `${base}lang`,
    cachePath: LANG_CACHE_KEY,
    // worker chargé depuis notre origine : couvert par le service worker (hors ligne)
    workerBlobURL: false,
    gzip: true,
    logger: (m: LoggerMessage) => {
      if (m.status === "recognizing text") onProgress?.(m.progress);
      onStatus?.(statusLabel(m.status));
    },
    errorHandler: (e: unknown) => console.warn("[scantext] OCR", e),
  });
}

async function getWorker(lang: OcrLang): Promise<TessWorker> {
  if (workerPromise && workerLang === lang) return workerPromise;
  if (workerPromise) {
    const existing = await workerPromise.catch(() => null);
    if (existing) {
      try {
        await existing.reinitialize(lang.split("+") as unknown as string, 1);
        workerLang = lang;
        return existing;
      } catch {
        await existing.terminate().catch(() => undefined);
      }
    }
  }
  workerLang = lang;
  workerPromise = createTessWorker(lang).catch((err) => {
    workerPromise = null;
    workerLang = null;
    throw friendlyLoadError(err);
  });
  return workerPromise;
}

/** Libère le moteur (mémoire) ; il sera rechargé à la prochaine page. */
export async function terminateOcr(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const p = workerPromise;
  workerPromise = null;
  workerLang = null;
  if (p) {
    const w = await p.catch(() => null);
    await w?.terminate().catch(() => undefined);
  }
}

/** Interrompt la page en cours (le moteur est arrêté puis rechargé au besoin). */
export function abortOcr(): void {
  abortCurrent?.(new OcrAbortedError());
  abortCurrent = null;
  void terminateOcr();
}

/** Résolution estimée pour Tesseract (en supposant une page A4). */
export function estimateDpi(w: number, h: number): number {
  const shortSide = Math.min(w, h);
  return Math.round(Math.max(70, Math.min(600, shortSide / 8.27)));
}

/** Ramène les coordonnées de l'image agrandie à celles de l'image traitée. */
export function scaleBlocks(blocks: TessBlock[], scale: number): TessBlock[] {
  if (scale === 1) return blocks;
  const sb = (b: { x0: number; y0: number; x1: number; y1: number } | undefined) => {
    if (!b) return;
    b.x0 /= scale;
    b.y0 /= scale;
    b.x1 /= scale;
    b.y1 /= scale;
  };
  for (const bl of blocks) {
    sb(bl.bbox);
    for (const p of bl.paragraphs) {
      sb(p.bbox);
      for (const l of p.lines) {
        sb(l.bbox);
        sb(l.baseline);
        if (l.rowAttributes) l.rowAttributes = { ...l.rowAttributes, rowHeight: l.rowAttributes.rowHeight / scale };
        for (const wd of l.words) sb(wd.bbox);
      }
    }
  }
  return blocks;
}

export interface RecognizeInput {
  /** Image à reconnaître (éventuellement agrandie). */
  blob: Blob;
  /** Pixel de `blob` = pixel de l'image traitée × scale. */
  scale: number;
  dpi: number;
  rulings?: Ruling[];
  /** Caractères repérés sur l'image (image traitée), pour vérifier que rien n'a été oublié. */
  charBoxes?: Int32Array;
  charH?: number | null;
}

/**
 * Caractères repérés sur l'image qu'aucun mot reconnu ne recouvre, regroupés
 * en zones : le découpage de la page en blocs laisse parfois de côté une
 * colonne de tableau ou un texte isolé.
 */
export function missedCharCount(blocks: TessBlock[], boxes: Int32Array, charH: number): number {
  const words: [number, number, number, number][] = [];
  const pad = 0.3 * charH;
  for (const b of blocks)
    for (const p of b.paragraphs)
      for (const l of p.lines)
        for (const w of l.words) if (w.text.trim()) words.push([w.bbox.x0 - pad, w.bbox.y0 - pad, w.bbox.x1 + pad, w.bbox.y1 + pad]);
  const missed: [number, number][] = [];
  for (let i = 0; i < boxes.length; i += 4) {
    const cx = (boxes[i] + boxes[i + 2]) / 2;
    const cy = (boxes[i + 1] + boxes[i + 3]) / 2;
    if (!words.some((w) => cx >= w[0] && cx <= w[2] && cy >= w[1] && cy <= w[3])) missed.push([cx, cy]);
  }
  // seuls comptent les caractères qui ont des voisins (un mot), pas les poussières isolées
  let count = 0;
  for (const [x, y] of missed) {
    let n = 0;
    for (const [x2, y2] of missed) if (Math.abs(x2 - x) <= 2.5 * charH && Math.abs(y2 - y) <= 0.6 * charH && ++n >= 3) break;
    if (n >= 3) count++;
  }
  return count;
}

/** Ajoute les mots de la seconde passe qui ne recouvrent aucun mot de la première. */
export function mergeMissedWords(first: TessBlock[], second: TessBlock[]): TessBlock[] {
  const words = first.flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words.map((w) => w.bbox))));
  const inside = (x: number, y: number) => words.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
  const extra: TessBlock[] = [];
  for (const b of second)
    for (const p of b.paragraphs)
      for (const l of p.lines) {
        const keep = l.words.filter(
          (w) => w.text.trim() && w.confidence >= 40 && !inside((w.bbox.x0 + w.bbox.x1) / 2, (w.bbox.y0 + w.bbox.y1) / 2),
        );
        if (!keep.length) continue;
        const bbox = {
          x0: Math.min(...keep.map((w) => w.bbox.x0)),
          y0: Math.min(...keep.map((w) => w.bbox.y0)),
          x1: Math.max(...keep.map((w) => w.bbox.x1)),
          y1: Math.max(...keep.map((w) => w.bbox.y1)),
        };
        extra.push({ bbox, paragraphs: [{ bbox, lines: [{ ...l, bbox, words: keep }] }] });
      }
  return [...first, ...extra];
}

export async function recognizeImage(
  input: RecognizeInput,
  opts: {
    lang: OcrLang;
    layoutMode: LayoutMode;
    /** Taille de l'image traitée. */
    width: number;
    height: number;
    onProgress?: (p: number) => void;
    onStatus?: (s: string) => void;
  },
): Promise<OcrOutcome> {
  if (idleTimer) clearTimeout(idleTimer);
  onProgress = opts.onProgress ?? null;
  onStatus = opts.onStatus ?? null;
  try {
    const job = (async () => {
      const worker = await getWorker(opts.lang);
      await worker.setParameters({
        tessedit_pageseg_mode: (opts.layoutMode === "table" ? "6" : "3") as never,
        preserve_interword_spaces: opts.layoutMode === "table" ? "1" : "0",
        user_defined_dpi: String(input.dpi),
      });
      const { data } = await worker.recognize(input.blob, {}, { blocks: true });
      let blocks = scaleBlocks((data.blocks ?? []) as unknown as TessBlock[], input.scale);
      // seconde passe (texte épars) si des zones de texte n'ont pas été lues
      if (input.charBoxes && input.charH && missedCharCount(blocks, input.charBoxes, input.charH) >= 6) {
        onStatus?.("Vérification des zones oubliées…");
        await worker.setParameters({ tessedit_pageseg_mode: "11" as never, preserve_interword_spaces: "0" });
        const second = await worker.recognize(input.blob, {}, { blocks: true });
        blocks = mergeMissedWords(blocks, scaleBlocks((second.data.blocks ?? []) as unknown as TessBlock[], input.scale));
      }
      return blocks;
    })();
    job.catch(() => undefined); // évite un rejet non géré si la page est interrompue
    const aborted = new Promise<never>((_, reject) => (abortCurrent = reject));
    const blocks = await Promise.race([job, aborted]);
    const layout = buildLayout(blocks, opts.width, opts.height, { rulings: input.rulings, mode: opts.layoutMode });
    const text = layoutToText(layout).trim();
    const stats = wordStats(layout);
    const blank = stats.count === 0 || !text;
    const confidence = blank ? 0 : Math.round(stats.meanConfidence);
    const uncertain =
      !blank &&
      (confidence < 60 || stats.lowConfidence / stats.count > 0.35 || (text.replace(/\s/g, "").length < 12 && confidence < 75));
    return { text: blank ? "" : text, confidence, layout, blank, uncertain };
  } finally {
    abortCurrent = null;
    onProgress = null;
    onStatus = null;
    idleTimer = setTimeout(() => void terminateOcr(), IDLE_MS);
  }
}
