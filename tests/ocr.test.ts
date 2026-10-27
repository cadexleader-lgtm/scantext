import { describe, expect, it } from "vitest";
import { applyOcrResult, resolvePending } from "../src/lib/ocr/apply";
import { buildLayout, layoutToText, type TessBlock } from "../src/lib/ocr/layout";
import type { OcrOutcome } from "../src/lib/ocr/engine";
import { makePageRecord } from "../src/lib/store";
import type { PageRecord } from "../src/lib/types";

function page(patch: Partial<PageRecord> = {}): PageRecord {
  return {
    ...makePageRecord("doc", { source: "image", orig: { blob: new Blob(), w: 100, h: 140 }, params: { quad: null, rotation: 0, filter: "enhanced", sharpen: false } }),
    imageStatus: "ready",
    imageRev: 1,
    ...patch,
  };
}
const outcome = (text: string, extra: Partial<OcrOutcome> = {}): OcrOutcome => ({
  text,
  confidence: 92,
  layout: { w: 100, h: 140, paragraphs: [] },
  blank: false,
  uncertain: false,
  ...extra,
});

describe("règles d'application de l'OCR", () => {
  it("page non corrigée : le texte reconnu est appliqué", () => {
    const r = applyOcrResult(page(), outcome("Bonjour"), "fra");
    expect(r).toMatchObject({ text: "Bonjour", ocrText: "Bonjour", edited: false, ocrStatus: "done", pendingText: null });
  });
  it("résultat incertain → « À vérifier »", () => {
    expect(applyOcrResult(page(), outcome("B0nj0ur", { uncertain: true }), "fra").ocrStatus).toBe("review");
  });
  it("page corrigée à la main : la correction n'est jamais remplacée", () => {
    const p = page({ ocrText: "Bonjuor", text: "Bonjour (corrigé)", edited: true });
    const r = applyOcrResult(p, outcome("Bonjour"), "fra");
    expect(r.text).toBeUndefined();
    expect(r).toMatchObject({ pendingText: "Bonjour", ocrStatus: "review", edited: true });
  });
  it("décisions : remplacer / garder ma version", () => {
    const p = page({ ocrText: "Bonjour", text: "Mon texte", edited: true, pendingText: "Bonjour", ocrStatus: "review" });
    expect(resolvePending(p, "replace")).toMatchObject({ text: "Bonjour", edited: false, pendingText: null, ocrStatus: "done" });
    expect(resolvePending(p, "keep")).toMatchObject({ pendingText: null, edited: true, ocrStatus: "done" });
  });
  it("texte extrait d'un PDF : utilisé tel quel, sans OCR", () => {
    const p = makePageRecord("doc", {
      source: "pdf",
      orig: { blob: new Blob(), w: 10, h: 10 },
      params: { quad: null, rotation: 0, filter: "color", sharpen: false },
      pdfText: "  Texte exact  ",
      usePdfText: true,
    });
    expect(p).toMatchObject({ text: "Texte exact", textSource: "pdf", ocrStatus: "done", edited: false });
  });
});

const word = (t: string, x0: number, y0: number, x1: number, y1: number, c = 95) => ({ text: t, confidence: c, bbox: { x0, y0, x1, y1 } });
const line = (y: number, h: number, x0: number, words: string[]) => {
  let x = x0;
  const ws = words.map((w) => {
    const r = word(w, x, y, x + w.length * h * 0.5, y + h);
    x = r.bbox.x1 + h * 0.3;
    return r;
  });
  return { text: words.join(" ") + "\n", confidence: 95, bbox: { x0, y0: y, x1: x, y1: y + h }, words: ws };
};

describe("reconstruction des paragraphes", () => {
  it("sépare titre, paragraphes (interligne) et retrait", () => {
    const block: TessBlock = {
      bbox: { x0: 0, y0: 0, x1: 1000, y1: 1000 },
      paragraphs: [
        {
          bbox: { x0: 0, y0: 0, x1: 1000, y1: 1000 },
          lines: [
            line(10, 40, 100, ["Rapport", "annuel"]), // titre (plus grand)
            line(80, 20, 100, ["Première", "ligne", "du", "paragraphe"]),
            line(104, 20, 100, ["suite", "du", "paragraphe."]),
            line(160, 20, 100, ["Deuxième", "paragraphe."]), // grand interligne
            line(184, 20, 160, ["Retrait", "de", "première", "ligne."]), // retrait
          ],
        },
      ],
    };
    const layout = buildLayout([block], 1000, 1000);
    expect(layoutToText(layout)).toBe(
      "Rapport annuel\n\nPremière ligne du paragraphe\nsuite du paragraphe.\n\nDeuxième paragraphe.\n\nRetrait de première ligne.",
    );
  });
  it("page sans mots → mise en page vide", () => {
    expect(buildLayout([], 10, 10).paragraphs).toEqual([]);
  });
});
