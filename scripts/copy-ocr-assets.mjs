// Copie les fichiers du moteur OCR (Tesseract.js) dans public/tesseract/ pour
// qu'ils soient servis par l'application elle-même : aucun CDN tiers, et le
// service worker peut les mettre en cache pour l'utilisation hors ligne.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "tesseract");

const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));

const files = [
  [join(pkgDir("tesseract.js"), "dist", "worker.min.js"), join(out, "worker.min.js")],
  // Mode LSTM uniquement : Tesseract.js choisit l'une de ces 3 variantes
  // selon le support SIMD du navigateur.
  ...["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"].map(
    (f) => [join(pkgDir("tesseract.js-core"), f), join(out, "core", f)],
  ),
  ...["fra", "eng"].map((lang) => [
    join(pkgDir(`@tesseract.js-data/${lang}`), "4.0.0_best_int", `${lang}.traineddata.gz`),
    join(out, "lang", `${lang}.traineddata.gz`),
  ]),
];

let copied = 0;
for (const [from, to] of files) {
  if (!existsSync(from)) {
    console.error(`[ocr-assets] fichier introuvable : ${from} (lancez npm install)`);
    process.exit(1);
  }
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  copied++;
}
console.log(`[ocr-assets] ${copied} fichier(s) copié(s), ${files.length - copied} déjà à jour.`);
