import { useMemo, useSyncExternalStore } from "react";
import * as db from "./db";
import { newId } from "./id";
import { getSettings } from "./settings";
import { errorMessage, toast } from "./toast";
import type { DocRecord, ImageParams, LayoutMode, OcrLang, PageRecord, PageSource } from "./types";

/**
 * Store de l'application : copie en mémoire des documents et pages (sans les
 * images), synchronisée avec IndexedDB. Chaque modification met à jour la
 * mémoire immédiatement puis est écrite sur l'appareil.
 */
export interface State {
  loaded: boolean;
  loadError: string | null;
  docs: Record<string, DocRecord>;
  pages: Record<string, PageRecord>;
}

let state: State = { loaded: false, loadError: null, docs: {}, pages: {} };
const listeners = new Set<() => void>();

function setState(next: State): void {
  state = next;
  listeners.forEach((l) => l());
}
export const getState = (): State => state;
export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ---------------------------------------------------------------- persistance

let saving = 0;
const saveListeners = new Set<() => void>();
let lastSavedAt: number | null = null;
let lastSaveError: string | null = null;
function setSaving(delta: number) {
  saving += delta;
  saveListeners.forEach((l) => l());
}

async function persist(task: () => Promise<void>): Promise<void> {
  setSaving(1);
  try {
    await task();
    lastSavedAt = Date.now();
    lastSaveError = null;
  } catch (err) {
    lastSaveError = errorMessage(err, "Impossible d'enregistrer sur cet appareil.");
    toast.error(lastSaveError);
    throw err;
  } finally {
    setSaving(-1);
  }
}

/** Écriture différée (frappe au clavier) : une seule écriture par page toutes les 500 ms. */
const dirtyPages = new Set<string>();
const dirtyDocs = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushPendingWrites(), 500);
  saveListeners.forEach((l) => l());
}

export async function flushPendingWrites(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!dirtyPages.size && !dirtyDocs.size) return;
  const pages = [...dirtyPages].map((id) => state.pages[id]).filter(Boolean);
  const docs = [...dirtyDocs].map((id) => state.docs[id]).filter(Boolean);
  dirtyPages.clear();
  dirtyDocs.clear();
  await persist(async () => {
    await db.putPages(pages);
    for (const d of docs) await db.putDoc(d);
  }).catch(() => {
    // l'erreur est déjà affichée ; on garde les pages à réécrire
    pages.forEach((p) => dirtyPages.add(p.id));
    docs.forEach((d) => dirtyDocs.add(d.id));
  });
}

export function hasPendingWrites(): boolean {
  return saving > 0 || dirtyPages.size > 0 || dirtyDocs.size > 0;
}

export interface SaveState {
  pending: boolean;
  lastSavedAt: number | null;
  error: string | null;
}
let saveSnapshot: SaveState = { pending: false, lastSavedAt: null, error: null };
function getSaveState(): SaveState {
  const pending = hasPendingWrites();
  if (
    saveSnapshot.pending !== pending ||
    saveSnapshot.lastSavedAt !== lastSavedAt ||
    saveSnapshot.error !== lastSaveError
  ) {
    saveSnapshot = { pending, lastSavedAt, error: lastSaveError };
  }
  return saveSnapshot;
}
export function useSaveState(): SaveState {
  return useSyncExternalStore(
    (l) => {
      saveListeners.add(l);
      return () => saveListeners.delete(l);
    },
    getSaveState,
    getSaveState,
  );
}

if (typeof window !== "undefined") {
  // Sécurité : écrire les modifications en attente quand l'onglet passe en arrière-plan.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushPendingWrites();
  });
  window.addEventListener("pagehide", () => void flushPendingWrites());
}

// ---------------------------------------------------------------- chargement

