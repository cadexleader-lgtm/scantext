import { useEffect, useId, useRef, useState } from "react";
import { clampQuad } from "../lib/image/geometry";
import type { Point, Quad } from "../lib/types";

/**
 * Recadrage manuel : 4 coins déplaçables (doigt, souris ou clavier) sur
 * l'image d'origine, avec loupe pendant le déplacement.
 */
export function CropEditor({
  src,
  width,
  height,
  quad,
  onChange,
}: {
  src: string;
  width: number;
  height: number;
  quad: Quad;
  onChange: (q: Quad) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<number | null>(null);
  const maskId = `crop-mask-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      // l'image est contenue dans le cadre en conservant ses proportions
      const scale = Math.min(r.width / width, r.height / height);
      setBox({ w: width * scale, h: height * scale });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);

  const scale = box.w / width || 0;
  const toScreen = (p: Point) => ({ x: p.x * scale, y: p.y * scale });

  function pointFromEvent(e: React.PointerEvent): Point {
    const svg = (e.currentTarget as Element).closest("svg")!;
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  }

  function move(i: number, p: Point) {
    const next = quad.map((c, k) => (k === i ? p : c)) as Quad;
    onChange(clampQuad(next, width, height));
  }

  const pts = quad.map(toScreen);
  const LOUPE = 110;
  const ZOOM = 2.5;

  return (
    <div ref={boxRef} className="relative flex size-full items-center justify-center">
      <div className="relative" style={{ width: box.w, height: box.h }}>
        <img src={src} alt="Page à recadrer" className="absolute inset-0 size-full select-none" draggable={false} />
        <svg
          className="absolute inset-0 size-full touch-none overflow-visible"
          viewBox={`0 0 ${box.w || 1} ${box.h || 1}`}
          role="group"
          aria-label="Coins du document : déplacez-les sur les angles de la page"
        >
          <defs>
            <mask id={maskId}>
              <rect width="100%" height="100%" fill="white" />
              <polygon points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="black" />
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="rgb(15 23 42 / 0.45)" mask={`url(#${maskId})`} />
          <polygon points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#3b6cf6" strokeWidth={2.5} />
          {pts.map((p, i) => (
            <g key={i}>
              <circle
                cx={p.x}
                cy={p.y}
                r={24}
                fill="transparent"
                className="cursor-grab outline-none"
                tabIndex={0}
                role="slider"
                aria-label={["Coin haut gauche", "Coin haut droit", "Coin bas droit", "Coin bas gauche"][i]}
                aria-valuetext={`${Math.round(quad[i].x)}, ${Math.round(quad[i].y)}`}
                onPointerDown={(e) => {
                  (e.target as Element).setPointerCapture(e.pointerId);
                  setDrag(i);
                }}
                onPointerMove={(e) => drag === i && move(i, pointFromEvent(e))}
                onPointerUp={() => setDrag(null)}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(e) => {
                  const step = (e.shiftKey ? 20 : 4) / Math.max(scale, 0.01);
                  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
                  if (!d) return;
                  e.preventDefault();
                  move(i, { x: quad[i].x + d[0], y: quad[i].y + d[1] });
                }}
              />
              <circle cx={p.x} cy={p.y} r={11} fill="white" stroke="#1d43c4" strokeWidth={3} pointerEvents="none" />
            </g>
          ))}
        </svg>
        {drag !== null && (
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-full border-4 border-white shadow-xl"
            style={{
              width: LOUPE,
              height: LOUPE,
              left: Math.min(Math.max(pts[drag].x - LOUPE / 2, -10), box.w - LOUPE + 10),
              top: pts[drag].y - LOUPE - 36 < -20 ? pts[drag].y + 36 : pts[drag].y - LOUPE - 36,
              backgroundImage: `url(${src})`,
              backgroundRepeat: "no-repeat",
              backgroundSize: `${box.w * ZOOM}px ${box.h * ZOOM}px`,
              backgroundPosition: `${LOUPE / 2 - pts[drag].x * ZOOM}px ${LOUPE / 2 - pts[drag].y * ZOOM}px`,
            }}
          >
            <span className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand-600" />
          </div>
        )}
      </div>
    </div>
  );
}
