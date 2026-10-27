import type { OcrLang, PageRecord } from "../types";
import type { OcrOutcome } from "./engine";

/**
 * Applique un résultat de reconnaissance à une page.
 * Règle : un texte corrigé à la main n'est JAMAIS remplacé silencieusement —
 * le nouveau résultat est proposé (pendingText) et la page passe « À vérifier ».
 */
export function applyOcrResult(page: PageRecord, out: OcrOutcome, lang: OcrLang): Partial<PageRecord> {
  const base: Partial<PageRecord> = {
    ocrText: out.text,
    ocrConfidence: out.confidence,
    layout: out.layout,
    blank: out.blank,
    ocrLang: lang,
    ocrRev: page.imageRev,
    textSource: "ocr",
    ocrError: null,
  };
  if (page.edited && page.text !== out.text) {
    return { ...base, pendingText: out.text, ocrStatus: "review", edited: true };
  }
  return { ...base, text: out.text, edited: false, pendingText: null, ocrStatus: out.uncertain ? "review" : "done" };
}

/** Décision de l'utilisateur face à une nouvelle reconnaissance d'une page corrigée. */
export function resolvePending(page: PageRecord, choice: "replace" | "keep"): Partial<PageRecord> {
  if (choice === "replace") {
    const text = page.pendingText ?? page.ocrText ?? "";
    return { text, ocrText: text, edited: false, pendingText: null, ocrStatus: "done" };
  }
  return { pendingText: null, edited: page.text !== (page.ocrText ?? ""), ocrStatus: "done" };
}
