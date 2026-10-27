import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Dialog } from "./index";

/**
 * Confirmations et saisies impératives : `await confirmAction(...)`,
 * `await promptText(...)`. Un seul hôte (<DialogHost/>) est monté dans l'application.
 */
type Request =
  | { kind: "confirm"; title: string; message?: string; confirmLabel: string; danger: boolean; resolve: (v: boolean) => void }
  | { kind: "prompt"; title: string; label: string; initial: string; confirmLabel: string; resolve: (v: string | null) => void };

let current: Request | null = null;
const listeners = new Set<() => void>();
const set = (r: Request | null) => {
  current = r;
  listeners.forEach((l) => l());
};

/** Une nouvelle demande annule la précédente (réponse négative). */
function cancelCurrent() {
  if (current?.kind === "confirm") current.resolve(false);
  else if (current?.kind === "prompt") current.resolve(null);
}

export function confirmAction(opts: { title: string; message?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    cancelCurrent();
    set({ kind: "confirm", title: opts.title, message: opts.message, confirmLabel: opts.confirmLabel ?? "Confirmer", danger: !!opts.danger, resolve });
  });
}

export function promptText(opts: { title: string; label: string; initial?: string; confirmLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    cancelCurrent();
    set({ kind: "prompt", title: opts.title, label: opts.label, initial: opts.initial ?? "", confirmLabel: opts.confirmLabel ?? "Valider", resolve });
  });
}

export function DialogHost() {
  const req = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
  const [value, setValue] = useState("");
  useEffect(() => {
    if (req?.kind === "prompt") setValue(req.initial);
  }, [req]);
  if (!req) return null;
  const close = (result: boolean) => {
    set(null);
    if (req.kind === "confirm") req.resolve(result);
    else req.resolve(result && value.trim() ? value.trim() : null);
  };
  return (
    <Dialog
      open
      onClose={() => close(false)}
      title={req.title}
      description={req.kind === "confirm" ? req.message : undefined}
      footer={
        <>
          <Button onClick={() => close(false)}>Annuler</Button>
          <Button
            variant={req.kind === "confirm" && req.danger ? "danger" : "primary"}
            onClick={() => close(true)}
            disabled={req.kind === "prompt" && !value.trim()}
            form={req.kind === "prompt" ? "prompt-form" : undefined}
          >
            {req.confirmLabel}
          </Button>
        </>
      }
    >
      {req.kind === "prompt" && (
        <form
          id="prompt-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) close(true);
          }}
        >
          <label className="mb-1.5 block text-sm font-medium" htmlFor="prompt-input">
            {req.label}
          </label>
          <input
            id="prompt-input"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={150}
            className="h-12 w-full rounded-xl border border-line px-3 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
          />
        </form>
      )}
    </Dialog>
  );
}
