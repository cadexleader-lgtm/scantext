import type { FilterId, ImageParams, Quad, Rotation } from "../types";
import { boxBlur, rgbaToGray } from "./detect";
import { fullQuad, homography, quadOutputSize } from "./geometry";

/** Image RGBA brute (compatible ImageData, utilisable dans un worker ou sous Node). */
export interface RGBAImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Redresse la zone `quad` de `src` en un rectangle outW×outH (correction de
 * perspective, échantillonnage bilinéaire).
 */
export function warpPerspective(src: RGBAImage, quad: Quad, outW: number, outH: number): RGBAImage {
  const H = homography(fullQuad(outW, outH), quad);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const { data, width: sw, height: sh } = src;
  const maxX = sw - 1;
  const maxY = sh - 1;
  for (let y = 0; y < outH; y++) {
    // centre du pixel de sortie
    const py = y + 0.5;
    const bx = H[1] * py + H[2];
    const by = H[4] * py + H[5];
    const bd = H[7] * py + H[8];
    let o = y * outW * 4;
    for (let x = 0; x < outW; x++, o += 4) {
      const px = x + 0.5;
      const d = H[6] * px + bd;
      let sx = (H[0] * px + bx) / d - 0.5;
      let sy = (H[3] * px + by) / d - 0.5;
      if (sx < 0) sx = 0;
      else if (sx > maxX) sx = maxX;
      if (sy < 0) sy = 0;
      else if (sy > maxY) sy = maxY;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      out[o] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
      out[o + 1] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
      out[o + 2] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

/** Rotation par quarts de tour, dans le sens horaire. */
export function rotateImage(img: RGBAImage, rotation: Rotation): RGBAImage {
  if (rotation === 0) return img;
  const { width: w, height: h, data } = img;
  const nw = rotation === 180 ? w : h;
  const nh = rotation === 180 ? h : w;
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = rotation === 90 ? h - 1 - y : rotation === 180 ? w - 1 - x : y;
      const ny = rotation === 90 ? x : rotation === 180 ? h - 1 - y : w - 1 - x;
      const si = (y * w + x) * 4;
      const di = (ny * nw + nx) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}

/** Valeurs aux percentiles bas/haut d'une image en niveaux de gris. */
function percentiles(gray: Uint8ClampedArray, low: number, high: number): [number, number] {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const n = gray.length;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n * low) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= n * (1 - high)) {
      hi = v;
      break;
    }
  }
  return [lo, hi];
}

/** Étirement d'histogramme. */
export function autoLevels(gray: Uint8ClampedArray, low = 0.01, high = 0.99): Uint8ClampedArray {
  const [lo, hi] = percentiles(gray, low, high);
  if (hi - lo < 10) return gray;
  const scale = 255 / (hi - lo);
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = (gray[i] - lo) * scale;
  return out;
}

/**
 * Courbe « document » après normalisation du fond : le papier devient blanc
 * pur, l'encre la plus foncée devient noire. Le point noir est pris sur une
 * toute petite fraction de pixels (le texte n'occupe souvent que 1 à 3 % de la
 * page) : un percentile plus large noircirait les gris d'anticrénelage et
 * créerait un halo autour des lettres.
 */
export function documentCurve(gray: Uint8ClampedArray, whitePoint = 232): Uint8ClampedArray {
  const [lo] = percentiles(gray, 0.002, 1);
  const black = Math.min(lo, whitePoint - 60);
  const scale = 255 / (whitePoint - black);
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = (gray[i] - black) * scale;
  return out;
}

/**
 * Supprime ombres et éclairage inégal : estime le fond (le papier) par un
 * maximum local sur une grille grossière, puis divise l'image par ce fond.
 */
export function normalizeBackground(gray: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const f = Math.max(2, Math.round(Math.max(w, h) / 160));
  const sw = Math.ceil(w / f);
  const sh = Math.ceil(h / f);
  let small: Uint8ClampedArray = new Uint8ClampedArray(sw * sh);
  for (let by = 0; by < sh; by++) {
    for (let bx = 0; bx < sw; bx++) {
      let m = 0;
      const y1 = Math.min(h, (by + 1) * f);
      const x1 = Math.min(w, (bx + 1) * f);
      for (let y = by * f; y < y1; y++) {
        const row = y * w;
        for (let x = bx * f; x < x1; x++) if (gray[row + x] > m) m = gray[row + x];
      }
      small[by * sw + bx] = m;
    }
  }
  // dilatation : efface les gros caractères (titres) de l'estimation du fond
  const dil = new Uint8ClampedArray(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let m = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = Math.min(sh - 1, Math.max(0, y + dy));
        for (let dx = -2; dx <= 2; dx++) {
          const v = small[yy * sw + Math.min(sw - 1, Math.max(0, x + dx))];
          if (v > m) m = v;
        }
      }
      dil[y * sw + x] = m;
    }
  }
  small = boxBlur(dil, sw, sh, 2);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const y0 = gy | 0;
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5));
      const x0 = gx | 0;
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = gx - x0;
      const bg =
        small[y0 * sw + x0] * (1 - fx) * (1 - fy) +
        small[y0 * sw + x1] * fx * (1 - fy) +
        small[y1 * sw + x0] * (1 - fx) * fy +
        small[y1 * sw + x1] * fx * fy;
      const i = y * w + x;
      out[i] = bg < 16 ? gray[i] : (gray[i] * 255) / bg;
    }
  }
  return out;
}

