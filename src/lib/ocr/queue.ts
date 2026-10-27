import { useSyncExternalStore } from "react";
import { getBlob } from "../db";
import { renderPage } from "../image/pipeline";
import { getSettings, QUALITY_MAX_SIDE, updateSettings } from "../settings";
import { getState, savePageImage, subscribe, updatePage } from "../store";
import { errorMessage, toast } from "../toast";
import type { ImageParams, PageRecord } from "../types";
import { applyOcrResult, resolvePending } from "./apply";
import { abortOcr, OcrAbortedError, recognizeImage } from "./engine";

/**
 * File de traitement en arrière-plan, page par page :
 *  1. préparation de l'image (recadrage, perspective, filtre) ;
 *  2. reconnaissance du texte.
 * Une page en échec n'empêche pas les autres d'avancer ; une page interrompue
 * (fermeture, rechargement) reprend automatiquement.
 */

export interface ProcessingState {
  ocrPageId: string | null;
  ocrProgress: number;
  ocrStatusText: string;
  imagePageId: string | null;
  /** Le moteur OCR n'a pas pu être chargé : la file est arrêtée jusqu'à nouvel essai. */
  engineError: string | null;
}

let pstate: ProcessingState = { ocrPageId: null, ocrProgress: 0, ocrStatusText: "", imagePageId: null, engineError: null };
const plisteners = new Set<() => void>();
function setP(patch: Partial<ProcessingState>) {
  pstate = { ...pstate, ...patch };
  plisteners.forEach((l) => l());
}
export function useProcessing(): ProcessingState {
  return useSyncExternalStore(
    (l) => {
      plisteners.add(l);
      return () => plisteners.delete(l);
    },
    () => pstate,
    () => pstate,
  );
}

let priorityDocId: string | null = null;
/** Le document ouvert est traité en premier. */
export function setPriorityDoc(docId: string | null): void {
  priorityDocId = docId;
}

function orderedPages(): PageRecord[] {
  const { docs, pages } = getState();
  const docList = Object.values(docs).sort((a, b) => {
    if (a.id === priorityDocId) return -1;
    if (b.id === priorityDocId) return 1;
    return b.updatedAt - a.updatedAt;
  });
  const out: PageRecord[] = [];
  for (const d of docList) for (const id of d.pageIds) if (pages[id]) out.push(pages[id]);
  return out;
}

const paramsOf = (p: PageRecord): ImageParams => ({ quad: p.quad, rotation: p.rotation, filter: p.filter, sharpen: p.sharpen });
const sameParams = (a: ImageParams, b: ImageParams) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------ suspension

/** Raisons de suspension en cours (ex. « scanner » : caméra ouverte). */
const suspended = new Set<string>();
const isSuspended = () => suspended.size > 0;

/**
 * Suspend (ou reprend) le traitement en arrière-plan. La page en cours de
 * reconnaissance est interrompue puis reprise plus tard, depuis le début.
 */
export function suspendProcessing(reason: string, on: boolean): void {
  if (on) {
    suspended.add(reason);
    if (ocrRunning) abortOcr();
  } else {
    suspended.delete(reason);
    kick();
  }
}

// ------------------------------------------------------------------ images

let imageRunning = false;

async function imageLoop(): Promise<void> {
  if (imageRunning) return;
  imageRunning = true;
  try {
    for (;;) {
      if (isSuspended()) break;
      const page = orderedPages().find((p) => p.imageStatus === "pending");
      if (!page) break;
      const params = paramsOf(page);
      setP({ imagePageId: page.id });
      try {
        const orig = await getBlob(page.id, "orig");
        if (!orig) throw new Error("Image d'origine introuvable sur l'appareil.");
        const out = await renderPage(orig, params, QUALITY_MAX_SIDE[getSettings().imageQuality]);
        const latest = getState().pages[page.id];
        if (!latest || !sameParams(paramsOf(latest), params)) continue; // modifiée entre-temps : refaire
        // la nouvelle image rend la reconnaissance précédente obsolète (sauf texte issu du PDF)
        const patch: Partial<PageRecord> = latest.textSource === "pdf" ? {} : { ocrStatus: "pending", ocrError: null };
        await savePageImage(page.id, out, patch);
      } catch (err) {
        if (getState().pages[page.id])
          await updatePage(page.id, { imageStatus: "error", imageError: errorMessage(err) }).catch(() => undefined);
      }
    }
  } finally {
    imageRunning = false;
    setP({ imagePageId: null });
  }
}

// ------------------------------------------------------------------ OCR

let ocrRunning = false;
let wakeLock: { release: () => Promise<void> } | null = null;

async function acquireWakeLock() {
  try {
    // garde l'écran allumé pendant un long traitement (sinon le téléphone met l'application en veille)
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (wl && document.visibilityState === "visible" && !wakeLock) wakeLock = await wl.request("screen");
  } catch {
    wakeLock = null;
  }
}
function releaseWakeLock() {
  void wakeLock?.release().catch(() => undefined);
  wakeLock = null;
}

