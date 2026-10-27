import { useEffect, useState } from "react";
import { Download, FileImage, FileText, FileType2, Share2, type LucideIcon } from "lucide-react";
import { getBlob } from "../lib/db";
import type { ExportOptions, ExportPage } from "../lib/export/builders";
import { canShareFiles, downloadBlob, shareBlob } from "../lib/export/download";
import { updateSettings, useSettings } from "../lib/settings";
import { flushPendingWrites } from "../lib/store";
import { safeFileName, stripExtension } from "../lib/text";
import { errorMessage, toast } from "../lib/toast";
import type { DocRecord, PageRecord } from "../lib/types";
import { Button, Dialog, Segmented, Switch } from "./ui";
import { cn } from "./ui/cn";

type Format = "txt" | "docx" | "pdf" | "pdf-ocr";

const FORMATS: { id: Format; ext: string; label: string; desc: string; icon: LucideIcon }[] = [
  { id: "txt", ext: "txt", label: "Texte brut (.txt)", desc: "Le plus simple à copier et réutiliser partout.", icon: FileText },
  { id: "docx", ext: "docx", label: "Word (.docx)", desc: "Document modifiable dans Word, LibreOffice, Google Docs.", icon: FileType2 },
  { id: "pdf", ext: "pdf", label: "PDF du texte", desc: "Votre texte corrigé, mis en page pour être partagé ou imprimé.", icon: FileText },
  { id: "pdf-ocr", ext: "pdf", label: "PDF recherchable", desc: "Les images des pages avec le texte reconnu sélectionnable (Ctrl+F).", icon: FileImage },
];