export async function initStore(): Promise<void> {
  try {
    const { docs, pages } = await db.loadAll();
    const docMap: Record<string, DocRecord> = {};
    const pageMap: Record<string, PageRecord> = {};
    const repairedPages: PageRecord[] = [];
    const repairedDocs: DocRecord[] = [];
    for (const d of docs) docMap[d.id] = d;
    for (const p of pages) {
      if (!docMap[p.docId]) continue; // page orpheline : ignorée
      let page = p;
      // Une reconnaissance interrompue (fermeture, rechargement) reprend depuis le début de la page.
      if (page.ocrStatus === "processing") {
        page = { ...page, ocrStatus: "pending" };
        repairedPages.push(page);
      }
      pageMap[page.id] = page;
    }
    // Cohérence de l'ordre des pages.
    for (const d of Object.values(docMap)) {
      const known = d.pageIds.filter((id) => pageMap[id]);
      const missing = Object.values(pageMap)
        .filter((p) => p.docId === d.id && !known.includes(p.id))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((p) => p.id);
      if (missing.length || known.length !== d.pageIds.length) {
        docMap[d.id] = { ...d, pageIds: [...known, ...missing] };
        repairedDocs.push(docMap[d.id]);
      }
    }
    setState({ loaded: true, loadError: null, docs: docMap, pages: pageMap });
    if (repairedPages.length) await db.putPages(repairedPages);
    for (const d of repairedDocs) await db.putDoc(d);
  } catch (err) {
    setState({
      ...state,
      loaded: true,
      loadError:
        "Impossible d'accéder au stockage de l'appareil. Vérifiez que le navigateur n'est pas en navigation privée et qu'il autorise l'enregistrement des données de sites.",
    });
    console.error("[scantext] chargement IndexedDB", err);
  }
}

// ---------------------------------------------------------------- hooks

