import { describe, expect, it } from "vitest";
import { findPage } from "../src/lib/image/edges";
import { applyHomography, fullQuad, homography } from "../src/lib/image/geometry";
import type { Point, Quad } from "../src/lib/types";

function pointInQuad(p: Point, q: Quad): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i];
    const b = q[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

interface Scene {
  w: number;
  h: number;
  page: Quad;
  /** Valeur du fond en (x, y). */
  bg: (x: number, y: number, rnd: () => number) => number;
  paper?: number;
  /** Rectangle noir épais dans la page (tableau), en coordonnées page 0-100 × 0-140. */
  innerBox?: boolean;
}

function render(s: Scene): Uint8ClampedArray {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const g = new Uint8ClampedArray(s.w * s.h);
  const H = homography(s.page, fullQuad(100, 140));
  for (let y = 0; y < s.h; y++)
    for (let x = 0; x < s.w; x++) {
      const p = { x: x + 0.5, y: y + 0.5 };
      let v: number;
      if (pointInQuad(p, s.page)) {
        const u = applyHomography(H, p);
        const text = u.x > 12 && u.x < 88 && u.y > 10 && u.y < 130 && Math.floor(u.y * 1.2) % 6 === 0 && (Math.floor(u.x * 2) % 7 !== 0);
        const box = s.innerBox && u.x > 15 && u.x < 85 && u.y > 40 && u.y < 90 && (Math.abs(u.x - 15) < 1.2 || Math.abs(u.x - 85) < 1.2 || Math.abs(u.y - 40) < 1.2 || Math.abs(u.y - 90) < 1.2);
        v = text || box ? 35 : (s.paper ?? 238) - (u.y / 140) * 12 + rnd() * 6;
      } else v = s.bg(x, y, rnd);
      g[y * s.w + x] = v;
    }
  return g;
}

function cornerError(found: Quad, truth: Quad): number {
  return Math.max(...found.map((p, i) => Math.hypot(p.x - truth[i].x, p.y - truth[i].y)));
}

const W = 300;
const H = 400;
const tilted: Quad = [{ x: 62, y: 70 }, { x: 236, y: 52 }, { x: 258, y: 340 }, { x: 40, y: 352 }];

describe("détection de la feuille sur des fonds difficiles", () => {
  it("fond texturé clair (tissu gris moucheté)", () => {
    const g = render({ w: W, h: H, page: tilted, bg: (x, y, r) => 150 + r() * 70 + ((x * 7 + y * 13) % 17 < 3 ? 25 : 0) });
    const res = findPage(g, W, H);
    expect(res).not.toBeNull();
    expect(cornerError(res!.quad, tilted)).toBeLessThan(6);
  });

  it("table presque blanche (faible contraste) avec dégradé d'éclairage", () => {
    const g = render({ w: W, h: H, page: tilted, paper: 246, bg: (x, _y, r) => 212 - (x / W) * 25 + r() * 6 });
    const res = findPage(g, W, H);
    expect(res).not.toBeNull();
    expect(cornerError(res!.quad, tilted)).toBeLessThan(6);
  });

  it("tableau noir dans la page : c'est bien le bord de la feuille qui est retenu", () => {
    const g = render({ w: W, h: H, page: tilted, innerBox: true, bg: (_x, _y, r) => 90 + r() * 30 });
    const res = findPage(g, W, H);
    expect(res).not.toBeNull();
    expect(cornerError(res!.quad, tilted)).toBeLessThan(6);
  });

  it("feuille plus large que le cadre : bords gauche/droit = bords de l'image", () => {
    const page: Quad = [{ x: -20, y: 60 }, { x: W + 20, y: 60 }, { x: W + 20, y: 340 }, { x: -20, y: 340 }];
    const g = render({ w: W, h: H, page, bg: (_x, _y, r) => 80 + r() * 30 });
    const res = findPage(g, W, H);
    expect(res).not.toBeNull();
    const q = res!.quad;
    expect(Math.abs(q[0].y - 60)).toBeLessThan(5);
    expect(Math.abs(q[3].y - 340)).toBeLessThan(5);
    expect(q[0].x).toBeLessThan(5);
    expect(q[1].x).toBeGreaterThan(W - 5);
  });

  it("image sans feuille visible (texture seule) : pas de cadre inventé", () => {
    let seed = 3;
    const r = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const g = new Uint8ClampedArray(W * H).map(() => 120 + r() * 80);
    expect(findPage(g, W, H)).toBeNull();
  });
});
