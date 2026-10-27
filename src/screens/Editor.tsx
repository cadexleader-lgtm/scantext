import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CloudCheck,
  Download,
  Image as ImageIcon,
  Loader2,
  Replace,
  Rows3,
  Save,
  Search,
  StickyNote,
  X,
} from "lucide-react";
import { CopyAllButton } from "../components/CopyAllButton";
import { ExportDialog } from "../components/ExportDialog";
import { PageStatusLine, PageTextBlock } from "../components/PageText";
import { useBlobUrl } from "../components/common";
import { Button, IconButton, Segmented } from "../components/ui";
import { cn } from "../components/ui/cn";
import { setPriorityDoc } from "../lib/ocr/queue";
import { goBack, navigate, paths } from "../lib/router";
import { flushPendingWrites, setPageText, useDoc, useDocPages, useSaveState } from "../lib/store";
import { findMatches, replaceAll } from "../lib/text";
import { errorMessage, toast } from "../lib/toast";
import type { PageRecord } from "../lib/types";

type Mode = "continuous" | "page";
const MODE_KEY = "scantext.editorMode";

/** Position verticale (px) d'un caractère dans une zone de texte, via un miroir invisible. */
function caretOffset(ta: HTMLTextAreaElement, index: number): number {
  const mirror = document.createElement("div");
  const cs = getComputedStyle(ta);
  for (const prop of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingLeft", "paddingRight", "borderTopWidth", "boxSizing"] as const)
    mirror.style[prop] = cs[prop];
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = ta.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top;
}

function SaveIndicator() {
  const s = useSaveState();
  if (s.error) return <span className="text-sm font-medium text-red-700">Non enregistré</span>;
  if (s.pending)
    return (
      <span className="inline-flex items-center gap-1 text-sm text-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Enregistrement…
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-sm text-emerald-700">
      <CloudCheck className="size-4" aria-hidden /> Enregistré
    </span>
  );
}

function PageImage({ page, className }: { page: PageRecord; className?: string }) {
  const url = useBlobUrl(page.id, page.imageStatus === "ready" ? "proc" : "orig", `${page.imageStatus}-${page.imageRev}`);
  const [zoom, setZoom] = useState(false);
  return (
    <div className={cn("overflow-auto rounded-xl bg-slate-100 ring-1 ring-line", className)}>
      {url ? (
        <button type="button" onClick={() => setZoom((z) => !z)} className="block w-full cursor-zoom-in" aria-label={zoom ? "Réduire l'image" : "Agrandir l'image"}>
          <img src={url} alt={`Image de la page`} className={cn(zoom ? "max-w-none" : "mx-auto max-h-full w-full object-contain")} style={zoom ? { width: "200%" } : undefined} />
        </button>
      ) : (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-slate-400" aria-hidden />
        </div>
      )}
    </div>
  );
}

export function EditorScreen({ docId, initialPageId }: { docId: string; initialPageId?: string }) {
  const doc = useDoc(docId)!;
  const pages = useDocPages(docId);
  const [mode, setModeState] = useState<Mode>(() => {
    if (initialPageId) return "page";
    try {
      return (localStorage.getItem(MODE_KEY) as Mode) || "continuous";
    } catch {
      return "continuous";
    }
  });
  const [pageIndex, setPageIndex] = useState(() => Math.max(0, initialPageId ? pages.findIndex((p) => p.id === initialPageId) : 0));
  const [mobileView, setMobileView] = useState<"text" | "image">("text");
  const [showMarkers, setShowMarkers] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const areas = useRef(new Map<string, HTMLTextAreaElement>());
  const searchStarted = useRef(false);

  useEffect(() => {
    setPriorityDoc(docId);
    return () => {
      setPriorityDoc(null);
      void flushPendingWrites();
    };
  }, [docId]);

  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // préférence non mémorisée
    }
  };

  const safeIndex = Math.min(pageIndex, Math.max(0, pages.length - 1));
  const current = pages[safeIndex];
  const matches = useMemo(() => (searchOpen ? findMatches(pages, query) : []), [pages, query, searchOpen]);

  function goToMatch(i: number) {
    if (!matches.length) return;
    const idx = ((i % matches.length) + matches.length) % matches.length;
    setMatchIndex(idx);
    searchStarted.current = true;
    const m = matches[idx];
    if (mode === "page") setPageIndex(m.pageIndex);
    requestAnimationFrame(() => {
      const ta = areas.current.get(m.pageId);
      if (!ta) return;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(m.start, m.end);
      const y = ta.getBoundingClientRect().top + window.scrollY + caretOffset(ta, m.start);
      window.scrollTo({ top: Math.max(0, y - window.innerHeight / 3), behavior: "smooth" });
    });
  }

  function replaceCurrent() {
    const m = matches[matchIndex];
    if (!m) return;
    const page = pages[m.pageIndex];
    setPageText(page.id, page.text.slice(0, m.start) + replacement + page.text.slice(m.end));
  }

  function replaceEverywhere() {
    let total = 0;
    for (const p of pages) {
      const r = replaceAll(p.text, query, replacement);
      if (r.count) {
        setPageText(p.id, r.text);
        total += r.count;
      }
    }
    toast.success(total ? `${total} remplacement${total > 1 ? "s" : ""} effectué${total > 1 ? "s" : ""}.` : "Aucune occurrence trouvée.");
  }

  async function save() {
    try {
      await flushPendingWrites();
      toast.success("Document enregistré sur cet appareil.");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const register = (id: string) => (el: HTMLTextAreaElement | null) => {
    if (el) areas.current.set(id, el);
    else areas.current.delete(id);
  };

  const actions = (
    <>
      <CopyAllButton pages={pages} docName={doc.name} className="min-w-0 flex-1 lg:flex-none" />
      <Button size="lg" className="max-sm:w-14 max-sm:px-0" icon={<Save className="size-5" aria-hidden />} onClick={() => void save()} aria-label="Enregistrer">
        <span className="max-sm:hidden">Enregistrer</span>
      </Button>
      <Button size="lg" className="max-sm:w-14 max-sm:px-0" icon={<Download className="size-5" aria-hidden />} onClick={() => setExportOpen(true)} aria-label="Exporter">
        <span className="max-sm:hidden">Exporter</span>
      </Button>
    </>
  );

  return (
    <div className="min-h-dvh bg-canvas pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-10">
      <header className="safe-top sticky top-0 z-20 border-b border-line bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center gap-2 px-3 py-2 sm:px-5">
          <IconButton label="Retour au document" onClick={() => goBack(paths.doc(docId))}>
            <ArrowLeft className="size-6" />
          </IconButton>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">{doc.name}</h1>
            <SaveIndicator />
          </div>
          <Segmented<Mode>
            label="Affichage"
            value={mode}
            onChange={setMode}
            className="max-sm:hidden"
            options={[
              { value: "continuous", label: "Texte continu", icon: <Rows3 className="size-4" aria-hidden /> },
              { value: "page", label: "Par page", icon: <StickyNote className="size-4" aria-hidden /> },
            ]}
          />
          <IconButton label="Rechercher dans le texte" variant={searchOpen ? "subtle" : "ghost"} onClick={() => setSearchOpen((o) => !o)}>
            <Search className="size-5" />
          </IconButton>
          <div className="hidden gap-2 lg:flex">{actions}</div>
        </div>
        <div className="px-3 pb-2 sm:hidden">
          <Segmented<Mode>
            label="Affichage"
            value={mode}
            onChange={setMode}
            className="w-full"
            options={[
              { value: "continuous", label: "Texte continu" },
              { value: "page", label: "Par page" },
            ]}
          />
        </div>
        {searchOpen && (
          <div className="mx-auto max-w-6xl space-y-2 border-t border-line px-3 py-2 sm:px-5">
            <div className="flex items-center gap-2">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">Rechercher</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
                <input
                  autoFocus
                  type="search"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setMatchIndex(0);
                    searchStarted.current = false;
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    if (!searchStarted.current) goToMatch(0);
                    else goToMatch(matchIndex + (e.shiftKey ? -1 : 1));
                    searchStarted.current = true;
                  }}
                  placeholder="Rechercher (sans tenir compte des accents)"
                  className="h-11 w-full rounded-xl border border-line pl-9 pr-3 outline-none focus:border-brand-500"
                />
              </label>
              <span className="w-16 shrink-0 text-center text-sm text-muted" aria-live="polite">
                {query ? (matches.length ? `${matchIndex + 1}/${matches.length}` : "0") : ""}
              </span>
              <IconButton label="Occurrence précédente" size="sm" disabled={!matches.length} onClick={() => goToMatch(matchIndex - 1)}>
                <ChevronUp className="size-5" />
              </IconButton>
              <IconButton label="Occurrence suivante" size="sm" disabled={!matches.length} onClick={() => goToMatch(matchIndex + 1)}>
                <ChevronDown className="size-5" />
              </IconButton>
              <IconButton label="Fermer la recherche" size="sm" onClick={() => setSearchOpen(false)}>
                <X className="size-5" />
              </IconButton>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                placeholder="Remplacer par…"
                aria-label="Remplacer par"
                className="h-10 min-w-0 flex-1 rounded-xl border border-line px-3 outline-none focus:border-brand-500"
              />
              <Button size="sm" icon={<Replace className="size-4" aria-hidden />} disabled={!matches.length} onClick={replaceCurrent}>
                Remplacer
              </Button>
              <Button size="sm" disabled={!matches.length} onClick={replaceEverywhere}>
                Tout remplacer
              </Button>
            </div>
          </div>
        )}
      </header>

      {pages.length === 0 ? (
        <div className="mx-auto max-w-xl p-8 text-center text-muted">
          <p>Ce document n'a pas encore de page.</p>
          <Button variant="primary" className="mt-4" onClick={() => navigate(paths.doc(docId))}>
            Ajouter des pages
          </Button>
        </div>
      ) : mode === "continuous" ? (
        <main className="mx-auto max-w-3xl px-2 py-4 sm:px-5">
          <div className="mb-2 flex justify-end">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} className="size-4 accent-brand-700" />
              Afficher les repères de page
            </label>
          </div>
          <article className="rounded-2xl bg-white px-1 py-3 shadow-sm ring-1 ring-line sm:px-4 sm:py-6">
            {pages.map((p, i) => (
              <div key={p.id}>
                {showMarkers ? (
                  <div className={cn("px-3", i > 0 && "mt-4 border-t border-dashed border-line pt-4")}>
                    <PageStatusLine page={p} index={i} />
                  </div>
                ) : (
                  i > 0 && <div className="h-2" aria-hidden />
                )}
                <PageTextBlock ref={register(p.id)} page={p} index={i} header={false} minimal={!showMarkers} className="mt-1" />
              </div>
            ))}
          </article>
        </main>
      ) : (
        current && (
          <main className="mx-auto max-w-6xl px-3 py-4 sm:px-5">
            <div className="mb-3 sm:hidden">
              <Segmented
                label="Afficher"
                value={mobileView}
                onChange={setMobileView}
                className="w-full"
                options={[
                  { value: "text", label: "Texte" },
                  { value: "image", label: "Image", icon: <ImageIcon className="size-4" aria-hidden /> },
                ]}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className={cn("min-w-0 sm:sticky sm:top-24 sm:self-start", mobileView !== "image" && "max-sm:hidden")}>
                <PageImage page={current} className="max-h-[75dvh]" />
              </div>
              <div className={cn("min-w-0 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-line", mobileView !== "text" && "max-sm:hidden")}>
                <PageTextBlock ref={register(current.id)} page={current} index={safeIndex} />
              </div>
            </div>
            <div className="mt-4 hidden items-center justify-center gap-3 sm:flex">
              <Button icon={<ChevronLeft className="size-5" aria-hidden />} disabled={safeIndex === 0} onClick={() => setPageIndex(safeIndex - 1)}>
                Page précédente
              </Button>
              <span className="text-sm text-muted">
                {safeIndex + 1} / {pages.length}
              </span>
              <Button disabled={safeIndex === pages.length - 1} onClick={() => setPageIndex(safeIndex + 1)}>
                Page suivante <ChevronRight className="size-5" aria-hidden />
              </Button>
            </div>
          </main>
        )
      )}

      {/* barre d'actions mobile */}
      <div className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 lg:hidden">
        {mode === "page" && pages.length > 0 && (
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 sm:hidden">
            <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-5" aria-hidden />} disabled={safeIndex === 0} onClick={() => setPageIndex(safeIndex - 1)}>
              Précédente
            </Button>
            <span className="text-sm font-medium">
              Page {safeIndex + 1} / {pages.length}
            </span>
            <Button size="sm" variant="ghost" disabled={safeIndex === pages.length - 1} onClick={() => setPageIndex(safeIndex + 1)}>
              Suivante <ChevronRight className="size-5" aria-hidden />
            </Button>
          </div>
        )}
        <div className="flex gap-2 px-3 py-2.5">{actions}</div>
      </div>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} doc={doc} pages={pages} />
    </div>
  );
}
