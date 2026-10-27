import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, FileText, Loader2, XCircle } from "lucide-react";
import { getBlob, type BlobKind } from "../lib/db";
import { STATUS_LABEL } from "../lib/doc-stats";
import type { PageRecord } from "../lib/types";
import { cn } from "./ui/cn";

/** URL d'objet pour une image stockée (révoquée automatiquement). */
export function useBlobUrl(pageId: string | undefined, kind: BlobKind, rev: number | string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!pageId) return;
    let cancelled = false;
    let created: string | null = null;
    void getBlob(pageId, kind).then((b) => {
      if (cancelled || !b) return;
      created = URL.createObjectURL(b);
      setUrl(created);
    });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [pageId, kind, rev]);
  return url;
}

export function pageStatus(p: PageRecord): PageRecord["ocrStatus"] {
  return p.imageStatus === "error" ? "error" : p.ocrStatus;
}

const styles: Record<PageRecord["ocrStatus"], string> = {
  pending: "bg-slate-100 text-slate-700",
  processing: "bg-brand-50 text-brand-800",
  done: "bg-emerald-50 text-emerald-800",
  review: "bg-amber-50 text-amber-900",
  error: "bg-red-50 text-red-800",
};

export function StatusBadge({ page, className }: { page: PageRecord; className?: string }) {
  const status = pageStatus(page);
  const Icon = { pending: Clock, processing: Loader2, done: CheckCircle2, review: AlertTriangle, error: XCircle }[status];
  const label = page.blank && status === "done" ? "Page vide" : page.textSource === "pdf" && status === "done" ? "Texte du PDF" : STATUS_LABEL[status];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", styles[status], className)}>
      <Icon className={cn("size-3.5", status === "processing" && "animate-spin")} aria-hidden />
      {label}
    </span>
  );
}

export function PageThumb({ page, className }: { page: PageRecord; className?: string }) {
  const thumb = useBlobUrl(page.id, page.imageStatus === "ready" ? "thumb" : "orig", `${page.imageStatus}-${page.imageRev}`);
  return (
    <div className={cn("relative overflow-hidden rounded-lg bg-slate-100 ring-1 ring-line", className)}>
      {thumb ? (
        <img src={thumb} alt="" className={cn("size-full object-contain", page.imageStatus !== "ready" && "opacity-60")} loading="lazy" draggable={false} />
      ) : (
        <div className="flex size-full items-center justify-center text-slate-400">
          <FileText className="size-6" aria-hidden />
        </div>
      )}
      {page.imageStatus === "pending" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-6 animate-spin text-brand-700" aria-label="Préparation de l'image" />
        </div>
      )}
    </div>
  );
}
