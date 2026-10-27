import { zlibSync } from "fflate";

/**
 * Encodeur PNG minimal pour une image en niveaux de gris (8 bits).
 * Utilisable dans un Web Worker (pas de canvas) : l'image préparée pour la
 * reconnaissance est encodée sur place, sans repasser par le thread principal.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export function encodeGrayPng(gray: Uint8Array | Uint8ClampedArray, w: number, h: number, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 = 3): Uint8Array {
  // filtre « Up » : les fonds blancs uniformes deviennent des zéros, très compressibles
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w + 1);
    const r = y * w;
    raw[o] = y ? 2 : 0;
    if (y) for (let x = 0; x < w; x++) raw[o + 1 + x] = (gray[r + x] - gray[r - w + x]) & 0xff;
    else for (let x = 0; x < w; x++) raw[o + 1 + x] = gray[x];
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 0; // niveaux de gris
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw, { level })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
