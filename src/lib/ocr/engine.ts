import type { Worker as TessWorker, LoggerMessage } from "tesseract.js";
import type { LayoutMode, OcrLang, OcrLayout } from "../types";
import { buildLayout, layoutToText, layoutToTextSpaced, wordStats, type TessBlock } from "./layout";

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

export async function recognizeImage(
  image: Blob,
  opts: {
    lang: OcrLang;
    layoutMode: LayoutMode;
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
        user_defined_dpi: String(estimateDpi(opts.width, opts.height)),
      });
      return worker.recognize(image, {}, { text: true, blocks: true });
    })();
    job.catch(() => undefined); // évite un rejet non géré si la page est interrompue
    const aborted = new Promise<never>((_, reject) => (abortCurrent = reject));
    const { data } = await Promise.race([job, aborted]);
    const blocks = (data.blocks ?? []) as unknown as TessBlock[];
    const layout = buildLayout(blocks, opts.width, opts.height);
    let text = opts.layoutMode === "table" ? layoutToTextSpaced(layout) : layoutToText(layout);
    text = text.trim();
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
