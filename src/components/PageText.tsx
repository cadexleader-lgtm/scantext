import { forwardRef, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCheck, Loader2, RefreshCw, SpellCheck2 } from "lucide-react";
import { markVerified, rerunOcr, resolveOcrConflict, useProcessing } from "../lib/ocr/queue";
import { useSettings } from "../lib/settings";
import { setPageText } from "../lib/store";
import type { PageRecord } from "../lib/types";
import { StatusBadge } from "./common";
import { ReviewDialog, reviewItems } from "./ReviewDialog";
import { PageTables } from "./TableGrid";
import { Button } from "./ui";
import { cn } from "./ui/cn";

const supportsFieldSizing = typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");

/** Zone de texte qui s'agrandit avec son contenu (pas de double barre de défilement). */
export const AutoTextarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function AutoTextarea(props, ref) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || supportsFieldSizing) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  });
  return (
    <textarea
      {...props}
      ref={(el) => {
        inner.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
    />
  );
});

/** Bandeau : nouvelle reconnaissance disponible pour une page corrigée à la main. */
export function ConflictBanner({ page }: { page: PageRecord }) {
  const [show, setShow] = useState(false);
  if (page.pendingText === null) return null;
  return (
    <div className="mb-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
      <p className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>Une nouvelle reconnaissance est disponible. Vos corrections n'ont pas été modifiées.</span>
      </p>
      {show && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-2 font-serif text-[15px] text-ink">{page.pendingText || "(aucun texte détecté)"}</pre>}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => setShow((s) => !s)}>
          {show ? "Masquer" : "Voir la nouvelle version"}
        </Button>
        <Button size="sm" onClick={() => void resolveOcrConflict(page.id, "keep")}>
          Garder ma version
        </Button>
        <Button size="sm" variant="primary" onClick={() => void resolveOcrConflict(page.id, "replace")}>
          Remplacer
        </Button>
      </div>
    </div>
  );
}

export function PageStatusLine({ page, index }: { page: PageRecord; index: number }) {
  const proc = useProcessing();
  const busy = page.ocrStatus === "processing" && proc.ocrPageId === page.id;
  const [reviewing, setReviewing] = useState(false);
  const toReview = useMemo(
    () => (page.textSource === "ocr" && page.layout && page.imageStatus === "ready" ? reviewItems(page).length : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dépend seulement du texte et des mots reconnus
    [page.text, page.layout, page.textSource, page.imageStatus],
  );
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-semibold text-ink">Page {index + 1}</span>
      <StatusBadge page={page} />
      {busy && <span className="text-muted">{Math.round(proc.ocrProgress * 100)} %</span>}
      {page.ocrConfidence !== null && page.textSource === "ocr" && !page.blank && page.ocrStatus !== "processing" && (
        <span className="text-muted" title="Confiance moyenne de la reconnaissance">
          Confiance {page.ocrConfidence} %
        </span>
      )}
      {page.edited && <span className="text-muted">· corrigée</span>}
      <span className="ml-auto flex gap-1">
        {toReview > 0 && page.ocrStatus !== "processing" && (
          <Button
            size="sm"
            variant="subtle"
            icon={<SpellCheck2 className="size-4" aria-hidden />}
            onClick={() => setReviewing(true)}
            title="Comparer les mots douteux avec la photo, un par un"
          >
            Relire ({toReview})
          </Button>
        )}
        <ReviewDialog page={page} open={reviewing} onClose={() => setReviewing(false)} />
        {page.ocrStatus === "review" && page.pendingText === null && (
          <Button size="sm" variant="ghost" icon={<CheckCheck className="size-4" aria-hidden />} onClick={() => void markVerified(page.id)}>
            Vérifié
          </Button>
        )}
        {page.ocrStatus !== "processing" && page.ocrStatus !== "pending" && (
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void rerunOcr(page.id)}>
            Relancer
          </Button>
        )}
      </span>
    </div>
  );
}

/** Texte modifiable d'une page, avec ses états (attente, erreur, conflit). */
export const PageTextBlock = forwardRef<HTMLTextAreaElement, { page: PageRecord; index: number; header?: boolean; className?: string; minimal?: boolean }>(
  function PageTextBlock({ page, index, header = true, className, minimal }, ref) {
    const { ocrPaused } = useSettings();
    const waiting = (page.ocrStatus === "pending" || page.ocrStatus === "processing") && !page.text;
    const failed = page.ocrStatus === "error" || page.imageStatus === "error";
    return (
      <section className={cn("min-w-0", className)} aria-label={`Texte de la page ${index + 1}`}>
        {header && (
          <div className="mb-2">
            <PageStatusLine page={page} index={index} />
          </div>
        )}
        <ConflictBanner page={page} />
        {failed && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-900" role="alert">
            <span className="min-w-0 flex-1">{page.imageError || page.ocrError || "La reconnaissance de cette page a échoué."}</span>
            <Button size="sm" icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void rerunOcr(page.id)}>
              Relancer cette page
            </Button>
          </div>
        )}
        {page.ocrStatus === "review" && page.pendingText === null && !minimal && (
          <p className="mb-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            Résultat incertain (image floue, petits caractères ou écriture manuscrite ?) : relisez cette page, en particulier les chiffres.
          </p>
        )}
        {page.blank && !page.text && page.ocrStatus === "done" ? (
          <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">Aucun texte détecté sur cette page (page blanche ou illisible). Vous pouvez saisir le texte vous-même :</p>
        ) : null}
        {waiting ? (
          <div className="flex items-center gap-2 rounded-xl border border-dashed border-line p-4 text-sm text-muted">
            {page.ocrStatus === "processing" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {ocrPaused ? "Reconnaissance en pause." : page.ocrStatus === "processing" ? "Reconnaissance du texte en cours…" : "En attente de reconnaissance…"}
          </div>
        ) : (
          <AutoTextarea
            ref={ref}
            value={page.text}
            onChange={(e) => setPageText(page.id, e.target.value)}
            spellCheck
            lang="fr"
            aria-label={`Texte de la page ${index + 1}`}
            placeholder="Saisissez ou collez le texte de cette page…"
            className={cn(
              "editor-area block min-h-24 w-full resize-none rounded-xl border border-transparent bg-white px-3 py-2 text-[17px] text-ink outline-none transition-colors",
              "hover:border-line focus:border-brand-300 focus:ring-2 focus:ring-brand-100",
            )}
          />
        )}
        {!waiting && <PageTables page={page} />}
      </section>
    );
  },
);
