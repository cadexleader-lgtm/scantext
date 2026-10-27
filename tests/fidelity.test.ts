import { describe, expect, it } from "vitest";
import { unzlibSync } from "fflate";
import { estimateStraighten, applyStraighten } from "../src/lib/image/straighten";
import { prepareOcrImage, resizeGray } from "../src/lib/image/ocr-prep";
import { encodeGrayPng } from "../src/lib/image/png";
import type { RGBAImage } from "../src/lib/image/ops";
import { buildLayout, layoutToText, type TessBlock } from "../src/lib/ocr/layout";
import { alignTokens, similarity, tokenize } from "../src/lib/ocr/align";
import { missedCharCount, mergeMissedWords } from "../src/lib/ocr/engine";
import { buildSearchablePdf, placeWords } from "../src/lib/export/builders";
import { parseBlocks, setTableCell, textToHtml } from "../src/lib/text-blocks";
import { reflowText } from "../src/lib/text";
import type { OcrLayout } from "../src/lib/types";

// ------------------------------------------------------------------ images synthétiques

function blank(w: number, h: number): RGBAImage {
  return { data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h };
}
function fillRect(img: RGBAImage, x0: number, y0: number, x1: number, y1: number, v = 20) {
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(img.height, Math.round(y1)); y++)
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(img.width, Math.round(x1)); x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    }
}
/** Page de « texte » : lignes de caractères (petits pavés), inclinées et courbées. */
function textPage(w: number, h: number, angleDeg: number, curve: number): RGBAImage {
  const img = blank(w, h);
  const t = Math.tan((angleDeg * Math.PI) / 180);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let row = 0; row < 26; row++) {
    const yBase = 80 + row * 34;
    for (let x = 60; x < w - 60; ) {
      const cw = 7 + Math.floor(rnd() * 5);
      const tall = rnd() < 0.25;
      const cx = x + cw / 2;
      const dy = t * (cx - w / 2) + curve * ((cx - w / 2) / (w / 2)) ** 2;
      fillRect(img, x, yBase + dy - (tall ? 18 : 12), x + cw, yBase + dy);
      x += cw + 3 + (rnd() < 0.18 ? 10 : 0);
    }
  }
  return img;
}

describe("redressement des lignes", () => {
  it("mesure l'inclinaison d'une page et la corrige", () => {
    const img = textPage(900, 1000, 1.5, 0);
    const m = estimateStraighten(img)!;
    expect(m).not.toBeNull();
    expect((m.angle * 180) / Math.PI).toBeCloseTo(1.5, 0);
    const after = estimateStraighten(applyStraighten(img, m));
    expect(after === null || Math.abs((after.angle * 180) / Math.PI) < 0.15).toBe(true);
  });
  it("aplatit des lignes courbées (page bombée)", () => {
    const img = textPage(900, 1000, 0, 9);
    const m = estimateStraighten(img)!;
    expect(m.field).not.toBeNull();
    const after = estimateStraighten(applyStraighten(img, m));
    const residual = after?.field ? Math.max(...Array.from(after.field).map(Math.abs)) * 1000 : 0;
    expect(residual).toBeLessThan(4);
  });
  it("page sans texte : aucune modification", () => {
    expect(estimateStraighten(blank(400, 500))).toBeNull();
  });
});

describe("préparation de l'image pour la reconnaissance", () => {
  it("repère les traits d'un tableau, les efface, garde le texte et agrandit l'image", () => {
    const img = textPage(900, 1000, 0, 0);
    // grille 3 × 3 au milieu de la page
    for (let k = 0; k <= 3; k++) {
      fillRect(img, 100, 300 + k * 60, 800, 303 + k * 60);
      fillRect(img, 100 + k * 233, 300, 103 + k * 233, 483);
    }
    const p = prepareOcrImage(img);
    expect(p.rulings.filter((r) => r.horizontal)).toHaveLength(4);
    expect(p.rulings.filter((r) => !r.horizontal)).toHaveLength(4);
    expect(p.scale).toBeGreaterThan(1);
    const at = (x: number, y: number) => p.gray[Math.round(y * p.scale) * p.w + Math.round(x * p.scale)];
    expect(at(450, 301.5)).toBeGreaterThan(200); // trait effacé
    expect(at(65, 74)).toBeLessThan(120); // caractère conservé
    expect(p.charBoxes.length).toBeGreaterThan(400);
  });
  it("efface un trait oblique (bord d'une autre feuille) sans toucher au texte", () => {
    const img = textPage(900, 1000, 0, 0);
    for (let t = 0; t < 1; t += 0.0005) {
      const x = 20 + t * 300;
      const y = 900 - t * 700;
      fillRect(img, x, y, x + 2.5, y + 2.5);
    }
    const p = prepareOcrImage(img);
    const at = (x: number, y: number) => p.gray[Math.round(y * p.scale) * p.w + Math.round(x * p.scale)];
    expect(at(21, 901)).toBeGreaterThan(200);
    expect(p.erased).toBeGreaterThan(500);
  });
  it("agrandissement bicubique : uniforme reste uniforme, taille exacte", () => {
    const g = new Uint8ClampedArray(20 * 10).fill(128);
    const r = resizeGray(g, 20, 10, 37, 19);
    expect(r.length).toBe(37 * 19);
    expect(Math.max(...r)).toBe(128);
    expect(Math.min(...r)).toBe(128);
  });
  it("PNG en niveaux de gris valide", () => {
    const g = Uint8ClampedArray.from({ length: 12 }, (_, i) => i * 20);
    const png = encodeGrayPng(g, 4, 3);
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    const idat = png.indexOf(0x49, 33); // « I » de IDAT
    const len = new DataView(png.buffer).getUint32(idat - 4);
    const raw = unzlibSync(png.slice(idat + 4, idat + 4 + len));
    expect(raw.length).toBe(3 * 5);
    // ligne 2 filtrée « Up » : différence avec la ligne 1
    expect(raw[5]).toBe(2);
    expect(raw[6]).toBe((80 - 0) & 0xff);
  });
});