function nextOcrPage(): PageRecord | undefined {
  return orderedPages().find((p) => p.ocrStatus === "pending" && p.imageStatus === "ready");
}

async function ocrLoop(): Promise<void> {
  if (ocrRunning || getSettings().ocrPaused || pstate.engineError || isSuspended()) return;
  if (!nextOcrPage()) return;
  ocrRunning = true;
  await acquireWakeLock();
  try {
    while (!getSettings().ocrPaused && !isSuspended()) {
      const page = nextOcrPage();
      if (!page) break;
      const doc = getState().docs[page.docId];
      if (!doc) break;
      const rev = page.imageRev;
      await updatePage(page.id, { ocrStatus: "processing", ocrError: null });
      setP({ ocrPageId: page.id, ocrProgress: 0, ocrStatusText: "Préparation…" });
      try {
        const blob = await getBlob(page.id, "proc");
        if (!blob) throw new Error("Image de la page introuvable sur l'appareil.");
        const out = await recognizeImage(blob, {
          lang: doc.lang,
          layoutMode: doc.layoutMode,
          width: page.procW,
          height: page.procH,
          onProgress: (p) => setP({ ocrProgress: p }),
          onStatus: (s) => pstate.ocrStatusText !== s && setP({ ocrStatusText: s }),
        });
        const latest = getState().pages[page.id];
        if (!latest) continue; // page supprimée pendant le traitement
        if (latest.imageRev !== rev) {
          await updatePage(page.id, { ocrStatus: "pending" });
          continue;
        }
        await updatePage(page.id, applyOcrResult(latest, out, doc.lang));
      } catch (err) {
        const exists = !!getState().pages[page.id];
        if (err instanceof OcrAbortedError) {
          if (exists) await updatePage(page.id, { ocrStatus: "pending" }).catch(() => undefined);
          break;
        }
        const message = errorMessage(err, "La reconnaissance a échoué.");
        if (exists) await updatePage(page.id, { ocrStatus: "error", ocrError: message }).catch(() => undefined);
        if (/moteur|hors ligne/i.test(message)) {
          // inutile d'échouer sur toutes les pages : on attend un nouvel essai
          setP({ engineError: message });
          break;
        }
      }
    }
  } finally {
    ocrRunning = false;
    releaseWakeLock();
    setP({ ocrPageId: null, ocrProgress: 0, ocrStatusText: "" });
    // une page a pu être ajoutée pendant la fin de boucle
    queueMicrotask(kick);
  }
}

// ------------------------------------------------------------------ pilotage

let kickScheduled = false;
export function kick(): void {
  if (kickScheduled) return;
  kickScheduled = true;
  queueMicrotask(() => {
    kickScheduled = false;
    if (!getState().loaded) return;
    void imageLoop();
    void ocrLoop();
  });
}

let started = false;
export function startProcessing(): void {
  if (started) return;
  started = true;
  subscribe(kick);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (ocrRunning) void acquireWakeLock();
      kick();
    }
  });
  kick();
}

export function pauseOcr(): void {
  updateSettings({ ocrPaused: true });
  abortOcr();
}

export function resumeOcr(): void {
  updateSettings({ ocrPaused: false });
  setP({ engineError: null });
  kick();
}

export function retryEngine(): void {
  setP({ engineError: null });
  const { pages } = getState();
  for (const p of Object.values(pages))
    if (p.ocrStatus === "error" && /moteur|hors ligne/i.test(p.ocrError ?? "")) void updatePage(p.id, { ocrStatus: "pending", ocrError: null });
  kick();
}

/** Relance la reconnaissance d'une page (sans toucher aux autres pages). */
export async function rerunOcr(pageId: string): Promise<void> {
  const page = getState().pages[pageId];
  if (!page) return;
  if (page.imageStatus === "error") {
    await updatePage(pageId, { imageStatus: "pending", imageError: null, ocrStatus: "pending", ocrError: null });
  } else {
    await updatePage(pageId, { ocrStatus: "pending", ocrError: null });
  }
  if (pstate.engineError) setP({ engineError: null });
  kick();
}

export async function retryFailed(docId: string): Promise<number> {
  const { docs, pages } = getState();
  const ids = (docs[docId]?.pageIds ?? []).filter((id) => pages[id]?.ocrStatus === "error" || pages[id]?.imageStatus === "error");
  for (const id of ids) await rerunOcr(id);
  return ids.length;
}

export async function resolveOcrConflict(pageId: string, choice: "replace" | "keep"): Promise<void> {
  const page = getState().pages[pageId];
  if (!page) return;
  await updatePage(pageId, resolvePending(page, choice));
  toast.success(choice === "replace" ? "Texte remplacé par la nouvelle reconnaissance." : "Votre version a été conservée.");
}

export async function markVerified(pageId: string): Promise<void> {
  await updatePage(pageId, { ocrStatus: "done" });
}

/** Applique de nouveaux réglages d'image ; l'image sera recalculée en arrière-plan. */
export async function setPageImageParams(pageId: string, params: Partial<ImageParams>): Promise<void> {
  await updatePage(pageId, { ...params, imageStatus: "pending", imageError: null });
  kick();
}
