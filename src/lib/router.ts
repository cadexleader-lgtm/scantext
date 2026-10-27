import { useSyncExternalStore } from "react";

/**
 * Routage par ancre (#/...) : fonctionne sur n'importe quel hébergement
 * statique sans configuration serveur, y compris dans un sous-dossier.
 */
export type Route =
  | { name: "home" }
  | { name: "documents" }
  | { name: "settings" }
  | { name: "doc"; docId: string }
  | { name: "editor"; docId: string; pageId?: string }
  | { name: "scan"; docId: string | null; at?: number; replace?: string }
  | { name: "page"; docId: string; pageId: string }
  | { name: "notFound" };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [path, query = ""] = raw.split("?");
  const q = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "documents" && parts.length === 1) return { name: "documents" };
  if (parts[0] === "settings" && parts.length === 1) return { name: "settings" };
  if (parts[0] === "scan" && parts.length === 1) return { name: "scan", docId: null };
  if (parts[0] === "doc" && parts[1]) {
    const docId = parts[1];
    if (parts.length === 2) return { name: "doc", docId };
    if (parts[2] === "text") return { name: "editor", docId, pageId: q.get("page") ?? undefined };
    if (parts[2] === "scan") {
      const at = q.get("at");
      return { name: "scan", docId, at: at !== null ? Number(at) : undefined, replace: q.get("replace") ?? undefined };
    }
    if (parts[2] === "page" && parts[3]) return { name: "page", docId, pageId: parts[3] };
  }
  return { name: "notFound" };
}

export const paths = {
  home: () => "/",
  documents: () => "/documents",
  settings: () => "/settings",
  newScan: () => "/scan",
  doc: (id: string) => `/doc/${encodeURIComponent(id)}`,
  editor: (id: string, pageId?: string) => `/doc/${encodeURIComponent(id)}/text${pageId ? `?page=${encodeURIComponent(pageId)}` : ""}`,
  scan: (id: string, opts: { at?: number; replace?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.at !== undefined) q.set("at", String(opts.at));
    if (opts.replace) q.set("replace", opts.replace);
    const s = q.toString();
    return `/doc/${encodeURIComponent(id)}/scan${s ? `?${s}` : ""}`;
  },
  page: (id: string, pageId: string) => `/doc/${encodeURIComponent(id)}/page/${encodeURIComponent(pageId)}`,
};

const listeners = new Set<() => void>();
let current = typeof location !== "undefined" ? location.hash : "";
const emit = () => {
  current = location.hash;
  listeners.forEach((l) => l());
};
if (typeof window !== "undefined") {
  window.addEventListener("popstate", emit);
  window.addEventListener("hashchange", emit);
}

/** Position dans l'historique propre à l'application (0 = première page ouverte). */
const depth = (): number => (history.state as { idx?: number } | null)?.idx ?? 0;

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const hash = `#${path}`;
  if (opts.replace) history.replaceState({ idx: depth() }, "", hash);
  else if (location.hash !== hash) history.pushState({ idx: depth() + 1 }, "", hash);
  emit();
}

/** Retour : revient à l'écran précédent de l'application, sinon va à `fallback`. */
export function goBack(fallback: string): void {
  if (depth() > 0) history.back();
  else navigate(fallback, { replace: true });
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
  return parseRoute(hash);
}