export function ExportDialog({ open, onClose, doc, pages }: { open: boolean; onClose: () => void; doc: DocRecord; pages: PageRecord[] }) {
  const settings = useSettings();
  const [format, setFormat] = useState<Format>("docx");
  const [name, setName] = useState(doc.name);
  const [docxMode, setDocxMode] = useState<ExportOptions["docxMode"]>("simple");
  const [includeImages, setIncludeImages] = useState(false);
  const [busy, setBusy] = useState<"download" | "share" | null>(null);
  /** Fichier prêt à partager : le partage exige un geste récent de l'utilisateur. */
  const [prepared, setPrepared] = useState<Blob | null>(null);
  const shareable = canShareFiles();

  useEffect(() => {
    if (open) setName(doc.name);
    setPrepared(null);
  }, [open, doc.name]);
  useEffect(() => setPrepared(null), [format, docxMode, includeImages, name]);

  const fmt = FORMATS.find((f) => f.id === format)!;
  const filename = `${safeFileName(stripExtension(name))}.${fmt.ext}`;
  const waiting = pages.filter((p) => p.ocrStatus === "pending" || p.ocrStatus === "processing").length;
  const editedWithLayout = pages.filter((p) => p.edited).length;
  const pendingImages = pages.filter((p) => p.imageStatus !== "ready").length;

  async function build(): Promise<Blob> {
    await flushPendingWrites();
    const exportPages: ExportPage[] = pages.map((p) => ({
      text: p.text,
      edited: p.edited,
      layout: p.layout,
      imageW: p.procW || p.origW,
      imageH: p.procH || p.origH,
      getImage: async () => (await getBlob(p.id, "proc")) ?? (await getBlob(p.id, "orig")),
    }));
    const opts: ExportOptions = { title: doc.name, separators: settings.copySeparators, reflow: settings.copyReflow, docxMode, includeImages };
    const b = await import("../lib/export/builders");
    if (format === "txt") return b.buildTxt(exportPages, opts);
    if (format === "docx") return b.buildDocx(exportPages, opts);
    if (format === "pdf") return b.buildTextPdf(exportPages, opts);
    return b.buildSearchablePdf(exportPages, opts);
  }

  async function run(mode: "download" | "share") {
    setBusy(mode);
    try {
      const blob = await build();
      if (mode === "download") {
        downloadBlob(blob, filename);
        toast.success(`Fichier créé : ${filename}`);
      } else {
        try {
          const shared = await shareBlob(blob, filename, doc.name);
          if (shared) toast.success("Fichier partagé.");
        } catch (err) {
          if (err instanceof DOMException && err.name === "NotAllowedError") {
            // la préparation a pris trop de temps : un second appui lance le partage
            setPrepared(blob);
            toast("Fichier prêt : touchez « Partager maintenant ».");
            return;
          }
          throw err;
        }
      }
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, "L'export a échoué."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      locked={!!busy}
      wide
      title="Exporter le document"
      footer={
        <>
          {shareable &&
            (prepared ? (
              <Button
                variant="subtle"
                icon={<Share2 className="size-4" aria-hidden />}
                onClick={() =>
                  void shareBlob(prepared, filename, doc.name).then(
                    (ok) => ok && (toast.success("Fichier partagé."), onClose()),
                    (e) => toast.error(errorMessage(e)),
                  )
                }
              >
                Partager maintenant
              </Button>
            ) : (
              <Button icon={<Share2 className="size-4" aria-hidden />} loading={busy === "share"} disabled={!!busy} onClick={() => void run("share")}>
                Partager
              </Button>
            ))}
          <Button variant="primary" icon={<Download className="size-4" aria-hidden />} loading={busy === "download"} disabled={!!busy} onClick={() => void run("download")}>
            Télécharger
          </Button>
        </>
      }
    >
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">Format</legend>
        {FORMATS.map((f) => (
          <label
            key={f.id}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-2xl border p-3 transition-colors",
              format === f.id ? "border-brand-600 bg-brand-50 ring-1 ring-brand-600" : "border-line hover:bg-slate-50",
            )}
          >
            <input type="radio" name="format" value={f.id} checked={format === f.id} onChange={() => setFormat(f.id)} className="sr-only" />
            <f.icon className={cn("mt-0.5 size-5 shrink-0", format === f.id ? "text-brand-700" : "text-slate-500")} aria-hidden />
            <span>
              <span className="block font-medium">{f.label}</span>
              <span className="mt-0.5 block text-sm text-muted">{f.desc}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="mt-4 block text-sm font-medium" htmlFor="export-name">
        Nom du fichier
      </label>
      <div className="mt-1.5 flex items-center overflow-hidden rounded-xl border border-line focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-200">
        <input id="export-name" value={name} onChange={(e) => setName(e.target.value)} className="h-12 min-w-0 flex-1 px-3 outline-none" maxLength={120} />
        <span className="shrink-0 bg-slate-50 px-3 py-3 text-sm text-muted">.{fmt.ext}</span>
      </div>

      <div className="mt-3">
        {format === "docx" && (
          <div className="py-2">
            <p className="mb-2 font-medium">Mise en forme Word</p>
            <Segmented
              label="Mise en forme Word"
              value={docxMode}
              onChange={setDocxMode}
              options={[
                { value: "simple", label: "Texte simple" },
                { value: "layout", label: "Mise en page approchée" },
              ]}
              className="w-full"
            />
            <p className="mt-1.5 text-sm text-muted">
              {docxMode === "simple"
                ? "Paragraphes propres, faciles à retravailler."
                : "Reprend approximativement les titres, alignements et retraits détectés. Ne reproduit pas fidèlement une mise en page complexe (colonnes, tableaux)."}
              {docxMode === "layout" && editedWithLayout > 0 && ` Les ${editedWithLayout} page(s) corrigée(s) à la main sont exportées en texte simple.`}
            </p>
            <Switch checked={includeImages} onChange={setIncludeImages} label="Inclure l'image de chaque page" description="Ajoute la page scannée sous son texte (fichier plus lourd)." />
          </div>
        )}
        {format !== "pdf-ocr" && (
          <Switch
            checked={settings.copySeparators}
            onChange={(copySeparators) => updateSettings({ copySeparators })}
            label={format === "txt" ? "Repères de page" : "Une nouvelle page pour chaque page scannée"}
          />
        )}
        {format !== "pdf-ocr" && (
          <Switch checked={settings.copyReflow} onChange={(copyReflow) => updateSettings({ copyReflow })} label="Recoller les lignes en paragraphes" />
        )}
        {format === "pdf-ocr" && editedWithLayout > 0 && (
          <p className="text-sm text-muted">Pour les {editedWithLayout} page(s) corrigée(s), le texte invisible reprend vos corrections ; sa position sur l'image est approximative.</p>
        )}
      </div>

      {(waiting > 0 || (format === "pdf-ocr" && pendingImages > 0)) && (
        <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900" role="note">
          {waiting > 0 && `${waiting} page${waiting > 1 ? "s n'ont" : " n'a"} pas encore été reconnue${waiting > 1 ? "s" : ""} : elle${waiting > 1 ? "s" : ""} sera${waiting > 1 ? "ont" : ""} exportée${waiting > 1 ? "s" : ""} sans texte. `}
          {format === "pdf-ocr" && pendingImages > 0 && `${pendingImages} image(s) encore en préparation : l'image d'origine sera utilisée.`}
        </p>
      )}
      {(format === "pdf" || format === "pdf-ocr") && (
        <p className="mt-3 text-xs text-muted">Police PDF standard : les caractères hors alphabet latin (grec, cyrillique, arabe, chinois…) sont remplacés par « ? ».</p>
      )}
    </Dialog>
  );
}
