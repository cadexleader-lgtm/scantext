// Banc de précision de la reconnaissance.
//
//   npm run bench            (toutes les pages)
//   npm run bench -- tableau (seulement les cas dont le nom contient « tableau »)
//
// Des pages de test au texte connu sont générées (navigateur Chromium), avec
// les défauts d'une vraie photo : inclinaison, courbure, flou, basse
// résolution, trait parasite, tableaux. Chacune passe dans la chaîne d'origine
// (image telle quelle) puis dans la chaîne actuelle de l'application
// (redressement, préparation, seconde passe, tableaux). Résultat : taux de mots
// erronés (WER) et, pour les tableaux, part des cases exactes.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(HERE, ".out");
mkdirSync(OUT, { recursive: true });

const PARAGRAPHS = [
  "La réunion du conseil s'est tenue le mardi matin dans la grande salle de la mairie. Les membres ont approuvé le budget prévisionnel après une longue discussion sur les travaux de voirie.",
  "Le trésorier a présenté les comptes de l'exercice avec beaucoup de précision : les dépenses de fonctionnement ont baissé de 4,5 % tandis que les recettes ont progressé.",
  "Une nouvelle bibliothèque ouvrira ses portes au printemps prochain. Les enfants de l'école élémentaire ont déjà proposé des noms pour la salle de lecture.",
  "Plusieurs habitants ont signalé des difficultés de stationnement près du marché hebdomadaire, qui accueille désormais une vingtaine de producteurs locaux.",
];
const TABLE = [
  ["Désignation", "Quantité", "Prix unitaire", "Total"],
  ["Ramette papier A4", "12", "4,50 €", "54,00 €"],
  ["Cartouche encre noire", "3", "29,90 €", "89,70 €"],
  ["Classeur à levier", "20", "2,15 €", "43,00 €"],
];

const CASES = [
  { name: "Page nette", kind: "text" },
  { name: "Photo penchée (2°) et bombée", kind: "text", angle: 2, curve: 22, blur: 0.7 },
  { name: "Basse résolution (≈ 110 dpi), floue", kind: "text", scale: 0.45, blur: 0.5 },
  { name: "Trait parasite en travers du texte", kind: "text", stray: true, angle: -0.8 },
  { name: "Facture : tableau à traits", kind: "table", angle: 1, curve: 8 },
];

/** Génère une page (pixels RGBA) dans le navigateur. */
async function renderCase(browser, c) {
  const page = await browser.newPage();
  const res = await page.evaluate(
    ({ c, PARAGRAPHS, TABLE }) => {
      const W = 1700;
      const H = 2200;
      const cv = document.createElement("canvas");
      cv.width = W;
      cv.height = H;
      const g = cv.getContext("2d");
      g.fillStyle = "#fdfdfb";
      g.fillRect(0, 0, W, H);
      g.fillStyle = "#151515";
      g.strokeStyle = "#151515";
      const lines = [];
      let y = 170;
      g.font = "bold 46px 'Times New Roman'";
      g.fillText("Compte rendu de séance", 150, y);
      lines.push("Compte rendu de séance");
      y += 90;
      g.font = "31px 'Times New Roman'";
      if (c.kind === "text") {
        for (const p of PARAGRAPHS) {
          let line = "";
          for (const word of p.split(" ")) {
            const t = line ? `${line} ${word}` : word;
            if (g.measureText(t).width > W - 300) {
              g.fillText(line, 150, y);
              lines.push(line);
              y += 46;
              line = word;
            } else line = t;
          }
          g.fillText(line, 150, y);
          lines.push(line);
          y += 76;
        }
      } else {
        const xs = [150, 700, 950, 1270, 1560];
        g.lineWidth = 3;
        TABLE.forEach((row, r) => {
          row.forEach((t, k) => {
            g.font = `${r ? "" : "bold "}31px 'Times New Roman'`;
            g.fillText(t, xs[k] + 18, y + r * 74 + 50);
          });
        });
        for (let r = 0; r <= TABLE.length; r++) {
          g.beginPath();
          g.moveTo(xs[0], y + r * 74);
          g.lineTo(xs[4], y + r * 74);
          g.stroke();
        }
        for (const x of xs) {
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x, y + TABLE.length * 74);
          g.stroke();
        }
      }
      if (c.stray) {
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(90, 1100);
        g.lineTo(620, 120);
        g.stroke();
      }
      // défauts de prise de vue : rotation, courbure, flou, bruit, réduction
      const src = g.getImageData(0, 0, W, H).data;
      const out = new Uint8ClampedArray(W * H * 4);
      const a = ((c.angle ?? 0) * Math.PI) / 180;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const curve = c.curve ?? 0;
      let seed = 11;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      for (let yy = 0; yy < H; yy++)
        for (let xx = 0; xx < W; xx++) {
          const yc = yy - curve * ((xx - W / 2) / (W / 2)) ** 2 * (1 - yy / H);
          const sx = Math.round(W / 2 + (xx - W / 2) * ca - (yc - H / 2) * sa);
          const sy = Math.round(H / 2 + (xx - W / 2) * sa + (yc - H / 2) * ca);
          const k = (yy * W + xx) * 4;
          const n = (rnd() - 0.5) * 18;
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) {
            out[k] = out[k + 1] = out[k + 2] = 240 + n;
          } else {
            const s = (sy * W + sx) * 4;
            out[k] = src[s] + n;
            out[k + 1] = src[s + 1] + n;
            out[k + 2] = src[s + 2] + n;
          }
          out[k + 3] = 255;
        }
      g.putImageData(new ImageData(out, W, H), 0, 0);
      let fin = cv;
      if (c.blur) {
        const b = document.createElement("canvas");
        b.width = W;
        b.height = H;
        const bg = b.getContext("2d");
        bg.filter = `blur(${c.blur}px)`;
        bg.drawImage(cv, 0, 0);
        fin = b;
      }
      if (c.scale) {
        const s = document.createElement("canvas");
        s.width = Math.round(W * c.scale);
        s.height = Math.round(H * c.scale);
        const sg = s.getContext("2d");
        sg.imageSmoothingQuality = "high";
        sg.drawImage(fin, 0, 0, s.width, s.height);
        fin = s;
      }
      const d = fin.getContext("2d").getImageData(0, 0, fin.width, fin.height).data;
      let bin = "";
      for (let i = 0; i < d.length; i += 0x8000) bin += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
      return { w: fin.width, h: fin.height, px: btoa(bin), truth: lines.join("\n") };
    },
    { c, PARAGRAPHS, TABLE },
  );
  await page.close();
  const data = new Uint8ClampedArray(Buffer.from(res.px, "base64"));
  return { image: { data, width: res.w, height: res.h }, truth: c.kind === "table" ? TABLE.map((r) => r.join("\t")).join("\n") : res.truth };
}

