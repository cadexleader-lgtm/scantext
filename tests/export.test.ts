import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildDocx, buildSearchablePdf, buildTextPdf, buildTxt, type ExportOptions, type ExportPage } from "../src/lib/export/builders";
import type { OcrLayout } from "../src/lib/types";

// PNG 1×1 blanc valide
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

const layout: OcrLayout = {
  w: 1000,
  h: 1400,
  paragraphs: [
    { b: [300, 100, 700, 160], lines: [{ b: [300, 100, 700, 160], words: [{ t: "Titre", c: 95, b: [300, 100, 700, 160] }] }] },
    {
      b: [100, 220, 900, 260],
      lines: [{ b: [100, 220, 900, 260], words: [{ t: "Bonjour", c: 95, b: [100, 220, 400, 260] }, { t: "monde", c: 90, b: [430, 220, 700, 260] }] }],
    },
  ],
};
const pages: ExportPage[] = [
  { text: "Titre\n\nBonjour monde", edited: false, layout, imageW: 1000, imageH: 1400, getImage: async () => new Blob([PNG], { type: "image/png" }) },
  { text: "Deuxième page : 12 450,75 € — « citation » ; œuvre", edited: true, layout: null, imageW: 1000, imageH: 1400, getImage: async () => new Blob([PNG], { type: "image/png" }) },
];
const opts = (o: Partial<ExportOptions> = {}): ExportOptions => ({ title: "Doc", separators: true, reflow: false, docxMode: "simple", includeImages: false, ...o });

async function pdfTexts(blob: Blob): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join(" "));
  return out;
}

describe("exports", () => {
  it("TXT : UTF-8 avec BOM, fins de ligne Windows, repères", async () => {
    const bytes = new Uint8Array(await buildTxt(pages, opts()).arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8
    const t = new TextDecoder().decode(bytes); // le décodeur retire le BOM
    expect(t.startsWith("——— Page 1 ———\r\n\r\nTitre")).toBe(true);
    expect(t).toContain("12 450,75 €");
  });

  it("DOCX simple et mise en page approchée : XML valide avec texte et sauts de page", async () => {
    for (const docxMode of ["simple", "layout"] as const) {
      const blob = await buildDocx(pages, opts({ docxMode, includeImages: true }));
      const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
      const xml = strFromU8(files["word/document.xml"]);
      expect(xml).toContain("Bonjour");
      expect(xml).toContain("œuvre");
      expect(xml).toContain("w:pageBreakBefore");
      expect(Object.keys(files).some((f) => f.startsWith("word/media/"))).toBe(true);
      if (docxMode === "layout") expect(xml).toMatch(/w:jc w:val="center"/); // titre centré détecté
    }
  });

  it("PDF texte : texte extractible, accents et symboles conservés", async () => {
    const texts = await pdfTexts(await buildTextPdf(pages, opts()));
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("12 450,75 €");
    expect(texts[1]).toContain("œuvre");
  });

  it("PDF recherchable : une page par image, couche texte invisible extractible", async () => {
    const texts = await pdfTexts(await buildSearchablePdf(pages, opts()));
    expect(texts).toHaveLength(2);
    expect(texts[0].replace(/\s+/g, " ")).toContain("Bonjour monde");
    expect(texts[1]).toContain("Deuxième page"); // page corrigée : texte corrigé
  });
});
