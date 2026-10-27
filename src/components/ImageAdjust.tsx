import { useEffect, useState } from "react";
import { Crop, RotateCcw, RotateCw, ScanLine, Sparkles } from "lucide-react";
import { canvasToBlob, decodeImage, detectQuad, drawScaled, releaseCanvas, releaseSource, renderPreview } from "../lib/image/pipeline";
import { fullQuad } from "../lib/image/geometry";
import type { FilterId, ImageParams, Quad, Rotation } from "../lib/types";
import { Button, Segmented } from "./ui";
import { FILTER_OPTIONS } from "../screens/Settings";
import { cn } from "./ui/cn";

export interface PreviewSource {
  /** Version réduite pour les aperçus. */
  canvas: HTMLCanvasElement;
  /** Taille de l'image d'origine (repère des coins). */
  w: number;
  h: number;
  /** URL de l'image d'origine (pour le recadrage). */
  url: string;
}

const PREVIEW_SIDE = 1100;

/** Prépare une source d'aperçu à partir de l'image d'origine stockée. */
export function usePreviewSource(blob: Blob | null | undefined): PreviewSource | null {
  const [src, setSrc] = useState<PreviewSource | null>(null);
  useEffect(() => {
    if (!blob) return;
    let cancelled = false;
    let made: PreviewSource | null = null;
    void (async () => {
      const img = await decodeImage(blob);
      const w = "naturalWidth" in img ? img.naturalWidth : img.width;
      const h = "naturalHeight" in img ? img.naturalHeight : img.height;
      const canvas = drawScaled(img, PREVIEW_SIDE);
      releaseSource(img);
      if (cancelled) return releaseCanvas(canvas);
      made = { canvas, w, h, url: URL.createObjectURL(blob) };
      setSrc(made);
    })().catch(() => setSrc(null));
    return () => {
      cancelled = true;
      if (made) {
        releaseCanvas(made.canvas);
        URL.revokeObjectURL(made.url);
      }
      setSrc(null);
    };
  }, [blob]);
  return src;
}

/** Aperçu du rendu (recadrage + perspective + filtre), recalculé à chaque réglage. */
export function useProcessedPreview(source: PreviewSource | null, params: ImageParams): { url: string | null; busy: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    let made: string | null = null;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const out = await renderPreview(source.canvas, JSON.parse(key) as ImageParams, source.canvas.width / source.w, PREVIEW_SIDE);
        const blob = await canvasToBlob(out, "image/jpeg", 0.85);
        releaseCanvas(out);
        if (cancelled) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (made) URL.revokeObjectURL(made);
    };
  }, [source, key]);
  return { url, busy };
}

export function autoQuad(source: PreviewSource): Quad | null {
  const q = detectQuad(source.canvas);
  if (!q) return null;
  const s = source.w / source.canvas.width;
  return q.map((p) => ({ x: p.x * s, y: p.y * s })) as Quad;
}

const rotate = (r: Rotation, d: 90 | -90): Rotation => (((r + d + 360) % 360) as Rotation);

/** Barre de réglages : filtre, rotation, netteté, recadrage. */
export function AdjustControls({
  params,
  onChange,
  cropping,
  onToggleCrop,
  source,
  dark,
}: {
  params: ImageParams;
  onChange: (p: ImageParams) => void;
  cropping: boolean;
  onToggleCrop: () => void;
  source: PreviewSource | null;
  dark?: boolean;
}) {
  const v = dark ? ("dark" as const) : ("secondary" as const);
  return (
    <div className="space-y-3">
      {cropping ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={v}
            icon={<ScanLine className="size-4" aria-hidden />}
            onClick={() => {
              if (!source) return;
              const q = autoQuad(source);
              onChange({ ...params, quad: q });
            }}
          >
            Détection auto
          </Button>
          <Button size="sm" variant={v} onClick={() => source && onChange({ ...params, quad: fullQuad(source.w, source.h) })}>
            Page entière
          </Button>
          <Button size="sm" variant="primary" className="ml-auto" onClick={onToggleCrop}>
            Valider le cadre
          </Button>
        </div>
      ) : (
        <>
          <Segmented<FilterId>
            label="Filtre"
            value={params.filter}
            onChange={(filter) => onChange({ ...params, filter })}
            options={FILTER_OPTIONS}
            className={cn("w-full", dark && "bg-white/10 [&_[aria-checked=false]]:text-white/80")}
          />
          <div className="grid grid-cols-4 gap-2">
            <Button size="sm" variant={v} icon={<Crop className="size-4" aria-hidden />} onClick={onToggleCrop}>
              Recadrer
            </Button>
            <Button size="sm" variant={v} icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => onChange({ ...params, rotation: rotate(params.rotation, -90) })} aria-label="Pivoter à gauche">
              <span className="max-sm:sr-only">Gauche</span>
            </Button>
            <Button size="sm" variant={v} icon={<RotateCw className="size-4" aria-hidden />} onClick={() => onChange({ ...params, rotation: rotate(params.rotation, 90) })} aria-label="Pivoter à droite">
              <span className="max-sm:sr-only">Droite</span>
            </Button>
            <Button
              size="sm"
              variant={params.sharpen ? "subtle" : v}
              aria-pressed={params.sharpen}
              icon={<Sparkles className="size-4" aria-hidden />}
              onClick={() => onChange({ ...params, sharpen: !params.sharpen })}
            >
              Netteté
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
