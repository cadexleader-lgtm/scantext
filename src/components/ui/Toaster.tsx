import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { dismissToast, useToasts } from "../../lib/toast";
import { useRoute } from "../../lib/router";
import { cn } from "./cn";

/** Messages de confirmation / d'erreur, annoncés aux lecteurs d'écran. */
export function Toaster() {
  const toasts = useToasts();
  // pendant le scan, les commandes sont en bas : messages en haut
  const top = useRoute().name === "scan";
  return (
    <div
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4",
        top ? "top-[calc(5rem+env(safe-area-inset-top))]" : "bottom-[calc(5.5rem+env(safe-area-inset-bottom))] lg:bottom-6",
      )}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-2xl px-4 py-3 text-[15px] shadow-lg ring-1",
            t.kind === "error" ? "bg-red-50 text-red-900 ring-red-200" : "bg-slate-900 text-white ring-slate-900",
          )}
        >
          {t.kind === "success" ? (
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-400" aria-hidden />
          ) : t.kind === "error" ? (
            <XCircle className="mt-0.5 size-5 shrink-0 text-red-600" aria-hidden />
          ) : (
            <Info className="mt-0.5 size-5 shrink-0 text-brand-200" aria-hidden />
          )}
          <p className="min-w-0 flex-1">{t.message}</p>
          {t.action && (
            <button
              type="button"
              className="shrink-0 font-semibold underline underline-offset-2"
              onClick={() => {
                t.action!.onClick();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" aria-label="Fermer le message" onClick={() => dismissToast(t.id)} className="-mr-1 shrink-0 opacity-70 hover:opacity-100">
            <X className="size-5" />
          </button>
        </div>
      ))}
    </div>
  );
}
