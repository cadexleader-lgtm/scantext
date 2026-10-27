import { useSyncExternalStore } from "react";
import { toast } from "./toast";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function initPwa(): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    emit();
  });
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    void import("virtual:pwa-register").then(({ registerSW }) => {
      const update = registerSW({
        onNeedRefresh() {
          toast("Une nouvelle version est disponible.", {
            duration: 0,
            action: { label: "Mettre à jour", onClick: () => void update(true) },
          });
        },
        onOfflineReady() {
          toast.success("L'application est prête à fonctionner hors ligne.");
        },
      });
    });
  }
}

export const isStandalone = (): boolean =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const isIos = (): boolean => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function useInstallState(): { canPrompt: boolean; installed: boolean } {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (deferred ? (installed ? INSTALLED_PROMPT : PROMPT) : installed || isStandalone() ? INSTALLED : NONE),
    () => NONE,
  );
}
const PROMPT = { canPrompt: true, installed: false };
const INSTALLED_PROMPT = { canPrompt: false, installed: true };
const INSTALLED = { canPrompt: false, installed: true };
const NONE = { canPrompt: false, installed: false };

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  emit();
  await e.prompt();
  const choice = await e.userChoice;
  return choice.outcome === "accepted";
}
