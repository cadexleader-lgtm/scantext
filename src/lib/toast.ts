import { useSyncExternalStore } from "react";

export type ToastKind = "success" | "error" | "info";
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; onClick: () => void };
  duration: number;
}

let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(
  message: string,
  opts: { kind?: ToastKind; action?: Toast["action"]; duration?: number } = {},
): number {
  const t: Toast = {
    id: ++seq,
    kind: opts.kind ?? "info",
    message,
    action: opts.action,
    duration: opts.duration ?? (opts.kind === "error" ? 7000 : 3500),
  };
  // au plus 3 messages visibles
  toasts = [...toasts.slice(-2), t];
  emit();
  if (t.duration > 0) setTimeout(() => dismissToast(t.id), t.duration);
  return t.id;
}
toast.success = (m: string, o: Omit<Parameters<typeof toast>[1], "kind"> = {}) => toast(m, { ...o, kind: "success" });
toast.error = (m: string, o: Omit<Parameters<typeof toast>[1], "kind"> = {}) => toast(m, { ...o, kind: "error" });

export function dismissToast(id: number): void {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => toasts;
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Message d'erreur lisible pour l'utilisateur. */
export function errorMessage(err: unknown, fallback = "Une erreur inattendue s'est produite."): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return fallback;
}