export function useStore(): State {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function useDoc(docId: string | undefined): DocRecord | undefined {
  const s = useStore();
  return docId ? s.docs[docId] : undefined;
}

export function useDocPages(docId: string | undefined): PageRecord[] {
  const s = useStore();
  const doc = docId ? s.docs[docId] : undefined;
  return useMemo(
    () => (doc ? doc.pageIds.map((id) => s.pages[id]).filter((p): p is PageRecord => !!p) : []),
    [doc, s.pages],
  );
}

export function getDocPages(docId: string): PageRecord[] {
  const doc = state.docs[docId];
  return doc ? doc.pageIds.map((id) => state.pages[id]).filter(Boolean) : [];
}

export function useSortedDocs(): DocRecord[] {
  const s = useStore();
  return useMemo(() => Object.values(s.docs).sort((a, b) => b.updatedAt - a.updatedAt), [s.docs]);
}

// ---------------------------------------------------------------- documents

export function defaultDocName(date = new Date()): string {
  const d = date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const t = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `Document du ${d} à ${t}`;
}

export async function createDoc(name?: string): Promise<DocRecord> {
  const now = Date.now();
  const s = getSettings();
  const doc: DocRecord = {
    id: newId(),
    name: name?.trim() || defaultDocName(),
    createdAt: now,
    updatedAt: now,
    pageIds: [],
    lang: s.lang,
    layoutMode: "auto",
  };
  await persist(() => db.putDoc(doc));
  setState({ ...state, docs: { ...state.docs, [doc.id]: doc } });
  return doc;
}

export async function updateDoc(
  docId: string,
  patch: Partial<Pick<DocRecord, "name" | "lang" | "layoutMode">>,
): Promise<void> {
  const doc = state.docs[docId];
  if (!doc) return;
  const next = { ...doc, ...patch, updatedAt: Date.now() };
  setState({ ...state, docs: { ...state.docs, [docId]: next } });
  await persist(() => db.putDoc(next));
}

export async function deleteDoc(docId: string): Promise<void> {
  const doc = state.docs[docId];
  if (!doc) return;
  const pageIds = Object.values(state.pages)
    .filter((p) => p.docId === docId)
    .map((p) => p.id);
  await persist(() => db.deleteDocData(docId, pageIds));
  const docs = { ...state.docs };
  delete docs[docId];
  const pages = { ...state.pages };
  for (const id of pageIds) {
    delete pages[id];
    dirtyPages.delete(id);
  }
  dirtyDocs.delete(docId);
  setState({ ...state, docs, pages });
}

export async function duplicateDoc(docId: string): Promise<DocRecord | undefined> {
  const src = state.docs[docId];
  if (!src) return;
  await flushPendingWrites();
  const now = Date.now();
  const doc: DocRecord = { ...src, id: newId(), name: `${src.name} (copie)`, createdAt: now, updatedAt: now, pageIds: [] };
  const pages: PageRecord[] = [];
  const blobs: Array<[string, Blob]> = [];
  for (const pid of src.pageIds) {
    const p = state.pages[pid];
    if (!p) continue;
    const copy: PageRecord = {
      ...p,
      id: newId(),
      docId: doc.id,
      ocrStatus: p.ocrStatus === "processing" ? "pending" : p.ocrStatus,
    };
    for (const kind of ["orig", "proc", "thumb"] as const) {
      const b = await db.getBlob(pid, kind);
      if (b) blobs.push([db.blobKey(copy.id, kind), b]);
    }
    pages.push(copy);
    doc.pageIds.push(copy.id);
  }
  await persist(() => db.putPageWithBlobs(doc, pages, blobs));
  const pageMap = { ...state.pages };
  for (const p of pages) pageMap[p.id] = p;
  setState({ ...state, docs: { ...state.docs, [doc.id]: doc }, pages: pageMap });
  return doc;
}

// ---------------------------------------------------------------- pages

export interface NewPageInput {
  source: PageSource;
  orig: { blob: Blob; w: number; h: number };
  /** Vignette provisoire (remplacée par celle de l'image traitée). */
  thumb?: Blob;
  params: ImageParams;
  /** Image déjà traitée (sinon elle sera préparée en arrière-plan). */
  processed?: { blob: Blob; thumb: Blob; w: number; h: number };
  pdfText?: string | null;
  /** Utiliser directement le texte du PDF au lieu de l'OCR. */
  usePdfText?: boolean;
}

export function makePageRecord(docId: string, input: NewPageInput): PageRecord {
  const now = Date.now();
  const usePdf = !!input.usePdfText && !!input.pdfText?.trim();
  return {
    id: newId(),
    docId,
    createdAt: now,
    updatedAt: now,
    source: input.source,
    origW: input.orig.w,
    origH: input.orig.h,
    ...input.params,
    imageStatus: input.processed ? "ready" : "pending",
    imageError: null,
    imageRev: input.processed ? 1 : 0,
    procW: input.processed?.w ?? 0,
    procH: input.processed?.h ?? 0,
    ocrStatus: usePdf ? "done" : "pending",
    ocrError: null,
    ocrConfidence: usePdf ? 100 : null,
    ocrRev: usePdf ? (input.processed ? 1 : 0) : null,
    ocrLang: null,
    ocrText: usePdf ? input.pdfText!.trim() : null,
    text: usePdf ? input.pdfText!.trim() : "",
    edited: false,
    pendingText: null,
    blank: false,
    layout: null,
    textSource: usePdf ? "pdf" : null,
    pdfText: input.pdfText ?? null,
  };
}

/**
 * Les changements de structure (ajout, suppression, ordre des pages) sont
 * exécutés l'un après l'autre : des captures rapides successives ne peuvent
 * pas s'écraser mutuellement.
 */
let structureLock: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = structureLock.then(fn, fn);
  structureLock = run.catch(() => undefined);
  return run;
}

