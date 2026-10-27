import type { PageRecord } from "./types";

export interface DocStats {
  total: number;
  done: number;
  pending: number;
  processing: number;
  review: number;
  error: number;
  /** Pages dont la reconnaissance est terminée (y compris « à vérifier »). */
  treated: number;
}

export function docStats(pages: PageRecord[]): DocStats {
  const s: DocStats = { total: pages.length, done: 0, pending: 0, processing: 0, review: 0, error: 0, treated: 0 };
  for (const p of pages) {
    const status = p.imageStatus === "error" ? "error" : p.ocrStatus;
    s[status]++;
  }
  s.treated = s.done + s.review;
  return s;
}

export type DocSummaryKind = "empty" | "working" | "done" | "review" | "error" | "paused";

export function docSummary(s: DocStats, paused: boolean): { kind: DocSummaryKind; label: string } {
  if (!s.total) return { kind: "empty", label: "Aucune page" };
  if (s.pending + s.processing > 0)
    return paused
      ? { kind: "paused", label: `En pause · ${s.treated}/${s.total} traitées` }
      : { kind: "working", label: `Reconnaissance ${s.treated}/${s.total}` };
  if (s.error) return { kind: "error", label: `${s.error} page${s.error > 1 ? "s" : ""} en erreur` };
  if (s.review) return { kind: "review", label: `${s.review} à vérifier` };
  return { kind: "done", label: "Terminé" };
}

export const STATUS_LABEL: Record<PageRecord["ocrStatus"], string> = {
  pending: "En attente",
  processing: "En cours",
  done: "Terminé",
  error: "Erreur",
  review: "À vérifier",
};

export function pagesLabel(n: number): string {
  return `${n} page${n > 1 ? "s" : ""}`;
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `Aujourd'hui, ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
