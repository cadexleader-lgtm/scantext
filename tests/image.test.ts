import { describe, expect, it } from "vitest";
import { applyHomography, homography, maxAreaQuad, convexHull, orderQuad, quadArea, fullQuad } from "../src/lib/image/geometry";
import { detectDocument, otsuThreshold } from "../src/lib/image/detect";
import { adaptiveThreshold, normalizeBackground, processImage, rotateImage, warpPerspective, type RGBAImage } from "../src/lib/image/ops";
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

/** Photo synthétique : feuille claire (avec lignes de « texte ») sur fond sombre bruité. */
function syntheticPhoto(w: number, h: number, q: Quad): Uint8ClampedArray {
  const g = new Uint8ClampedArray(w * h);
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const H = homography(q, fullQuad(100, 140)); // image → repère page
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = { x: x + 0.5, y: y + 0.5 };
      let v = 60 + rnd() * 30;
      if (pointInQuad(p, q)) {
        const u = applyHomography(H, p);
        const isText = u.x > 10 && u.x < 90 && Math.floor(u.y) % 8 < 2 && u.y > 10 && u.y < 130;
        v = isText ? 40 : 205 + rnd() * 25 - (x / w) * 30; // léger dégradé d'éclairage
      }
      g[y * w + x] = v;
    }
  return g;
}

describe("géométrie", () => {
  it("homographie : les 4 coins sont envoyés exactement", () => {
    const from = fullQuad(100, 200);
    const to: Quad = [{ x: 10, y: 20 }, { x: 300, y: 5 }, { x: 320, y: 410 }, { x: 0, y: 380 }];
    const H = homography(from, to);
    from.forEach((p, i) => {
      const r = applyHomography(H, p);
      expect(r.x).toBeCloseTo(to[i].x, 6);
      expect(r.y).toBeCloseTo(to[i].y, 6);
    });
  });

  it("orderQuad range les coins dans le sens HG, HD, BD, BG", () => {
    const q = orderQuad([{ x: 90, y: 95 }, { x: 5, y: 8 }, { x: 10, y: 100 }, { x: 100, y: 0 }]);
    expect(q).toEqual([{ x: 5, y: 8 }, { x: 100, y: 0 }, { x: 90, y: 95 }, { x: 10, y: 100 }]);
  });

  it("maxAreaQuad retrouve les coins d'un quadrilatère échantillonné", () => {
    const q: Quad = [{ x: 20, y: 30 }, { x: 180, y: 10 }, { x: 190, y: 160 }, { x: 15, y: 150 }];
    const pts: Point[] = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      for (let t = 0; t < 1; t += 0.05) pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    const found = maxAreaQuad(convexHull(pts))!;
    found.forEach((p, i) => {
      expect(Math.abs(p.x - q[i].x)).toBeLessThan(1);
      expect(Math.abs(p.y - q[i].y)).toBeLessThan(1);
    });
  });
});

describe("détection de document", () => {
  it("trouve une feuille inclinée en perspective sur un fond sombre", () => {
    const w = 360;
    const h = 270;
    const q: Quad = [{ x: 70, y: 30 }, { x: 290, y: 45 }, { x: 310, y: 250 }, { x: 40, y: 235 }];
    const res = detectDocument(syntheticPhoto(w, h, q), w, h);
    expect(res).not.toBeNull();
    res!.quad.forEach((p, i) => {
      expect(Math.hypot(p.x - q[i].x, p.y - q[i].y)).toBeLessThan(6);
    });
  });

  it("ne détecte rien sur une image uniforme (page qui remplit le cadre / pas de contraste)", () => {
    const g = new Uint8ClampedArray(300 * 200).fill(220);
    expect(detectDocument(g, 300, 200)).toBeNull();
  });

  it("seuil d'Otsu entre deux populations", () => {
    const g = [...new Array(500).fill(50), ...new Array(500).fill(200)];
    const t = otsuThreshold(g);
    expect(t).toBeGreaterThanOrEqual(50);
    expect(t).toBeLessThan(200);
  });
});

