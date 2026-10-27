import { ocrAssetsBase } from "./ocr/engine";
import type { OcrLang } from "./types";

/**
 * Disponibilité hors ligne du moteur OCR. L'interface est mise en cache à
 * l'installation ; les fichiers OCR (≈ 4 Mo pour le moteur + 0,7 à 3 Mo par
 * langue) le sont au premier usage ou via « Préparer l'utilisation hors ligne ».
 */

async function coreFileName(): Promise<string> {
  const { relaxedSimd, simd } = await import("wasm-feature-detect");
  if (await relaxedSimd()) return "tesseract-core-relaxedsimd-lstm.wasm.js";
  if (await simd()) return "tesseract-core-simd-lstm.wasm.js";
  return "tesseract-core-lstm.wasm.js";
}

async function ocrUrls(langs: string[]): Promise<string[]> {
  const base = ocrAssetsBase();
  return [`${base}worker.min.js`, `${base}core/${await coreFileName()}`, ...langs.map((l) => `${base}lang/${l}.traineddata.gz`)];
}

export const langsOf = (lang: OcrLang): string[] => lang.split("+");

export interface OfflineStatus {
  /** Service worker actif : l'interface s'ouvre sans connexion. */
  appShell: boolean;
  /** Fichiers OCR présents dans le cache pour les langues demandées. */
  ocr: boolean;
}

export async function getOfflineStatus(langs: string[]): Promise<OfflineStatus> {
  const appShell = !!navigator.serviceWorker?.controller;
  if (!("caches" in window)) return { appShell, ocr: false };
  try {
    const cache = await caches.open(__OCR_CACHE__);
    const urls = await ocrUrls(langs);
    const hits = await Promise.all(urls.map((u) => cache.match(u)));
    return { appShell, ocr: appShell && hits.every(Boolean) };
  } catch {
    return { appShell, ocr: false };
  }
}

export async function prepareOffline(langs: string[]): Promise<void> {
  if (!("caches" in window)) throw new Error("Ce navigateur ne permet pas l'utilisation hors ligne.");
  if (!navigator.onLine) throw new Error("Connectez-vous à internet pour télécharger les fichiers de reconnaissance.");
  const cache = await caches.open(__OCR_CACHE__);
  const urls = await ocrUrls(langs);
  for (const u of urls) {
    if (await cache.match(u)) continue;
    const res = await fetch(u, { cache: "no-store" });
    if (!res.ok) throw new Error(`Téléchargement impossible (${res.status}).`);
    await cache.put(u, res);
  }
}

/** Supprime les caches OCR d'anciennes versions du moteur. */
export async function cleanupOldOcrCaches(): Promise<void> {
  if (!("caches" in window)) return;
  try {
    for (const name of await caches.keys()) if (name.startsWith("scantext-ocr-") && name !== __OCR_CACHE__) await caches.delete(name);
  } catch {
    // sans importance
  }
}