const tokens = (s) =>
  s
    .toLowerCase()
    .replace(/[—–]/g, " ")
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}%€,' ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
function wer(ref, hyp) {
  const a = tokens(ref);
  const b = tokens(hyp);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] / a.length;
}
/** Part des cases du tableau retrouvées exactement, à leur place. */
function cellScore(truth, text) {
  const want = truth.split("\n").map((r) => r.split("\t"));
  const got = text.split("\n").filter((l) => l.includes("\t")).map((r) => r.split("\t").map((c) => c.trim().replace(/\s+/g, " ")));
  let ok = 0;
  let n = 0;
  want.forEach((row) => {
    const match = got.find((g) => g[0] === row[0]) ?? [];
    row.forEach((cell, k) => {
      n++;
      if (match[k] === cell) ok++;
    });
  });
  return ok / n;
}

const only = process.argv.slice(2).map((s) => s.toLowerCase());
const cases = CASES.filter((c) => !only.length || only.some((o) => c.name.toLowerCase().includes(o)));
const entry = join(OUT, "pipeline.mjs");
await build({ entryPoints: [join(HERE, "pipeline.ts")], bundle: true, platform: "node", format: "esm", outfile: entry, external: ["tesseract.js"], logLevel: "warning" });
const { createEngine, recognize } = await import(pathToFileURL(entry).href);

const browser = await chromium.launch();
const engine = await createEngine(ROOT, process.env.BENCH_LANG ?? "fra+eng");
const pct = (v) => `${(v * 100).toFixed(1).padStart(5)} %`;
console.log(`${"Cas".padEnd(40)} ${"avant".padStart(9)} ${"maintenant".padStart(11)}   durée`);
for (const c of cases) {
  const { image, truth } = await renderCase(browser, c);
  const score = (text) => (c.kind === "table" ? 1 - cellScore(truth, text) : wer(truth, text));
  const before = await recognize(engine, { ...image, data: image.data.slice() }, { improved: false });
  const after = await recognize(engine, { ...image, data: image.data.slice() }, { improved: true });
  const label = c.kind === "table" ? `${c.name} (cases fausses)` : c.name;
  console.log(`${label.padEnd(40)} ${pct(score(before.text)).padStart(9)} ${pct(score(after.text)).padStart(11)}   ${(after.ms / 1000).toFixed(1)} s`);
  if (process.env.VERBOSE) console.log(after.text, "\n");
}
await engine.terminate();
await browser.close();
