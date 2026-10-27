import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Camera,
  Check,
  Copy,
  Download,
  FileText,
  Images,
  ListOrdered,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  Type,
} from "lucide-react";
import { AppShell, PageHeader } from "../components/AppShell";
import { PageThumb, StatusBadge } from "../components/common";
import { backupDocument, deleteDocument, duplicateDocument, renameDocument } from "../components/DocCard";
import { CopyAllButton } from "../components/CopyAllButton";
import { ExportDialog } from "../components/ExportDialog";
import { openPicker } from "../components/ImportHost";
import { Button, Dialog, EmptyState, IconButton, ProgressBar, Segmented, Switch } from "../components/ui";
import { cn } from "../components/ui/cn";
import { confirmAction } from "../components/ui/dialogs";
import { docStats, pagesLabel } from "../lib/doc-stats";
import { pauseOcr, rerunOcr, resumeOcr, retryEngine, retryFailed, setPriorityDoc, useProcessing } from "../lib/ocr/queue";
import { goBack, navigate, paths } from "../lib/router";
import { useSettings } from "../lib/settings";
import { movePage, removePages, reorderPages, updateDoc, useDoc, useDocPages } from "../lib/store";
import { errorMessage, toast } from "../lib/toast";
import type { LayoutMode, OcrLang, PageRecord } from "../lib/types";
import { LANG_OPTIONS } from "./Settings";

