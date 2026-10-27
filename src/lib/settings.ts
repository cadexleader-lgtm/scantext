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
}

export const DEFAULT_SETTINGS: Settings = {
  lang: "fra",
  quickCapture: false,
  imageQuality: "standard",
  defaultFilter: "enhanced",
  copySeparators: false,
  copyReflow: false,
  ocrPaused: false,
  storageNoticeDismissed: false,
};

/** Plus grand côté conservé pour les images, en pixels. */
export const QUALITY_MAX_SIDE: Record<ImageQuality, number> = { eco: 1800, standard: 2400, high: 3200 };

const KEY = "scantext.settings";
let current: Settings = load();
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
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