/** Ajoute des pages au document, à la position donnée (fin par défaut). */
export function addPages(docId: string, inputs: NewPageInput[], atIndex?: number): Promise<PageRecord[]> {
  return serial(async () => {
    const doc = state.docs[docId];
    if (!doc) throw new Error("Document introuvable.");
    const pages = inputs.map((i) => makePageRecord(docId, i));
    const blobs: Array<[string, Blob]> = [];
    inputs.forEach((input, i) => {
      const id = pages[i].id;
      blobs.push([db.blobKey(id, "orig"), input.orig.blob]);
      if (input.processed) {
        blobs.push([db.blobKey(id, "proc"), input.processed.blob]);
        blobs.push([db.blobKey(id, "thumb"), input.processed.thumb]);
      } else if (input.thumb) {
        blobs.push([db.blobKey(id, "thumb"), input.thumb]);
      }
    });
    const ids = [...doc.pageIds];
    const at = atIndex === undefined ? ids.length : Math.max(0, Math.min(atIndex, ids.length));
    ids.splice(at, 0, ...pages.map((p) => p.id));
    const nextDoc = { ...doc, pageIds: ids, updatedAt: Date.now() };
    await persist(() => db.putPageWithBlobs(nextDoc, pages, blobs));
    const pageMap = { ...state.pages };
    for (const p of pages) pageMap[p.id] = p;
    const latest = state.docs[docId] ?? nextDoc;
    setState({ ...state, docs: { ...state.docs, [docId]: { ...latest, pageIds: ids, updatedAt: nextDoc.updatedAt } }, pages: pageMap });
    return pages;
  });
}

export async function updatePage(pageId: string, patch: Partial<PageRecord>): Promise<PageRecord | undefined> {
  const page = state.pages[pageId];
  if (!page) return;
  const next = { ...page, ...patch, updatedAt: Date.now() };
  setState({ ...state, pages: { ...state.pages, [pageId]: next } });
  dirtyPages.delete(pageId);
  await persist(() => db.putPages([next])).catch(() => dirtyPages.add(pageId));
  return next;
}

/** Remplace l'image traitée d'une page (blobs + métadonnées en une transaction). */
export async function savePageImage(
  pageId: string,
  processed: { blob: Blob; thumb: Blob; w: number; h: number },
  patch: Partial<PageRecord>,
): Promise<PageRecord | undefined> {
  const page = state.pages[pageId];
  if (!page) return;
  const doc = state.docs[page.docId];
  const next: PageRecord = {
    ...page,
    ...patch,
    imageStatus: "ready",
    imageError: null,
    imageRev: page.imageRev + 1,
    procW: processed.w,
    procH: processed.h,
    updatedAt: Date.now(),
  };
  await persist(() =>
    db.putPageWithBlobs(doc, [next], [
      [db.blobKey(pageId, "proc"), processed.blob],
      [db.blobKey(pageId, "thumb"), processed.thumb],
    ]),
  );
  // la page a pu être modifiée (texte) pendant l'écriture : ne garder que nos champs
  const latest = state.pages[pageId];
  if (!latest) return;
  const merged: PageRecord = {
    ...latest,
    ...patch,
    imageStatus: "ready",
    imageError: null,
    imageRev: next.imageRev,
    procW: processed.w,
    procH: processed.h,
    updatedAt: next.updatedAt,
  };
  setState({ ...state, pages: { ...state.pages, [pageId]: merged } });
  if (latest !== page) {
    // le texte a changé pendant l'écriture : réécrire la version complète
    dirtyPages.add(pageId);
    scheduleFlush();
  }
  return merged;
}

/** Remplace la photo d'une page (reprise) : l'image et le texte seront recalculés. */
export async function replacePageImage(
  pageId: string,
  orig: { blob: Blob; w: number; h: number },
  params: ImageParams,
  thumb?: Blob,
): Promise<void> {
  const page = state.pages[pageId];
  if (!page) return;
  const doc = state.docs[page.docId];
  const next: PageRecord = {
    ...page,
    ...params,
    origW: orig.w,
    origH: orig.h,
    source: "camera",
    imageStatus: "pending",
    imageError: null,
    // une nouvelle photo rend obsolète le texte issu du PDF
    textSource: page.textSource === "pdf" ? null : page.textSource,
    ocrStatus: "pending",
    ocrError: null,
    updatedAt: Date.now(),
  };
  const blobs: Array<[string, Blob]> = [[db.blobKey(pageId, "orig"), orig.blob]];
  if (thumb) blobs.push([db.blobKey(pageId, "thumb"), thumb]);
  await persist(() => db.putPageWithBlobs(doc, [next], blobs));
  setState({ ...state, pages: { ...state.pages, [pageId]: { ...(state.pages[pageId] ?? next), ...next, text: state.pages[pageId]?.text ?? next.text } } });
}