export function DocumentScreen({ docId }: { docId: string }) {
  const doc = useDoc(docId)!;
  const pages = useDocPages(docId);
  const stats = docStats(pages);
  const settings = useSettings();
  const proc = useProcessing();
  const [reorder, setReorder] = useState(false);
  const [menu, setMenu] = useState(false);
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  useEffect(() => {
    setPriorityDoc(docId);
    return () => setPriorityDoc(null);
  }, [docId]);

  const remaining = stats.pending + stats.processing;
  const currentPageIndex = proc.ocrPageId ? pages.findIndex((p) => p.id === proc.ocrPageId) : -1;

  async function changeRecognition(patch: { lang?: OcrLang; layoutMode?: LayoutMode }) {
    await updateDoc(docId, patch);
    const recognized = pages.filter((p) => p.textSource === "ocr" && p.ocrStatus !== "pending");
    if (!recognized.length) return;
    const ok = await confirmAction({
      title: "Relancer la reconnaissance ?",
      message: `Le nouveau réglage s'applique aux prochaines pages. Voulez-vous aussi relancer la reconnaissance des ${pagesLabel(recognized.length)} déjà traitées ? Les pages corrigées à la main ne seront pas écrasées : la nouvelle version vous sera proposée.`,
      confirmLabel: "Relancer",
    });
    if (ok) for (const p of recognized) await rerunOcr(p.id);
  }

  async function rerunAll() {
    const recognized = pages.filter((p) => p.textSource !== "pdf" && p.ocrStatus !== "pending" && p.ocrStatus !== "processing");
    if (!recognized.length) return;
    const ok = await confirmAction({
      title: "Relancer toute la reconnaissance ?",
      message: `Les ${pagesLabel(recognized.length)} seront de nouveau préparées et reconnues avec la dernière version (redressement des lignes, tableaux). Les pages corrigées à la main ne seront pas écrasées : la nouvelle version vous sera proposée.`,
      confirmLabel: "Relancer",
    });
    if (ok) for (const p of recognized) await rerunOcr(p.id);
  }

  async function removePage(page: PageRecord, index: number) {
    const ok = await confirmAction({
      title: `Supprimer la page ${index + 1} ?`,
      message: page.edited ? "Cette page contient des corrections manuelles qui seront perdues." : "La page et son texte seront supprimés.",
      confirmLabel: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    await removePages(docId, [page.id]).then(
      () => toast.success("Page supprimée."),
      (e) => toast.error(errorMessage(e)),
    );
  }

  const addButtons = (at?: number, onPick?: () => void) => (
    <div className="grid grid-cols-3 gap-2">
      <Button
        variant="primary"
        icon={<Camera className="size-5" aria-hidden />}
        onClick={() => {
          onPick?.();
          navigate(paths.scan(docId, { at }));
        }}
      >
        Scanner
      </Button>
      <Button
        icon={<Images className="size-5" aria-hidden />}
        onClick={() => {
          onPick?.();
          openPicker("images", { docId, at, openAfter: false });
        }}
      >
        Photos
      </Button>
      <Button
        icon={<FileText className="size-5" aria-hidden />}
        onClick={() => {
          onPick?.();
          openPicker("pdf", { docId, at, openAfter: false });
        }}
      >
        PDF
      </Button>
    </div>
  );

  const menuItems = [
    { label: "Renommer", icon: Pencil, run: () => renameDocument(doc) },
    { label: "Dupliquer", icon: Copy, run: () => duplicateDocument(doc) },
    { label: "Sauvegarder le projet (.zip)", icon: Download, run: () => backupDocument(doc) },
    {
      label: "Supprimer le document",
      icon: Trash2,
      danger: true,
      run: async () => {
        if (await deleteDocument(doc, pages.length)) navigate(paths.documents(), { replace: true });
      },
    },
  ];

  return (
    <AppShell mobileNav={false}>
      <PageHeader
        back={
          <IconButton label="Retour" onClick={() => goBack(paths.documents())}>
            <ArrowLeft className="size-6" />
          </IconButton>
        }
        title={
          <button type="button" className="max-w-full truncate text-left hover:underline" onClick={() => void renameDocument(doc)} title="Renommer">
            {doc.name}
          </button>
        }
        subtitle={pagesLabel(pages.length)}
        actions={
          <IconButton label="Plus d'actions" onClick={() => setMenu(true)}>
            <MoreVertical className="size-5" />
          </IconButton>
        }
      />

      <div className="mx-auto max-w-5xl px-4 pb-32 pt-4 sm:px-6">
        {pages.length > 0 && (
          <section aria-label="Reconnaissance du texte" className="mb-4 rounded-2xl border border-line bg-white p-4 shadow-sm">
            {proc.engineError ? (
              <div className="flex flex-wrap items-center gap-3" role="alert">
                <p className="min-w-0 flex-1 text-sm text-red-800">{proc.engineError}</p>
                <Button size="sm" icon={<RefreshCw className="size-4" aria-hidden />} onClick={retryEngine}>
                  Réessayer
                </Button>
              </div>
            ) : (
              <>
                <div className="mb-2 flex items-center gap-3">
                  <p className="min-w-0 flex-1 font-medium" aria-live="polite">
                    {remaining
                      ? `${stats.treated} page${stats.treated > 1 ? "s" : ""} sur ${stats.total} traitée${stats.treated > 1 ? "s" : ""}`
                      : `Reconnaissance terminée · ${pagesLabel(stats.total)}`}
                  </p>
                  {remaining > 0 &&
                    (settings.ocrPaused ? (
                      <Button size="sm" variant="subtle" icon={<Play className="size-4" aria-hidden />} onClick={resumeOcr}>
                        Reprendre
                      </Button>
                    ) : (
                      <Button size="sm" icon={<Pause className="size-4" aria-hidden />} onClick={pauseOcr}>
                        Pause
                      </Button>
                    ))}
                </div>
                <ProgressBar value={stats.total ? (stats.treated + (currentPageIndex >= 0 ? proc.ocrProgress : 0)) / stats.total : 0} label="Progression de la reconnaissance" />
                <p className="mt-2 text-sm text-muted">
                  {settings.ocrPaused && remaining
                    ? "En pause : la reconnaissance reprendra où elle s'est arrêtée."
                    : currentPageIndex >= 0
                      ? `Page ${currentPageIndex + 1} · ${proc.ocrStatusText} ${Math.round(proc.ocrProgress * 100)} %`
                      : remaining
                        ? "Préparation des images…"
                        : stats.review
                          ? `${stats.review} page${stats.review > 1 ? "s" : ""} à vérifier (résultat incertain ou nouvelle reconnaissance à valider).`
                          : "Vous pouvez maintenant copier, corriger ou exporter le texte."}
                </p>
                {stats.error > 0 && (
                  <Button size="sm" className="mt-3" icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void retryFailed(docId)}>
                    Relancer les {stats.error} page{stats.error > 1 ? "s" : ""} en erreur
                  </Button>
                )}
              </>
            )}
            <details className="mt-3 border-t border-line pt-3">
              <summary className="cursor-pointer text-sm font-medium text-brand-700">Réglages de reconnaissance</summary>
              <div className="pt-3">
                <p className="mb-2 text-sm font-medium">Langue du document</p>
                <Segmented label="Langue du document" value={doc.lang} onChange={(lang) => void changeRecognition({ lang })} options={LANG_OPTIONS} className="w-full sm:w-auto" />
                <Switch
                  checked={doc.layoutMode === "table"}
                  onChange={(v) => void changeRecognition({ layoutMode: v ? "table" : "auto" })}
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <Table2 className="size-4" aria-hidden /> Tableaux et formulaires
                    </span>
                  }
                  description="Repère aussi les tableaux sans traits et garde chaque rangée sur sa ligne (colonnes séparées par des tabulations). Les tableaux à traits sont reconnus dans tous les cas. À désactiver pour les textes en colonnes (journaux)."
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  icon={<RefreshCw className="size-4" aria-hidden />}
                  onClick={() => void rerunAll()}
                >
                  Relancer toute la reconnaissance
                </Button>
              </div>
            </details>
          </section>
        )}

        {pages.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line bg-white">
            <EmptyState icon={<Plus className="size-8" />} title="Ajoutez vos premières pages">
              <p>Scannez avec la caméra, ou importez des photos ou un PDF.</p>
            </EmptyState>
            <div className="px-4 pb-6">{addButtons()}</div>
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-semibold">Pages</h2>
              <Button
                size="sm"
                variant={reorder ? "primary" : "ghost"}
                icon={reorder ? <Check className="size-4" aria-hidden /> : <ListOrdered className="size-4" aria-hidden />}
                onClick={() => setReorder((r) => !r)}
              >
                {reorder ? "Terminé" : "Réorganiser"}
              </Button>
            </div>
            {reorder && (
              <p className="mb-3 rounded-xl bg-brand-50 p-3 text-sm text-brand-900">
                Déplacez les pages avec les flèches (ou glissez-les sur ordinateur). Touchez « + » pour insérer une page à cet endroit.
              </p>
            )}
            <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {pages.map((page, i) => (
                <li
                  key={page.id}
                  draggable={reorder}
                  onDragStart={(e) => {
                    setDragId(page.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (dragId) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId && dragId !== page.id) void movePage(docId, dragId, i);
                    setDragId(null);
                  }}
                  onDragEnd={() => setDragId(null)}
                  className={cn("relative", dragId === page.id && "opacity-40")}
                >
                  {reorder && (
                    <button
                      type="button"
                      onClick={() => setInsertAt(i)}
                      aria-label={`Insérer une page avant la page ${i + 1}`}
                      className="absolute -left-2.5 top-1/3 z-10 flex size-8 items-center justify-center rounded-full bg-brand-700 text-white shadow-md"
                    >
                      <Plus className="size-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => !reorder && navigate(paths.page(docId, page.id))}
                    className={cn("block w-full rounded-xl text-left", !reorder && "hover:opacity-90")}
                    aria-label={`Page ${i + 1}`}
                    tabIndex={reorder ? -1 : 0}
                  >
                    <PageThumb page={page} className="aspect-[3/4] w-full" />
                  </button>
                  <div className="mt-1.5 flex items-center justify-between gap-1">
                    <span className="text-sm font-semibold">{i + 1}</span>
                    <StatusBadge page={page} />
                  </div>
                  {reorder && (
                    <div className="mt-1.5 grid grid-cols-3 gap-1">
                      <IconButton label={`Déplacer la page ${i + 1} vers le début`} size="sm" variant="secondary" disabled={i === 0} onClick={() => void movePage(docId, page.id, i - 1)}>
                        <ArrowUp className="size-4 sm:-rotate-90" />
                      </IconButton>
                      <IconButton label={`Déplacer la page ${i + 1} vers la fin`} size="sm" variant="secondary" disabled={i === pages.length - 1} onClick={() => void movePage(docId, page.id, i + 1)}>
                        <ArrowDown className="size-4 sm:-rotate-90" />
                      </IconButton>
                      <IconButton label={`Supprimer la page ${i + 1}`} size="sm" variant="secondary" className="text-red-700" onClick={() => void removePage(page, i)}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  )}
                </li>
              ))}
              <li>
                <button
                  type="button"
                  onClick={() => setInsertAt(pages.length)}
                  className="flex aspect-[3/4] w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-brand-200 bg-brand-50/50 text-brand-800 hover:bg-brand-50"
                >
                  <Plus className="size-8" aria-hidden />
                  <span className="text-sm font-medium">Ajouter des pages</span>
                </button>
              </li>
            </ol>
            {reorder && pages.length > 1 && (
              <div className="mt-4 flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => void reorderPages(docId, [...doc.pageIds].reverse())}>
                  Inverser l'ordre des pages
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {pages.length > 0 && (
        <div className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 lg:left-64">
          <div className="mx-auto grid max-w-5xl grid-cols-[1fr_auto_auto] gap-2 px-4 py-3 sm:px-6">
            <CopyAllButton pages={pages} docName={doc.name} />
            <Button size="lg" className="max-sm:w-14 max-sm:px-0" aria-label="Voir et modifier le texte" icon={<Type className="size-5" aria-hidden />} onClick={() => navigate(paths.editor(docId))}>
              <span className="max-sm:hidden">Voir et modifier le texte</span>
            </Button>
            <IconButton label="Exporter" size="lg" variant="secondary" onClick={() => setExportOpen(true)}>
              <Download className="size-5" />
            </IconButton>
          </div>
        </div>
      )}

      <Dialog open={insertAt !== null} onClose={() => setInsertAt(null)} title={insertAt === pages.length ? "Ajouter des pages" : `Insérer avant la page ${(insertAt ?? 0) + 1}`}>
        <div className="pb-2">{addButtons(insertAt === pages.length ? undefined : (insertAt ?? undefined), () => setInsertAt(null))}</div>
      </Dialog>

      <Dialog open={menu} onClose={() => setMenu(false)} title={doc.name}>
        <ul className="-mx-2 pb-2">
          {menuItems.map((it) => (
            <li key={it.label}>
              <button
                type="button"
                onClick={() => {
                  setMenu(false);
                  void it.run();
                }}
                className={cn("flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-slate-50", it.danger && "text-red-700")}
              >
                <it.icon className="size-5" aria-hidden />
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      </Dialog>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} doc={doc} pages={pages} />
    </AppShell>
  );
}
