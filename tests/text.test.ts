import { describe, expect, it } from "vitest";
import { assembleText, countWords, findMatches, reflowText, replaceAll, safeFileName, stripExtension } from "../src/lib/text";

const pages = (...texts: string[]) => texts.map((text, i) => ({ id: `p${i}`, text }));

describe("assemblage du texte (Copier tout / exports)", () => {
  it("réunit les pages dans l'ordre, séparées par une ligne vide", () => {
    expect(assembleText(pages("Un", "Deux", "Trois"), { separators: false, reflow: false })).toBe("Un\n\nDeux\n\nTrois\n");
  });
  it("ignore les pages vides sans séparateurs, les garde avec", () => {
    expect(assembleText(pages("Un", "  ", "Trois"), { separators: false, reflow: false })).toBe("Un\n\nTrois\n");
    const withSep = assembleText(pages("Un", "", "Trois"), { separators: true, reflow: false });
    expect(withSep).toBe("——— Page 1 ———\n\nUn\n\n——— Page 2 ———\n\n——— Page 3 ———\n\nTrois\n");
  });
  it("conserve les paragraphes et les retours à la ligne", () => {
    const t = assembleText(pages("Ligne 1\nLigne 2\n\nParagraphe 2"), { separators: false, reflow: false });
    expect(t).toBe("Ligne 1\nLigne 2\n\nParagraphe 2\n");
  });
  it("document vide → chaîne vide", () => {
    expect(assembleText([], { separators: false, reflow: false })).toBe("");
  });
});

describe("recollage des lignes", () => {
  it("recolle les lignes d'un paragraphe et les mots coupés", () => {
    expect(reflowText("Une phrase qui conti-\nnue sur deux lignes\net trois.\n\nAutre paragraphe")).toBe(
      "Une phrase qui continue sur deux lignes et trois.\n\nAutre paragraphe",
    );
  });
  it("ne recolle pas un tiret suivi d'une majuscule (nom composé, sigle)", () => {
    expect(reflowText("Jean-\nPierre")).toBe("Jean- Pierre");
  });
  it("garde les éléments de liste sur leur ligne", () => {
    expect(reflowText("Courses :\n- pain\n- lait\n1. premier")).toBe("Courses :\n- pain\n- lait\n1. premier");
  });
  it("ne modifie jamais les chiffres, dates et montants", () => {
    const t = "Total 12 450,75 €\nle 14/03/2025 réf. DOC-2025/047";
    expect(reflowText(t)).toBe("Total 12 450,75 € le 14/03/2025 réf. DOC-2025/047");
  });
});

describe("recherche", () => {
  it("insensible aux accents et à la casse, positions exactes dans l'original", () => {
    const ps = pages("Un élève ÉLÈVE eleve", "rien", "L'élève");
    const m = findMatches(ps, "eleve");
    expect(m.map((x) => [x.pageIndex, ps[x.pageIndex].text.slice(x.start, x.end)])).toEqual([
      [0, "élève"],
      [0, "ÉLÈVE"],
      [0, "eleve"],
      [2, "élève"],
    ]);
  });
  it("remplace toutes les occurrences", () => {
    expect(replaceAll("Le chat et le Chat", "chat", "chien")).toEqual({ text: "Le chien et le chien", count: 2 });
    expect(replaceAll("rien", "x", "y")).toEqual({ text: "rien", count: 0 });
  });
  it("compte les mots (y compris élisions et mots composés)", () => {
    expect(countWords("L'élève a vingt-deux ans, 3 fois.")).toBe(6);
  });
});

describe("noms de fichiers", () => {
  it("supprime les caractères interdits et l'extension", () => {
    expect(safeFileName('Contrat: 2025/03 "final"?')).toBe("Contrat 2025 03 final");
    expect(safeFileName("   ")).toBe("document");
    expect(stripExtension("rapport.docx")).toBe("rapport");
  });
});
