/// <reference lib="webworker" />
import { processImage, type RGBAImage } from "./ops";
import type { ImageParams } from "../types";

interface Job {
  id: number;
  image: RGBAImage;
  params: ImageParams;
  maxSide: number;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent<Job>) => {
  const { id, image, params, maxSide } = e.data;
  try {
    const out = processImage(image, params, maxSide);
    ctx.postMessage({ id, ok: true, image: out }, [out.data.buffer]);
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
