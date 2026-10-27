import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { DocRecord, PageRecord } from "./types";

/** Les images sont stockées à part : lister les documents ne charge jamais d'image. */
export type BlobKind = "orig" | "proc" | "thumb";

interface ScanDB extends DBSchema {
  docs: { key: string; value: DocRecord };
  pages: { key: string; value: PageRecord; indexes: { byDoc: string } };
  blobs: { key: string; value: Blob };
}

export class StorageFullError extends Error {
  constructor() {
    super(
      "Espace de stockage insuffisant sur cet appareil. Supprimez des documents ou exportez-les puis libérez de la place.",
    );
    this.name = "StorageFullError";
  }
}

const DB_NAME = "scantext";
let dbPromise: Promise<IDBPDatabase<ScanDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<ScanDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ScanDB>(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore("docs", { keyPath: "id" });
        const pages = db.createObjectStore("pages", { keyPath: "id" });
        pages.createIndex("byDoc", "docId");
        db.createObjectStore("blobs");
      },
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error) && !(typeof DOMException !== "undefined" && err instanceof DOMException)) return false;
  const e = err as DOMException;
  return e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || /quota/i.test(e.message);
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isQuotaError(err)) throw new StorageFullError();
    throw err;
  }
}

export const blobKey = (pageId: string, kind: BlobKind) => `${pageId}:${kind}`;

export async function loadAll(): Promise<{ docs: DocRecord[]; pages: PageRecord[] }> {
  const db = await getDB();
  const [docs, pages] = await Promise.all([db.getAll("docs"), db.getAll("pages")]);
  return { docs, pages };
}

export async function putDoc(doc: DocRecord): Promise<void> {
  const db = await getDB();
  await guard(() => db.put("docs", doc).then(() => undefined));
}

export async function putPages(pages: PageRecord[]): Promise<void> {
  if (!pages.length) return;
  const db = await getDB();
  await guard(async () => {
    const tx = db.transaction("pages", "readwrite");
    await Promise.all([...pages.map((p) => tx.store.put(p)), tx.done]);
  });
}

/** Écrit une page, son document et ses images en une seule transaction (tout ou rien). */
export async function putPageWithBlobs(
  doc: DocRecord,
  pages: PageRecord[],
  blobs: Array<[string, Blob]>,
): Promise<void> {
  const db = await getDB();
  await guard(async () => {
    const tx = db.transaction(["docs", "pages", "blobs"], "readwrite");
    const ops: Promise<unknown>[] = [tx.objectStore("docs").put(doc)];
    for (const p of pages) ops.push(tx.objectStore("pages").put(p));
    for (const [k, b] of blobs) ops.push(tx.objectStore("blobs").put(b, k));
    await Promise.all([...ops, tx.done]);
  });
}

export async function putBlobs(blobs: Array<[string, Blob]>): Promise<void> {
  if (!blobs.length) return;
  const db = await getDB();
  await guard(async () => {
    const tx = db.transaction("blobs", "readwrite");
    await Promise.all([...blobs.map(([k, b]) => tx.store.put(b, k)), tx.done]);
  });
}

export async function getBlob(pageId: string, kind: BlobKind): Promise<Blob | undefined> {
  const db = await getDB();
  return db.get("blobs", blobKey(pageId, kind));
}

export async function deletePagesData(pageIds: string[]): Promise<void> {
  if (!pageIds.length) return;
  const db = await getDB();
  const tx = db.transaction(["pages", "blobs"], "readwrite");
  const ops: Promise<unknown>[] = [];
  for (const id of pageIds) {
    ops.push(tx.objectStore("pages").delete(id));
    for (const kind of ["orig", "proc", "thumb"] as const) ops.push(tx.objectStore("blobs").delete(blobKey(id, kind)));
  }
  await Promise.all([...ops, tx.done]);
}

export async function deleteDocData(docId: string, pageIds: string[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["docs", "pages", "blobs"], "readwrite");
  const ops: Promise<unknown>[] = [tx.objectStore("docs").delete(docId)];
  for (const id of pageIds) {
    ops.push(tx.objectStore("pages").delete(id));
    for (const kind of ["orig", "proc", "thumb"] as const) ops.push(tx.objectStore("blobs").delete(blobKey(id, kind)));
  }
  await Promise.all([...ops, tx.done]);
}

export async function clearAll(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["docs", "pages", "blobs"], "readwrite");
  await Promise.all([
    tx.objectStore("docs").clear(),
    tx.objectStore("pages").clear(),
    tx.objectStore("blobs").clear(),
    tx.done,
  ]);
}
