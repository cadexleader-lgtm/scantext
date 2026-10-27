import { BACKUP_EXTENSION } from "../../config";
import { getBlob, blobKey, type BlobKind } from "../db";
import { newId } from "../id";
import { flushPendingWrites, getDocPages, getState, insertRestoredDoc } from "../store";
import type { DocRecord, PageRecord } from "../types";

/**
 * Sauvegarde complète d'un projet (images d'origine, images traitées, texte,
 * corrections, ordre des pages) dans une archive .zip, restaurable sur
 * n'importe quel appareil.
 */

const FORMAT = "scantext-project";
const VERSION = 1;

interface ManifestPage {
  record: Omit<PageRecord, "id" | "docId">;
  files: Partial<Record<BlobKind, string>>;
}
interface Manifest {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  doc: Omit<DocRecord, "id" | "pageIds">;
  pages: ManifestPage[];
}

const extOf = (b: Blob) => (b.type === "image/png" ? "png" : "jpg");

export async function exportProject(docId: string): Promise<{ blob: Blob; filename: string }> {
  await flushPendingWrites();
  const doc = getState().docs[docId];
  if (!doc) throw new Error("Document introuvable.");
  const { zip } = await import("fflate");
  const files: Record<string, Uint8Array> = {};
  const pages: ManifestPage[] = [];
  const docPages = getDocPages(docId);
  for (let i = 0; i < docPages.length; i++) {
    const page = docPages[i];
    const { id: _id, docId: _docId, ...record } = page;
    const entry: ManifestPage = {
      record: { ...record, ocrStatus: record.ocrStatus === "processing" ? "pending" : record.ocrStatus },
      files: {},
    };
    for (const kind of ["orig", "proc", "thumb"] as const) {
      const b = await getBlob(page.id, kind);
      if (!b) continue;
      const name = `pages/${String(i + 1).padStart(3, "0")}-${kind}.${extOf(b)}`;
      files[name] = new Uint8Array(await b.arrayBuffer());
      entry.files[kind] = name;
    }
    pages.push(entry);
  }
  const { id: _id, pageIds: _ids, ...docMeta } = doc;
  const manifest: Manifest = { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), doc: docMeta, pages };
  files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest));
  const data = await new Promise<Uint8Array>((resolve, reject) =>
    // les images sont déjà compressées : on les stocke sans recompression
    zip(files, { level: 0 }, (err, out) => (err ? reject(err) : resolve(out))),
  );
  return {
    blob: new Blob([data as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
    filename: `${doc.name.replace(/[\\/:*?"<>|]/g, " ").trim() || "document"}${BACKUP_EXTENSION}`,
  };
}

export async function importProject(file: Blob): Promise<DocRecord> {
  const { unzip } = await import("fflate");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(bytes, (err, out) => (err ? reject(new Error("Ce fichier n'est pas une sauvegarde valide.")) : resolve(out))),
  );
  const raw = files["manifest.json"];
  if (!raw) throw new Error("Ce fichier n'est pas une sauvegarde de projet.");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error("La sauvegarde est endommagée (description illisible).");
  }
  if (manifest.format !== FORMAT) throw new Error("Ce fichier n'est pas une sauvegarde de projet.");
  if (manifest.version > VERSION) throw new Error("Cette sauvegarde vient d'une version plus récente de l'application. Mettez l'application à jour.");

  const now = Date.now();
  const doc: DocRecord = { ...manifest.doc, id: newId(), pageIds: [], updatedAt: now };
  if (Object.values(getState().docs).some((d) => d.name === doc.name)) doc.name = `${doc.name} (restauré)`;
  const pages: PageRecord[] = [];
  const blobs: Array<[string, Blob]> = [];
  for (const entry of manifest.pages) {
    if (!entry.files.orig || !files[entry.files.orig]) continue; // page inutilisable sans son image
    const page: PageRecord = { ...entry.record, id: newId(), docId: doc.id };
    for (const kind of ["orig", "proc", "thumb"] as const) {
      const name = entry.files[kind];
      const data = name ? files[name] : undefined;
      if (data) blobs.push([blobKey(page.id, kind), new Blob([data as Uint8Array<ArrayBuffer>], { type: name!.endsWith(".png") ? "image/png" : "image/jpeg" })]);
    }
    // image traitée manquante : elle sera recalculée
    if (!entry.files.proc || !files[entry.files.proc]) page.imageStatus = "pending";
    pages.push(page);
    doc.pageIds.push(page.id);
  }
  await insertRestoredDoc(doc, pages, blobs);
  return doc;
}