/** Seuillage adaptatif (méthode de Bradley) par image intégrale. */
export function adaptiveThreshold(gray: Uint8ClampedArray, w: number, h: number, t = 0.15): Uint8ClampedArray {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + rowSum;
    }
  }
  const r = Math.max(8, Math.round(Math.max(w, h) / 40));
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r);
    const yb = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r);
      const xb = Math.min(w, x + r + 1);
      const count = (yb - ya) * (xb - xa);
      const sum =
        integral[yb * (w + 1) + xb] - integral[ya * (w + 1) + xb] - integral[yb * (w + 1) + xa] + integral[ya * (w + 1) + xa];
      out[y * w + x] = gray[y * w + x] * count < sum * (1 - t) ? 0 : 255;
    }
  }
  return out;
}

/** Accentuation (masque flou) sur un canal. */
export function unsharp(channel: Uint8ClampedArray, w: number, h: number, amount = 0.8): Uint8ClampedArray {
  const blur = boxBlur(channel, w, h, 1);
  const out = new Uint8ClampedArray(channel.length);
  for (let i = 0; i < channel.length; i++) out[i] = channel[i] + amount * (channel[i] - blur[i]);
  return out;
}

function grayToRGBA(gray: Uint8ClampedArray, w: number, h: number): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    data[j] = data[j + 1] = data[j + 2] = gray[i];
    data[j + 3] = 255;
  }
  return { data, width: w, height: h };
}

export function applyFilter(img: RGBAImage, filter: FilterId, sharpen: boolean): RGBAImage {
  const { width: w, height: h } = img;
  if (filter === "color") {
    // étirement léger, identique sur les 3 canaux (préserve les couleurs)
    const gray = rgbaToGray(img.data, w, h);
    const [lo, hi] = percentiles(gray, 0.005, 0.995);
    const scale = hi - lo >= 10 ? 255 / (hi - lo) : 1;
    const offset = hi - lo >= 10 ? lo : 0;
    const data = new Uint8ClampedArray(img.data.length);
    for (let j = 0; j < data.length; j += 4) {
      data[j] = (img.data[j] - offset) * scale;
      data[j + 1] = (img.data[j + 1] - offset) * scale;
      data[j + 2] = (img.data[j + 2] - offset) * scale;
      data[j + 3] = 255;
    }
    if (!sharpen) return { data, width: w, height: h };
    for (let c = 0; c < 3; c++) {
      const ch = new Uint8ClampedArray(w * h);
      for (let i = 0; i < ch.length; i++) ch[i] = data[i * 4 + c];
      const s = unsharp(ch, w, h);
      for (let i = 0; i < ch.length; i++) data[i * 4 + c] = s[i];
    }
    return { data, width: w, height: h };
  }
  let gray = rgbaToGray(img.data, w, h);
  if (filter === "gray") {
    gray = autoLevels(gray, 0.005, 0.995);
    if (sharpen) gray = unsharp(gray, w, h);
    return grayToRGBA(gray, w, h);
  }
  gray = normalizeBackground(gray, w, h);
  if (sharpen) gray = unsharp(gray, w, h);
  if (filter === "enhanced") {
    return grayToRGBA(documentCurve(gray), w, h);
  }
  // noir et blanc
  return grayToRGBA(adaptiveThreshold(gray, w, h), w, h);
}

/** Taille de sortie : taille naturelle du recadrage, limitée à maxSide. */
export function outputSizeFor(params: Pick<ImageParams, "quad">, srcW: number, srcH: number, maxSide: number) {
  const q = params.quad ?? fullQuad(srcW, srcH);
  const { w, h } = quadOutputSize(q, srcW, srcH);
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { quad: q, w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** Chaîne complète : recadrage + perspective → rotation → filtre. */
export function processImage(src: RGBAImage, params: ImageParams, maxSide: number): RGBAImage {
  const { quad, w, h } = outputSizeFor(params, src.width, src.height, maxSide);
  const warped = warpPerspective(src, quad, w, h);
  const rotated = rotateImage(warped, params.rotation);
  return applyFilter(rotated, params.filter, params.sharpen);
}
