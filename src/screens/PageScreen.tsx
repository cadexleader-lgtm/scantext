import { useEffect, useState } from "react";
import { ArrowLeft, Camera, ChevronLeft, ChevronRight, Images, Loader2, SlidersHorizontal, Trash2, Type } from "lucide-react";
import { CropEditor } from "../components/CropEditor";
import { AdjustControls, autoQuad, usePreviewSource, useProcessedPreview } from "../components/ImageAdjust";
import { openPicker } from "../components/ImportHost";
import { PageTextBlock } from "../components/PageText";
import { useBlobUrl } from "../components/common";
import { Button, Dialog, IconButton, Segmented } from "../components/ui";
import { cn } from "../components/ui/cn";
import { confirmAction } from "../components/ui/dialogs";
import { getBlob } from "../lib/db";
import { fullQuad } from "../lib/image/geometry";
import { setPageImageParams, setPriorityDoc } from "../lib/ocr/queue";
import { goBack, navigate, paths } from "../lib/router";
import { removePages, useDoc, useDocPages } from "../lib/store";
import { errorMessage, toast } from "../lib/toast";
import type { ImageParams, OcrLayout, PageRecord } from "../lib/types";

function UncertainWords({ layout }: { layout: OcrLayout }) {
  return (
    <div className="editor-area rounded-xl bg-white px-3 py-2 text-[17px]" aria-label="Texte reconnu, mots incertains surlignés">
      {layout.paragraphs.map((p, pi) => (
        <p key={pi} className="mb-3">
          {p.lines.map((l, li) => (
            <span key={li} className="block">
              {l.words.map((w, wi) => (
                <span key={wi}>
                  <span className={cn(w.c < 60 && "rounded bg-amber-200 px-0.5", w.c < 40 && "bg-red-200")} title={`Confiance ${w.c} %`}>
                    {w.t}
                  </span>{" "}
                </span>
              ))}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

function ImageEditor({ page, onDone }: { page: PageRecord; onDone: () => void }) {
  const [orig, setOrig] = useState<Blob | null>(null);
  useEffect(() => {
    void getBlob(page.id, "orig").then((b) => setOrig(b ?? null));
  }, [page.id]);
  const source = usePreviewSource(orig);
  const [params, setParams] = useState<ImageParams>({ quad: page.quad, rotation: page.rotation, filter: page.filter, sharpen: page.sharpen });
  const [cropping, setCropping] = useState(false);
  const preview = useProcessedPreview(source, params);

  async function apply() {
    try {
      await setPageImageParams(page.id, params);
      toast.success(page.edited ? "Image mise à jour. Vos corrections de texte sont conservées." : "Image mise à jour. Le texte va être recalculé.");
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative h-[55dvh] overflow-hidden rounded-xl bg-slate-900 p-2">
        {!source ? (
          <div className="flex size-full items-center justify-center text-white/80">
            <Loader2 className="size-8 animate-spin" aria-hidden />
          </div>
        ) : cropping ? (
          <CropEditor src={source.url} width={source.w} height={source.h} quad={params.quad ?? fullQuad(source.w, source.h)} onChange={(quad) => setParams({ ...params, quad })} />
        ) : preview.url ? (
          <img src={preview.url} alt="Aperçu" className="size-full object-contain" />
        ) : null}
      </div>
      <AdjustControls
        params={params}
        onChange={setParams}
        cropping={cropping}
        source={source}
        onToggleCrop={() => {
          if (!cropping && !params.quad && source) setParams({ ...params, quad: autoQuad(source) ?? fullQuad(source.w, source.h) });
          setCropping((c) => !c);
        }}
      />
      {!cropping && (
        <div className="flex justify-end gap-2">
          <Button onClick={onDone}>Annuler</Button>
          <Button variant="primary" onClick={() => void apply()} disabled={!source}>
            Appliquer
          </Button>
        </div>
      )}
    </div>
  );
}

export function PageScreen({ docId, pageId }: { docId: string; pageId: string }) {
  const doc = useDoc(docId)!;
  const pages = useDocPages(docId);
  const index = pages.findIndex((p) => p.id === pageId);
  const page = pages[index];
  const [view, setView] = useState<"image" | "text">("image");
  const [editing, setEditing] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const [insert, setInsert] = useState<number | null>(null);
  const url = useBlobUrl(page?.id, page?.imageStatus === "ready" ? "proc" : "orig", `${page?.imageStatus}-${page?.imageRev}`);

  useEffect(() => {
    setPriorityDoc(docId);
    return () => setPriorityDoc(null);
  }, [docId]);

  if (!page)
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-lg font-semibold">Cette page n'existe plus.</p>
        <Button variant="primary" onClick={() => navigate(paths.doc(docId), { replace: true })}>
          Retour au document
        </Button>
      </div>
    );

  const go = (i: number) => navigate(paths.page(docId, pages[i].id), { replace: true });

  async function remove() {
    const ok = await confirmAction({
      title: `Supprimer la page ${index + 1} ?`,
      message: page.edited ? "Cette page contient des corrections manuelles qui seront perdues." : "La page et son texte seront supprimés.",
      confirmLabel: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    try {
      await removePages(docId, [page.id]);
      toast.success("Page supprimée.");
      navigate(paths.doc(docId), { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const canHighlight = !!page.layout && !page.edited && page.textSource === "ocr" && !page.blank;

  return (
    <div className="min-h-dvh bg-canvas pb-10">
      <header className="safe-top sticky top-0 z-20 border-b border-line bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center gap-2 px-3 py-2 sm:px-5">
          <IconButton label="Retour au document" onClick={() => goBack(paths.doc(docId))}>
            <ArrowLeft className="size-6" />
          </IconButton>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">
              Page {index + 1} sur {pages.length}
            </h1>
            <p className="truncate text-sm text-muted">{doc.name}</p>
          </div>
          <IconButton label="Page précédente" disabled={index === 0} onClick={() => go(index - 1)}>
            <ChevronLeft className="size-6" />
          </IconButton>
          <IconButton label="Page suivante" disabled={index === pages.length - 1} onClick={() => go(index + 1)}>
            <ChevronRight className="size-6" />
          </IconButton>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-3 py-4 sm:px-5">
        <div className="mb-3 md:hidden">
          <Segmented
            label="Afficher"
            value={view}
            onChange={setView}
            className="w-full"
            options={[
              { value: "image", label: "Image" },
              { value: "text", label: "Texte" },
            ]}
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <section className={cn(view !== "image" && "max-md:hidden")} aria-label="Image de la page">
            {editing ? (
              <ImageEditor page={page} onDone={() => setEditing(false)} />
            ) : (
              <>
                <div className="relative flex h-[60dvh] items-center justify-center overflow-hidden rounded-xl bg-slate-100 ring-1 ring-line">
                  {url ? <img src={url} alt={`Page ${index + 1}`} className="size-full object-contain" /> : <Loader2 className="size-6 animate-spin text-slate-400" aria-hidden />}
                  {page.imageStatus === "pending" && (
                    <span className="absolute bottom-2 left-2 rounded-full bg-white/90 px-3 py-1 text-sm shadow">Préparation de l'image…</span>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button variant="subtle" icon={<SlidersHorizontal className="size-5" aria-hidden />} onClick={() => setEditing(true)}>
                    Recadrer, filtres
                  </Button>
                  <Button icon={<Camera className="size-5" aria-hidden />} onClick={() => navigate(paths.scan(docId, { replace: page.id }))}>
                    Reprendre la photo
                  </Button>
                  <Button icon={<Images className="size-5" aria-hidden />} onClick={() => setInsert(index)}>
                    Insérer avant
                  </Button>
                  <Button icon={<Images className="size-5" aria-hidden />} onClick={() => setInsert(index + 1)}>
                    Insérer après
                  </Button>
                  <Button variant="ghost" className="col-span-2 text-red-700" icon={<Trash2 className="size-5" aria-hidden />} onClick={() => void remove()}>
                    Supprimer la page
                  </Button>
                </div>
              </>
            )}
          </section>

          <section className={cn("rounded-2xl bg-white p-3 shadow-sm ring-1 ring-line", view !== "text" && "max-md:hidden")}>
            {canHighlight && (
              <label className="mb-2 flex cursor-pointer items-center gap-2 text-sm text-muted">
                <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} className="size-4 accent-brand-700" />
                Surligner les mots incertains (lecture seule)
              </label>
            )}
            {highlight && canHighlight ? <UncertainWords layout={page.layout!} /> : <PageTextBlock page={page} index={index} />}
            <Button className="mt-3" variant="ghost" icon={<Type className="size-4" aria-hidden />} onClick={() => navigate(paths.editor(docId, page.id))}>
              Ouvrir dans l'éditeur
            </Button>
          </section>
        </div>
      </main>

      <Dialog open={insert !== null} onClose={() => setInsert(null)} title={insert === index ? `Insérer avant la page ${index + 1}` : `Insérer après la page ${index + 1}`}>
        <div className="grid grid-cols-2 gap-2 pb-2">
          <Button
            variant="primary"
            icon={<Camera className="size-5" aria-hidden />}
            onClick={() => {
              const at = insert ?? index;
              setInsert(null);
              navigate(paths.scan(docId, { at }));
            }}
          >
            Scanner
          </Button>
          <Button
            icon={<Images className="size-5" aria-hidden />}
            onClick={() => {
              const at = insert ?? index;
              setInsert(null);
              openPicker("any", { docId, at, openAfter: false });
            }}
          >
            Photos ou PDF
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
