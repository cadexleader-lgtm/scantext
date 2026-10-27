import { useSyncExternalStore } from "react";
import type { FilterId, OcrLang } from "./types";

export type ImageQuality = "eco" | "standard" | "high";

export interface Settings {
  lang: OcrLang;
  /** Pendant le scan : valider la page sans écran de vérification. */
  quickCapture: boolean;
  imageQuality: ImageQuality;
  defaultFilter: FilterId;
  /** Options de « Copier tout » et des exports. */
  copySeparators: boolean;
  copyReflow: boolean;
  ocrPaused: boolean;
  storageNoticeDismissed: boolean;
  /** Version des réglages enregistrés (migrations). */
  version: number;
}

const SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS: Settings = {
  // français + anglais : les documents mêlent souvent les deux (noms, termes techniques)
  lang: "fra+eng",
  quickCapture: false,
  imageQuality: "standard",
  defaultFilter: "enhanced",
  copySeparators: false,
  copyReflow: false,
  ocrPaused: false,
  storageNoticeDismissed: false,
  version: SETTINGS_VERSION,
};

/** Plus grand côté conservé pour les images, en pixels. */
export const QUALITY_MAX_SIDE: Record<ImageQuality, number> = { eco: 1800, standard: 2400, high: 3200 };

const KEY = "scantext.settings";
let current: Settings = load();
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Settings>;
      // v2 : « français + anglais » par défaut (plus juste, mesuré sur des pages réelles)
      if ((stored.version ?? 1) < 2 && stored.lang === "fra") stored.lang = "fra+eng";
      return { ...DEFAULT_SETTINGS, ...stored, version: SETTINGS_VERSION };
    }
  } catch {
    // stockage indisponible (navigation privée…) : réglages par défaut
  }
  return { ...DEFAULT_SETTINGS };
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // les réglages restent valables pour la session
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}