// ------------------------------------------------------------------ tableaux

const wd = (t: string, x0: number, y0: number, x1: number, y1: number, c = 95) => ({ text: t, confidence: c, bbox: { x0, y0, x1, y1 } });
const tline = (words: ReturnType<typeof wd>[]) => {
  const b = {
    x0: Math.min(...words.map((w) => w.bbox.x0)),
    y0: Math.min(...words.map((w) => w.bbox.y0)),
    x1: Math.max(...words.map((w) => w.bbox.x1)),
    y1: Math.max(...words.map((w) => w.bbox.y1)),
  };
  return { text: words.map((w) => w.text).join(" "), confidence: 90, bbox: b, words };
};
const block = (lines: ReturnType<typeof tline>[]): TessBlock => {
  const b = {
    x0: Math.min(...lines.map((l) => l.bbox.x0)),
    y0: Math.min(...lines.map((l) => l.bbox.y0)),
    x1: Math.max(...lines.map((l) => l.bbox.x1)),
    y1: Math.max(...lines.map((l) => l.bbox.y1)),
  };
  return { bbox: b, paragraphs: [{ bbox: b, lines }] };
};

describe("tableaux", () => {
  it("tableau à traits : chaque mot va dans sa case, case fusionnée respectée", () => {
    const H = (y: number) => ({ x0: 100, x1: 700, y0: y - 1, y1: y + 2, horizontal: true });
    const V = (x: number, y1 = 300) => ({ x0: x - 1, x1: x + 2, y0: 100, y1, horizontal: false });
    // 3 rangées × 3 colonnes ; dernière rangée : les deux premières cases fusionnées
    const rulings = [H(100), H(166), H(233), H(300), V(100), V(300, 233), V(500), V(700)];
    const blocks = [
      block([tline([wd("Article", 110, 120, 200, 145)])]),
      block([tline([wd("Qté", 310, 120, 360, 145)])]),
      block([tline([wd("Prix", 510, 120, 570, 145)])]),
      block([tline([wd("Stylo", 110, 190, 180, 215), wd("2", 320, 190, 335, 215), wd("3,00", 510, 190, 570, 215)])]),
      block([tline([wd("Total", 110, 255, 180, 280), wd("6,00", 510, 255, 570, 280)])]),
    ];
    const layout = buildLayout(blocks, 800, 400, { rulings });
    expect(layout.paragraphs.filter((p) => p.table)).toHaveLength(1);
    expect(layoutToText(layout)).toBe("Article\tQté\tPrix\nStylo\t2\t3,00\nTotal\t\t6,00");
    const t = layout.paragraphs[0].table!;
    expect(t.cells.find((c) => c.r === 2 && c.c === 0)?.cs).toBe(2);
  });

  it("tableau sans traits (colonnes de blanc), même découpé en colonnes par le moteur", () => {
    const days = ["Lundi", "Mardi", "Mercredi", "Jeudi"];
    const col = (x: number, texts: string[]) => block(texts.map((t, i) => tline([wd(t, x, 100 + i * 40, x + t.length * 12, 124 + i * 40)])));
    const blocks = [col(100, days), col(400, ["9h-12h", "9h-12h", "Fermé", "9h-12h"]), col(700, ["14h-18h", "14h-17h", "14h-18h", "14h-18h"])];
    const text = layoutToText(buildLayout(blocks, 1000, 400));
    expect(text).toBe("Lundi\t9h-12h\t14h-18h\nMardi\t9h-12h\t14h-17h\nMercredi\tFermé\t14h-18h\nJeudi\t9h-12h\t14h-18h");
  });

  it("deux colonnes de texte suivi ne sont pas prises pour un tableau (lecture automatique)", () => {
    const prose = (x: number) =>
      block(
        [0, 1, 2, 3].map((i) =>
          tline(["Ceci", "est", "une", "longue", "phrase", "de", "texte"].map((t, k) => wd(t, x + k * 52, 100 + i * 30, x + k * 52 + 44, 122 + i * 30))),
        ),
      );
    const layout = buildLayout([prose(50), prose(500)], 1000, 300);
    expect(layout.paragraphs.some((p) => p.table)).toBe(false);
  });

  it("texte : repérage des tableaux, modification d'une case, HTML pour le presse-papiers", () => {
    const text = "Titre\n\nA\tB\n1\t2\nFin";
    const blocks = parseBlocks(text);
    expect(blocks.map((b) => b.kind)).toEqual(["para", "table", "para"]);
    const t = blocks[1];
    if (t.kind !== "table") throw new Error();
    expect(t.rows).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
    expect(setTableCell(text, t, 1, 1, "deux\tmots")).toBe("Titre\n\nA\tB\n1\tdeux mots\nFin");
    expect(textToHtml(text)).toContain("<table");
    expect(textToHtml("<b>")).toContain("&lt;b&gt;");
    // le recollage des lignes ne touche pas aux rangées d'un tableau
    expect(reflowText("Une ligne\ncoupée\n\nA\tB\n1\t2")).toBe("Une ligne coupée\n\nA\tB\n1\t2");
  });
});

