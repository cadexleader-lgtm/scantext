import { useRef, useState } from "react";
import { FileText, ScanText } from "lucide-react";
import { importImages, importPdf, inspectPdf, isImage, isPdf, type ImportProgress } from "../lib/import";
import { navigate, paths } from "../lib/router";
import { errorMessage, toast } from "../lib/toast";
import { Button, Dialog, ProgressBar } from "./ui";

/**
 * Sélecteurs de fichiers partagés par toute l'application. Les champs <input
 * type=file> restent montés en permanence : `openPicker()` peut ainsi être
 * appelé directement depuis un clic (exigence des navigateurs).
 */

export type PickerKind = "images" | "pdf" | "camera" | "any";
export interface PickTarget {
  /** null = créer un nouveau document. */
  docId: string | null;
  /** Position d'insertion (fin par défaut). */
  at?: number;
  /** Ouvrir le document une fois l'import terminé. */
  openAfter?: boolean;
}

const inputs: Partial<Record<PickerKind, HTMLInputElement | null>> = {};
let target: PickTarget = { docId: null };

export function openPicker(kind: PickerKind, t: PickTarget): void {
  target = t;
  const input = inputs[kind];
  if (!input) return;
  input.value = "";
  input.click();
}

interface PdfChoice {
  file: File;
  pages: number;
  resolve: (useText: boolean | null) => void;
}

export function ImportHost() {
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [pdfChoice, setPdfChoice] = useState<PdfChoice | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function handleFiles(files: File[], kind: PickerKind) {
    if (!files.length) return;
    const t = target;
    const pdfs = files.filter(isPdf);
    const images = files.filter((f) => !isPdf(f) && isImage(f));
    const rejected = files.filter((f) => !isPdf(f) && !isImage(f));
    if (rejected.length) toast.error(`Format non pris en charge : ${rejected.map((f) => f.name).join(", ")}`);
    if (!pdfs.length && !images.length) return;

    const controller = new AbortController();
    abortRef.current = controller;
    let docId = t.docId;
    let at = t.at;
    let added = 0;
    const failed: string[] = [];
    try {
      if (images.length) {
        setProgress({ done: 0, total: images.length, label: "Préparation des images…" });
        const r = await importImages(images, { docId, atIndex: at, onProgress: setProgress, signal: controller.signal });
        docId = r.docId;
        added += r.added;
        failed.push(...r.failed);
        if (at !== undefined) at += r.added;
      }
      for (const pdf of pdfs) {
        if (controller.signal.aborted) break;
        setProgress({ done: 0, total: 1, label: `Lecture de « ${pdf.name} »…` });
        const info = await inspectPdf(pdf);
        let useText = false;
        if (info.hasText) {
          setProgress(null);
          const choice = await new Promise<boolean | null>((resolve) => setPdfChoice({ file: pdf, pages: info.pages, resolve }));
          setPdfChoice(null);
          if (choice === null) continue;
          useText = choice;
        }
        setProgress({ done: 0, total: info.pages, label: "Import du PDF…" });
        const r = await importPdf(pdf, { docId, atIndex: at, useText, onProgress: setProgress, signal: controller.signal });
        docId = r.docId;
        added += r.added;
        failed.push(...r.failed);
        if (at !== undefined) at += r.added;
      }
    } catch (err) {
      failed.push(errorMessage(err));
    } finally {
      setProgress(null);
      abortRef.current = null;
    }

    if (added) {
      toast.success(
        `${added} page${added > 1 ? "s" : ""} ajoutée${added > 1 ? "s" : ""}${controller.signal.aborted ? " (import interrompu)" : ""}.`,
        kind === "camera" && docId
          ? { action: { label: "Photo suivante", onClick: () => openPicker("camera", { docId, openAfter: false }) }, duration: 8000 }
          : {},
      );
    }
    if (failed.length) toast.error(failed.length === 1 ? failed[0] : `${failed.length} fichiers n'ont pas pu être importés : ${failed.slice(0, 3).join(" · ")}`);
    if (docId && added && (t.openAfter ?? t.docId === null)) navigate(paths.doc(docId));
  }

  const bind = (kind: PickerKind) => (el: HTMLInputElement | null) => {
    inputs[kind] = el;
  };
  const onChange = (kind: PickerKind) => (e: React.ChangeEvent<HTMLInputElement>) =>
    void handleFiles(Array.from(e.currentTarget.files ?? []), kind);

  return (
    <>
      <div className="hidden" aria-hidden>
        <input ref={bind("images")} type="file" accept="image/*" multiple onChange={onChange("images")} tabIndex={-1} />
        <input ref={bind("pdf")} type="file" accept="application/pdf,.pdf" multiple onChange={onChange("pdf")} tabIndex={-1} />
        <input ref={bind("camera")} type="file" accept="image/*" capture="environment" onChange={onChange("camera")} tabIndex={-1} />
        <input ref={bind("any")} type="file" accept="image/*,application/pdf,.pdf" multiple onChange={onChange("any")} tabIndex={-1} />
      </div>

      <Dialog
        open={!!progress}
        onClose={() => undefined}
        locked
        title="Import en cours"
        description="Vous pourrez modifier, recadrer et réordonner les pages ensuite."
        footer={
          <Button onClick={() => abortRef.current?.abort()} disabled={abortRef.current?.signal.aborted}>
            Arrêter l'import
          </Button>
        }
      >
        {progress && (
          <div className="space-y-3 py-2">
            <p className="text-sm font-medium">{progress.label}</p>
            <ProgressBar value={progress.total ? progress.done / progress.total : 0} label="Progression de l'import" />
            <p className="text-sm text-muted">
              {progress.done} / {progress.total}
            </p>
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!pdfChoice}
        onClose={() => pdfChoice?.resolve(null)}
        title="Ce PDF contient déjà du texte"
        description={pdfChoice ? `« ${pdfChoice.file.name} » · ${pdfChoice.pages} page${pdfChoice.pages > 1 ? "s" : ""}` : undefined}
      >
        <div className="space-y-3 pb-2">
          <button
            type="button"
            onClick={() => pdfChoice?.resolve(true)}
            className="flex w-full items-start gap-3 rounded-2xl border-2 border-brand-600 bg-brand-50 p-4 text-left"
          >
            <FileText className="mt-0.5 size-6 shrink-0 text-brand-700" aria-hidden />
            <span>
              <span className="block font-semibold">Utiliser le texte du PDF (recommandé)</span>
              <span className="mt-0.5 block text-sm text-muted">Exact et instantané. Les pages sans texte (scannées) seront reconnues par OCR.</span>
            </span>
          </button>
          <button type="button" onClick={() => pdfChoice?.resolve(false)} className="flex w-full items-start gap-3 rounded-2xl border border-line p-4 text-left hover:bg-slate-50">
            <ScanText className="mt-0.5 size-6 shrink-0 text-slate-600" aria-hidden />
            <span>
              <span className="block font-semibold">Refaire la reconnaissance (OCR)</span>
              <span className="mt-0.5 block text-sm text-muted">Utile si le texte intégré au PDF est incorrect ou illisible.</span>
            </span>
          </button>
        </div>
      </Dialog>
    </>
  );
}