function solid(w: number, h: number, f: (x: number, y: number) => [number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  return { data, width: w, height: h };
}

describe("opérations d'image", () => {
  it("warp identité conserve l'image", () => {
    const img = solid(40, 30, (x, y) => [x * 6, y * 8, 100]);
    const out = warpPerspective(img, fullQuad(40, 30), 40, 30);
    for (let i = 0; i < img.data.length; i++) expect(Math.abs(out.data[i] - img.data[i])).toBeLessThanOrEqual(1);
  });

  it("rotation 90° puis 270° revient à l'original", () => {
    const img = solid(7, 5, (x, y) => [x * 30, y * 40, 7]);
    const r = rotateImage(rotateImage(img, 90), 270);
    expect(r.width).toBe(7);
    expect(Array.from(r.data)).toEqual(Array.from(img.data));
    const r90 = rotateImage(img, 90);
    expect([r90.width, r90.height]).toEqual([5, 7]);
    // le pixel haut-gauche passe en haut-droite
    expect(r90.data[(0 * 5 + 4) * 4]).toBe(img.data[0]);
  });

  it("normalisation du fond : un dégradé d'éclairage devient uniforme", () => {
    const w = 200;
    const h = 100;
    const g = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = 120 + (x / w) * 100; // ombre à gauche
    const n = normalizeBackground(g, w, h);
    expect(n[50 * w + 5]).toBeGreaterThan(235);
    expect(n[50 * w + 195]).toBeGreaterThan(235);
  });

  it("seuillage adaptatif : texte noir, papier blanc malgré l'ombre", () => {
    const w = 200;
    const h = 100;
    const g = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) g[y * w + x] = (y % 10 < 2 && x % 20 < 12 ? 30 : 160) + (x / w) * 80;
    const t = adaptiveThreshold(g, w, h);
    expect(t[0]).toBe(0); // trait
    expect(t[5 * w + 5]).toBe(255); // papier
    expect(t[5 * w + 195]).toBe(255);
  });

  it("processImage : recadrage + rotation donnent la bonne taille", () => {
    const img = solid(100, 80, () => [200, 200, 200]);
    const out = processImage(img, { quad: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 70 }, { x: 10, y: 70 }], rotation: 90, filter: "gray", sharpen: true }, 1000);
    expect([out.width, out.height]).toEqual([60, 50]);
    expect(quadArea(fullQuad(2, 3))).toBe(6);
  });
});

describe("proportions réelles en perspective", () => {
  /** Projette un rectangle 3D (largeur W, hauteur H) incliné, avec une caméra de focale f centrée. */
  function project(W: number, H: number, f: number, rx: number, rz: number, dist: number, imgW: number, imgH: number): Quad {
    const corners = [
      [-W / 2, -H / 2],
      [W / 2, -H / 2],
      [W / 2, H / 2],
      [-W / 2, H / 2],
    ];
    return corners.map(([x, y]) => {
      // rotation autour de Z puis de X
      const x1 = x * Math.cos(rz) - y * Math.sin(rz);
      const y1 = x * Math.sin(rz) + y * Math.cos(rz);
      const y2 = y1 * Math.cos(rx);
      const z2 = y1 * Math.sin(rx) + dist;
      return { x: imgW / 2 + (f * x1) / z2, y: imgH / 2 + (f * y2) / z2 };
    }) as Quad;
  }

  it("retrouve le format A4 d'une page photographiée de biais", async () => {
    const { perspectiveAspect, quadOutputSize } = await import("../src/lib/image/geometry");
    const q = project(210, 297, 1400, 0.35, -0.1, 700, 1500, 2000);
    const r = perspectiveAspect(q, 1500, 2000)!;
    expect(r).toBeCloseTo(210 / 297, 2);
    const { w, h } = quadOutputSize(q, 1500, 2000);
    expect(h / w).toBeCloseTo(297 / 210, 1);
  });

  it("vue de face : rapport inchangé", async () => {
    const { perspectiveAspect } = await import("../src/lib/image/geometry");
    const q: Quad = [{ x: 100, y: 100 }, { x: 310, y: 100 }, { x: 310, y: 397 }, { x: 100, y: 397 }];
    expect(perspectiveAspect(q, 400, 500)).toBeCloseTo(210 / 297, 3);
  });
});

describe("courbe document", () => {
  it("papier blanc pur, encre noire, gris d'anticrénelage préservés", async () => {
    const { documentCurve } = await import("../src/lib/image/ops");
    const g = new Uint8ClampedArray(10_000).fill(245);
    for (let i = 0; i < 100; i++) g[i] = 30; // 1 % de texte
    for (let i = 100; i < 300; i++) g[i] = 200; // bord des lettres
    const out = documentCurve(g);
    expect(out[5000]).toBe(255);
    expect(out[0]).toBe(0);
    expect(out[150]).toBeGreaterThan(190); // pas de halo sombre
  });
});