// ------------------------------------------------------------------ seconde passe

describe("zones oubliées par le découpage de la page", () => {
  it("détecte des caractères non lus et ajoute les mots de la seconde passe", () => {
    const first = [block([tline([wd("Bonjour", 100, 100, 200, 120)])])];
    const boxes: number[] = [];
    for (let k = 0; k < 8; k++) boxes.push(600 + k * 12, 100, 610 + k * 12, 120); // un mot non lu
    boxes.push(110, 100, 120, 120); // caractère déjà lu
    expect(missedCharCount(first, Int32Array.from(boxes), 20)).toBe(8);
    const second = [block([tline([wd("Bonjour", 101, 100, 199, 120), wd("Total", 600, 100, 700, 120)])])];
    const merged = mergeMissedWords(first, second);
    expect(layoutToText(buildLayout(merged, 800, 200)).split(/\s+/)).toEqual(["Bonjour", "Total"]);
  });
});

// ------------------------------------------------------------------ alignement et PDF

describe("alignement du texte corrigé sur les mots reconnus", () => {
  it("mots corrigés, ajoutés et supprimés", () => {
    expect(similarity("recelves", "receives")).toBeGreaterThan(0.5);
    const words = ["Life", "is", "a", "prechous", "gif", "that"];
    const tokens = tokenize("Life is a precious gift, truly that").map((t) => t.text);
    const m = alignTokens(tokens, words);
    expect(Array.from(m)).toEqual([0, 1, 2, 3, 4, -1, 5]);
  });

  const layout: OcrLayout = {
    w: 1000,
    h: 1000,
    paragraphs: [
      {
        b: [100, 100, 600, 140],
        lines: [
          {
            b: [100, 100, 600, 140],
            bl: [100, 132, 600, 132],
            rh: 40,
            words: [
              { t: "Bonjuor", c: 50, b: [100, 100, 260, 140] },
              { t: "le", c: 95, b: [290, 100, 330, 140] },
              { t: "monde", c: 95, b: [360, 100, 600, 140] },
            ],
          },
        ],
      },
    ],
  };

  it("un mot corrigé garde l'emplacement exact du mot photographié", () => {
    const placed = placeWords("Bonjour le monde", layout);
    expect(placed.map((p) => [p.text, p.x0, p.x1])).toEqual([
      ["Bonjour", 100, 260],
      ["le", 290, 330],
      ["monde", 360, 600],
    ]);
    expect(placed[0].baseline).toBe(132);
  });

  it("PDF recherchable : chaque mot a la largeur et la position du mot sur l'image", async () => {
    const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const blob = await buildSearchablePdf(
      [{ text: "Bonjour le monde", edited: true, layout, imageW: 1000, imageH: 1000, getImage: async () => new Blob([PNG], { type: "image/png" }) }],
      { title: "t", separators: true, reflow: false, docxMode: "simple", includeImages: false },
    );
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    const pg = await doc.getPage(1);
    const s = 841.89 / 1000; // image carrée : page au format paysage
    const items = (await pg.getTextContent()).items.filter((it) => "str" in it && it.str.trim()) as { str: string; transform: number[]; width: number }[];
    // les mots et leurs espaces se suivent exactement : le lecteur en fait un seul bloc
    // qui couvre la ligne du premier au dernier mot de la photo
    expect(items.map((i) => i.str).join("").replace(/\s+/g, " ").trim()).toBe("Bonjour le monde");
    const first = items[0];
    const last = items[items.length - 1];
    expect(first.transform[4]).toBeCloseTo(100 * s, 1);
    expect(last.transform[4] + last.width).toBeCloseTo(600 * s, 0);
    // ligne de base : 132 px depuis le haut
    expect(first.transform[5]).toBeCloseTo((1000 - 132) * s, 1);
  });
});
