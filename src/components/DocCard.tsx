import { useEffect, useRef, useState } from "react";
import { Copy, Download, FileText, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { docStats, docSummary, formatDate, pagesLabel } from "../lib/doc-stats";
import { downloadBlob } from "../lib/export/download";
import { navigate, paths } from "../lib/router";
import { useSettings } from "../lib/settings";
import { deleteDoc, duplicateDoc, updateDoc, useDocPages } from "../lib/store";
import { errorMessage, toast } from "../lib/toast";
import type { DocRecord } from "../lib/types";
import { PageThumb } from "./common";
import { confirmAction, promptText } from "./ui/dialogs";
import { cn } from "./ui/cn";

const summaryStyle = {
  empty: "text-muted",
  working: "text-brand-700",
  paused: "text-slate-600",
  done: "text-emerald-700",
  review: "text-amber-700",
  error: "text-red-700",
} as const;

export async function renameDocument(doc: DocRecord): Promise<void> {
  const name = await promptText({ title: "Renommer le document", label: "Nom du document", initial: doc.name, confirmLabel: "Renommer" });
  if (name && name !== doc.name) await updateDoc(doc.id, { name }).catch((e) => toast.error(errorMessage(e)));
}

export async function deleteDocument(doc: DocRecord, pages: number): Promise<boolean> {
  const ok = await confirmAction({
    title: "Supprimer ce document ?",
    message: `« ${doc.name} » (${pagesLabel(pages)}) sera définitivement supprimé de cet appareil, avec ses images et son texte.`,
    confirmLabel: "Supprimer",
    danger: true,
  });
  if (!ok) return false;
  try {
    await deleteDoc(doc.id);
    toast.success("Document supprimé.");
    return true;
  } catch (err) {
    toast.error(errorMessage(err));
    return false;
  }
}

export async function backupDocument(doc: DocRecord): Promise<void> {
  try {
    const { exportProject } = await import("../lib/export/project");
    const { blob, filename } = await exportProject(doc.id);
    downloadBlob(blob, filename);
    toast.success("Sauvegarde téléchargée. Elle peut être restaurée depuis « Mes documents ».");
  } catch (err) {
    toast.error(errorMessage(err, "La sauvegarde a échoué."));
  }
}

export async function duplicateDocument(doc: DocRecord): Promise<void> {
  try {
    const copy = await duplicateDoc(doc.id);
    if (copy) toast.success(`Copie créée : « ${copy.name} »`);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

export function DocCard({ doc }: { doc: DocRecord }) {
  const pages = useDocPages(doc.id);
  const { ocrPaused } = useSettings();
  const summary = docSummary(docStats(pages), ocrPaused);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

  const actions = [
    { label: "Renommer", icon: Pencil, run: () => renameDocument(doc) },
    { label: "Dupliquer", icon: Copy, run: () => duplicateDocument(doc) },
    { label: "Sauvegarder (.zip)", icon: Download, run: () => backupDocument(doc) },
    { label: "Supprimer", icon: Trash2, run: () => deleteDocument(doc, pages.length), danger: true },
  ];

  return (
    <div className="relative flex items-center gap-3 rounded-2xl border border-line bg-white p-3 shadow-sm transition-colors hover:border-brand-200">
      <button
        type="button"
        onClick={() => navigate(paths.doc(doc.id))}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        aria-label={`Ouvrir ${doc.name}`}
      >
        {pages[0] ? (
          <PageThumb page={pages[0]} className="h-16 w-12 shrink-0" />
        ) : (
          <div className="flex h-16 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400">
            <FileText className="size-6" aria-hidden />
          </div>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{doc.name}</span>
          <span className="mt-0.5 block text-sm text-muted">
            {pagesLabel(pages.length)} · {formatDate(doc.updatedAt)}
          </span>
          <span className={cn("mt-0.5 block text-sm font-medium", summaryStyle[summary.kind])}>{summary.label}</span>
        </span>
      </button>
      <div ref={menuRef} className="relative">
        <button
          type="button"
          aria-label={`Actions pour ${doc.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className="flex size-11 items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100"
        >
          <MoreVertical className="size-5" />
        </button>
        {menuOpen && (
          <div role="menu" className="absolute right-0 top-12 z-20 w-56 overflow-hidden rounded-2xl border border-line bg-white py-1 shadow-xl">
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void a.run();
                }}
                className={cn("flex h-12 w-full items-center gap-3 px-4 text-left hover:bg-slate-50", a.danger && "text-red-700")}
              >
                <a.icon className="size-5" aria-hidden />
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