/** Modification du texte par l'utilisateur (écriture différée). */
export function setPageText(pageId: string, text: string): void {
  const page = state.pages[pageId];
  if (!page || page.text === text) return;
  const edited = text !== (page.ocrText ?? "");
  const next: PageRecord = {
    ...page,
    text,
    edited,
    // une page « à vérifier » corrigée à la main est considérée comme vérifiée
    ocrStatus: page.ocrStatus === "review" && !page.pendingText ? "done" : page.ocrStatus,
    updatedAt: Date.now(),
  };
  const doc = state.docs[page.docId];
  setState({
    ...state,
    pages: { ...state.pages, [pageId]: next },
    docs: doc ? { ...state.docs, [doc.id]: { ...doc, updatedAt: Date.now() } } : state.docs,
  });
  dirtyPages.add(pageId);
  if (doc) dirtyDocs.add(doc.id);
  scheduleFlush();
}

export function reorderPages(docId: string, pageIds: string[]): Promise<void> {
  return serial(async () => {
    const doc = state.docs[docId];
    if (!doc) return;
    const valid = pageIds.filter((id) => doc.pageIds.includes(id));
    if (valid.length !== doc.pageIds.length || new Set(valid).size !== valid.length) return;
    const next = { ...doc, pageIds: valid, updatedAt: Date.now() };
    setState({ ...state, docs: { ...state.docs, [docId]: next } });
    await persist(() => db.putDoc(next));
  });
}

export function movePage(docId: string, pageId: string, toIndex: number): Promise<void> {
  const doc = state.docs[docId];
  if (!doc) return Promise.resolve();
  const ids = doc.pageIds.filter((id) => id !== pageId);
  ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, pageId);
  return reorderPages(docId, ids);
}

export function removePages(docId: string, pageIds: string[]): Promise<void> {
  return serial(async () => {
    const doc = state.docs[docId];
    if (!doc) return;
    const nextDoc = { ...doc, pageIds: doc.pageIds.filter((id) => !pageIds.includes(id)), updatedAt: Date.now() };
    await persist(async () => {
      await db.putDoc(nextDoc);
      await db.deletePagesData(pageIds);
    });
    const pages = { ...state.pages };
    for (const id of pageIds) {
      delete pages[id];
      dirtyPages.delete(id);
    }
    setState({ ...state, docs: { ...state.docs, [docId]: { ...state.docs[docId], pageIds: nextDoc.pageIds } }, pages });
  });
}

export async function clearAllData(): Promise<void> {
  await db.clearAll();
  dirtyPages.clear();
  dirtyDocs.clear();
  setState({ ...state, docs: {}, pages: {} });
}

/** Restaure un document complet (sauvegarde de projet). */
export async function insertRestoredDoc(
  doc: DocRecord,
  pages: PageRecord[],
  blobs: Array<[string, Blob]>,
): Promise<void> {
  await persist(() => db.putPageWithBlobs(doc, pages, blobs));
  const pageMap = { ...state.pages };
  for (const p of pages) pageMap[p.id] = p;
  setState({ ...state, docs: { ...state.docs, [doc.id]: doc }, pages: pageMap });
}

export function setDocLanguage(docId: string, lang: OcrLang): Promise<void> {
  return updateDoc(docId, { lang });
}
export function setDocLayoutMode(docId: string, layoutMode: LayoutMode): Promise<void> {
  return updateDoc(docId, { layoutMode });
}
