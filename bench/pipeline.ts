// Chaîne de reconnaissance de l'application, exécutée sous Node (sans navigateur)
// pour le banc de précision. Mêmes modules que l'application.
import { createRequire } from "node:module";
import { join } from "node:path";
import { prepareOcrImage } from "../src/lib/image/ocr-prep";
import { encodeGrayPng } from "../src/lib/image/png";
import { rgbaToGray } from "../src/lib/image/detect";
import { straightenImage } from "../src/lib/image/straighten";
import type { RGBAImage } from "../src/lib/image/ops";
import { buildLayout, layoutToText, type TessBlock } from "../src/lib/ocr/layout";
import { estimateDpi, mergeMissedWords, missedCharCount, scaleBlocks } from "../src/lib/ocr/engine";
import type { LayoutMode } from "../src/lib/types";

const require = createRequire(import.meta.url);

type Worker = {
  setParameters(p: Record<string, string>): Promise<unknown>;
  recognize(img: Buffer, o: object, out: object): Promise<{ data: { blocks: TessBlock[] } }>;
  terminate(): Promise<unknown>;
};

export async function createEngine(root: string, lang: string): Promise<Worker> {
  const T = require(join(root, "node_modules", "tesseract.js"));
  return T.createWorker(lang.split("+"), 1, { langPath: join(root, "public", "tesseract", "lang"), cachePath: join(root, "bench", ".out", "cache"), gzip: true });
}

/** `improved` = chaîne actuelle ; sinon chaîne d'origine (image telle quelle). */
export async function recognize(worker: Worker, img: RGBAImage, opts: { improved: boolean; mode?: LayoutMode }): Promise<{ text: string; ms: number }> {
  const t0 = Date.now();
  const mode = opts.mode ?? "auto";
  const psm = mode === "table" ? "6" : "3";
  if (!opts.improved) {
    const png = Buffer.from(encodeGrayPng(rgbaToGray(img.data, img.width, img.height), img.width, img.height));
    await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: String(estimateDpi(img.width, img.height)) });
    const { data } = await worker.recognize(png, {}, { blocks: true });
    return { text: layoutToText(buildLayout(data.blocks, img.width, img.height)), ms: Date.now() - t0 };
  }
  const straight = straightenImage(img);
  const p = prepareOcrImage(straight);
  const png = Buffer.from(encodeGrayPng(p.gray, p.w, p.h));
  await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: mode === "table" ? "1" : "0", user_defined_dpi: String(p.dpi) });
  let blocks = scaleBlocks((await worker.recognize(png, {}, { blocks: true })).data.blocks, p.scale);
  if (p.charH && missedCharCount(blocks, p.charBoxes, p.charH) >= 6) {
    await worker.setParameters({ tessedit_pageseg_mode: "11", preserve_interword_spaces: "0" });
    blocks = mergeMissedWords(blocks, scaleBlocks((await worker.recognize(png, {}, { blocks: true })).data.blocks, p.scale));
  }
  const layout = buildLayout(blocks, straight.width, straight.height, { rulings: p.rulings, mode });
  return { text: layoutToText(layout), ms: Date.now() - t0 };
}
