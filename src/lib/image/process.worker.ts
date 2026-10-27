/// <reference lib="webworker" />
import { processImage, type RGBAImage } from "./ops";
import { runOcrPrep } from "./ocr-prep";
import type { ImageParams } from "../types";

type Job =
  | { id: number; kind: "process"; image: RGBAImage; params: ImageParams; maxSide: number }
  | { id: number; kind: "ocr"; image: RGBAImage };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
    if (job.kind === "ocr") {
      const ocr = runOcrPrep(job.image);
      ctx.postMessage({ id: job.id, ok: true, ocr }, [ocr.png.buffer, ocr.charBoxes.buffer]);
    } else {
      const image = processImage(job.image, job.params, job.maxSide);
      ctx.postMessage({ id: job.id, ok: true, image }, [image.data.buffer]);
    }
  } catch (err) {
    ctx.postMessage({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
