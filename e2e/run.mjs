// Tests de bout en bout dans un vrai navigateur (Chromium via Playwright),
// sur la version de production servie par `vite preview`.
//
//   npm run build && npx vite preview --port 4173 &
//   node e2e/fixtures.cjs && node e2e/run.mjs
//
// Chaque scénario utilise un profil de navigateur neuf (stockage vide).
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { unzipSync, strFromU8 } = require("fflate");

const ROOT = dirname(fileURLToPath(import.meta.url));
const FX = join(ROOT, ".out", "fixtures");
const SHOTS = join(ROOT, ".out", "screens");
const BASE = process.env.BASE_URL ?? "http://localhost:4173/";
mkdirSync(SHOTS, { recursive: true });
if (!existsSync(join(FX, "page-01.png"))) {
  console.error("Fixtures manquantes : lancez d'abord `node e2e/fixtures.cjs`.");
  process.exit(1);
}
const fx = (name) => join(FX, name);
const pageFile = (n) => fx(`page-${String(n).padStart(2, "0")}.png`);

const results = [];
const only = process.argv.slice(2);
async function test(name, fn) {
  if (only.length && !only.some((o) => name.toLowerCase().includes(o.toLowerCase()))) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, err });
    console.log(`✘ ${name}\n   ${String(err?.stack ?? err).split("\n").slice(0, 4).join("\n   ")}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const browser = await chromium.launch();

async function newPage({ mobile = true, permissions = ["clipboard-read", "clipboard-write"], browserInstance = browser } = {}) {
  const context = await browserInstance.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    acceptDownloads: true,
    permissions,
    locale: "fr-FR",
  });
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/favicon/.test(m.text()) && page.errors.push(m.text()));
  await page.goto(BASE);
  await page.getByRole("heading", { name: "Du papier au texte modifiable" }).waitFor();
  return { context, page };
}

async function chooseFiles(page, trigger, files) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), trigger()]);
  await chooser.setFiles(files);
}

const button = (page, name) => page.getByRole("button", { name, exact: true }).first();

async function waitOcrDone(page, timeout = 240_000) {
  await page.getByText(/Reconnaissance terminée/).waitFor({ timeout });
}

const docIdFromUrl = (page) => decodeURIComponent(new URL(page.url()).hash.match(/#\/doc\/([^/?]+)/)?.[1] ?? "");

/** Lit les pages d'un document directement dans IndexedDB (ordre du document). */
async function dbPages(page, docId) {
  return page.evaluate(
    (docId) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("scantext");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction(["docs", "pages"]);
          const d = tx.objectStore("docs").get(docId);
          const all = tx.objectStore("pages").getAll();
          tx.oncomplete = () => {
            const byId = Object.fromEntries(all.result.map((p) => [p.id, p]));
            resolve(d.result.pageIds.map((id) => byId[id]));
          };
        };
      }),
    docId,
  );
}

async function clipboard(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

async function exportAs(page, formatLabel, { filename } = {}) {
  await page.getByRole("button", { name: "Exporter" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Exporter le document" });
  await dialog.waitFor();
  await dialog.getByText(formatLabel, { exact: true }).click();
  if (filename) await dialog.getByLabel("Nom du fichier").fill(filename);
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), dialog.getByRole("button", { name: "Télécharger" }).click()]);
  const path = join(ROOT, ".out", download.suggestedFilename());
  await download.saveAs(path);
  return { path, name: download.suggestedFilename(), bytes: readFileSync(path) };
}

async function pdfText(bytes) {
  const pdfjs = await import(join(ROOT, "..", "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs"));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const c = await p.getTextContent();
    pages.push(c.items.map((it) => it.str).join(" "));
  }
  return { numPages: doc.numPages, pages };
}

/** Boutons sans nom accessible (inutilisables au lecteur d'écran). */
async function unnamedButtons(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("button, [role=button]")]
      .filter((b) => b.offsetParent !== null)
      .filter((b) => !(b.getAttribute("aria-label") || b.getAttribute("aria-labelledby") || b.labels?.length || b.textContent.trim() || b.getAttribute("title")))
      .map((b) => b.outerHTML.slice(0, 120)),
  );
}

const norm = (s) => s.replace(/\s+/g, " ");

// ====================================================================== scénarios

let bigDoc = null; // partagé entre les scénarios 2 à 9

await test("1. Page imprimée → texte exploitable (OCR réel)", async () => {
  const { context, page } = await newPage();
  await chooseFiles(page, () => button(page, "Importer des photos").click(), [pageFile(1)]);
  await page.waitForURL(/#\/doc\//);
  await waitOcrDone(page, 120_000);
  const [p] = await dbPages(page, docIdFromUrl(page));
  assert(p.ocrStatus === "done", `statut ${p.ocrStatus}`);
  const t = norm(p.text);
  for (const s of ["Chapitre 1", "Les membres ont approuvé le budget prévisionnel", "Référence dossier 1001", "137,50 €"])
    assert(t.includes(s), `texte attendu absent : « ${s} » dans « ${t.slice(0, 200)} »`);
  assert(p.ocrConfidence >= 80, `confiance ${p.ocrConfidence}`);
  await page.screenshot({ path: join(SHOTS, "doc-1-page.png") });
  assert(!page.errors.length, `erreurs console : ${page.errors.join(" | ")}`);
  await context.close();
});

await test("2-3. 20 pages importées et réunies dans le bon ordre", async () => {
  const { context, page } = await newPage({ mobile: false });
  await chooseFiles(page, () => button(page, "Importer des photos").click(), Array.from({ length: 20 }, (_, i) => pageFile(i + 1)));
  await page.waitForURL(/#\/doc\//);
  await page.getByText(/sur 20 traitée/).first().waitFor({ timeout: 60_000 });
  await page.screenshot({ path: join(SHOTS, "doc-20-progress.png") });
  await waitOcrDone(page, 400_000);
  const docId = docIdFromUrl(page);
  const pages = await dbPages(page, docId);
  assert(pages.length === 20, `${pages.length} pages`);
  pages.forEach((p, i) => assert(norm(p.text).includes(`Chapitre ${i + 1}`), `page ${i + 1} : « ${p.text.slice(0, 40)} »`));
  await page.screenshot({ path: join(SHOTS, "doc-20-done.png") });
  bigDoc = { context, page, docId };
});

await test("4. Copier tout : les 20 pages en un clic, dans l'ordre", async () => {
  assert(bigDoc, "scénario 2 requis");
  const { page } = bigDoc;
  await button(page, "Copier tout").click();
  await page.getByText(/Texte copié : 20 pages/).waitFor();
  const text = await clipboard(page);
  let last = -1;
  for (let n = 1; n <= 20; n++) {
    const i = text.indexOf(`Chapitre ${n}\n`);
    assert(i > last, `Chapitre ${n} absent ou hors ordre`);
    last = i;
  }
  assert(text.includes("\n\n"), "paragraphes non séparés");
  // option : séparateurs de page
  await page.getByRole("button", { name: "Options de copie" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Options de copie" });
  await dlg.getByRole("switch", { name: "Conserver les séparateurs de pages" }).click();
  await dlg.getByRole("button", { name: "Copier tout" }).click();
  await page.getByText(/Texte copié : 20 pages/).first().waitFor();
  const withSep = await clipboard(page);
  assert(withSep.includes("——— Page 1 ———") && withSep.includes("——— Page 20 ———"), "séparateurs absents");
});

await test("5-6. Modifier le texte, actualiser : corrections conservées", async () => {
  assert(bigDoc, "scénario 2 requis");
  const { page, docId } = bigDoc;
  await page.goto(`${BASE}#/doc/${docId}/text`);
  const area = page.getByRole("textbox", { name: "Texte de la page 3" });
  await area.waitFor();
  await area.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\nNote ajoutée à la main : vérifié le 27/10.");
  await page.getByText("Enregistré", { exact: true }).waitFor();
  await page.reload();
  const after = page.getByRole("textbox", { name: "Texte de la page 3" });
  await after.waitFor();
  const v = await after.inputValue();
  assert(v.includes("Note ajoutée à la main : vérifié le 27/10."), "correction perdue après actualisation");
  const [, , p3] = await dbPages(page, docId);
  assert(p3.edited === true, "page non marquée comme corrigée");
  // recherche insensible aux accents
  await page.getByRole("button", { name: "Rechercher dans le texte" }).click();
  await page.getByPlaceholder(/Rechercher/).fill("ajoutee a la main");
  await page.getByText("1/1").waitFor();
  await page.screenshot({ path: join(SHOTS, "editor-search.png") });
});

await test("Relancer l'OCR d'une page corrigée : la correction n'est jamais écrasée", async () => {
  assert(bigDoc, "scénario 2 requis");
  const { page, docId } = bigDoc;
  const pages = await dbPages(page, docId);
  await page.goto(`${BASE}#/doc/${docId}/page/${pages[2].id}`);
  const textTab = page.getByRole("radio", { name: "Texte", exact: true });
  if (await textTab.isVisible()) await textTab.click(); // onglet présent seulement sur téléphone
  await page.getByRole("button", { name: "Relancer" }).click();
  await page.getByText("Une nouvelle reconnaissance est disponible").waitFor({ timeout: 60_000 });
  let p3 = (await dbPages(page, docId))[2];
  assert(p3.text.includes("Note ajoutée à la main"), "correction écrasée");
  assert(p3.ocrStatus === "review" && p3.pendingText, "proposition non enregistrée");
  await page.getByRole("button", { name: "Garder ma version" }).click();
  await page.getByText("Votre version a été conservée.").waitFor();
  p3 = (await dbPages(page, docId))[2];
  assert(p3.text.includes("Note ajoutée à la main") && p3.pendingText === null && p3.ocrStatus === "done", "décision non appliquée");
});

await test("11. Supprimer une page et réordonner les autres", async () => {
  assert(bigDoc, "scénario 2 requis");
  const { page, docId } = bigDoc;
  await page.goto(`${BASE}#/doc/${docId}`);
  await button(page, "Réorganiser").click();
  await page.getByRole("button", { name: "Déplacer la page 2 vers la fin" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Supprimer la page 1", exact: true }).click();
  await page.getByRole("dialog", { name: "Supprimer la page 1 ?" }).getByRole("button", { name: "Supprimer" }).click();
  await page.getByText("Page supprimée.").waitFor();
  await button(page, "Terminé").click();
  const pages = await dbPages(page, docId);
  assert(pages.length === 19, `${pages.length} pages`);
  const firsts = pages.slice(0, 3).map((p) => p.text.match(/Chapitre \d+/)?.[0]);
  assert(firsts.join(",") === "Chapitre 3,Chapitre 2,Chapitre 4", `ordre obtenu : ${firsts}`);
  await page.screenshot({ path: join(SHOTS, "doc-reordered.png") });
});

await test("7. Export TXT : contenu vérifié", async () => {
  assert(bigDoc, "scénario 2 requis");
  const { page, docId } = bigDoc;
  await page.goto(`${BASE}#/doc/${docId}`);
  const { name, bytes } = await exportAs(page, "Texte brut (.txt)", { filename: "Mon export" });
  assert(name === "Mon export.txt", `nom ${name}`);
  const text = bytes.toString("utf8");
  assert(text.startsWith("﻿"), "BOM UTF-8 absent");
  assert(text.indexOf("Chapitre 3") < text.indexOf("Chapitre 2") && text.includes("Chapitre 20"), "ordre/contenu TXT incorrect");
  assert(text.includes("Note ajoutée à la main"), "correction absente du TXT");
  assert(text.includes("——— Page 1 ———"), "repères de page absents (option activée)");
});

await test("8. Export DOCX : document Word valide et modifiable", async () => {
  assert(bigDoc, "scénario 2 requis");
  const { page } = bigDoc;
  for (const mode of ["Texte simple", "Mise en page approchée"]) {
    await page.getByRole("button", { name: "Exporter" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Exporter le document" });
    await dialog.getByText("Word (.docx)", { exact: true }).click();
    await dialog.getByRole("radio", { name: mode }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Télécharger" }).click()]);
    const path = join(ROOT, ".out", `export-${mode === "Texte simple" ? "simple" : "layout"}.docx`);
    await download.saveAs(path);
    const files = unzipSync(new Uint8Array(readFileSync(path)));
    assert(files["word/document.xml"] && files["[Content_Types].xml"], "structure DOCX invalide");
    const xml = strFromU8(files["word/document.xml"]);
    assert(xml.includes("Chapitre 20") && xml.includes("Note ajoutée à la main"), `texte absent du DOCX (${mode})`);
    assert(/w:pageBreakBefore/.test(xml), `sauts de page absents (${mode})`);
    if (mode !== "Texte simple") assert(/<w:b\/>|<w:b /.test(xml), "titres non mis en gras en mise en page approchée");
  }
});

await test("9. Export PDF texte + PDF recherchable : fichiers valides, texte sélectionnable", async () => {
  assert(bigDoc, "scénario 2 requis");
  const { page } = bigDoc;
  const plain = await exportAs(page, "PDF du texte");
  assert(plain.bytes.subarray(0, 5).toString() === "%PDF-", "PDF invalide");
  const t1 = await pdfText(plain.bytes);
  assert(t1.numPages >= 19, `${t1.numPages} pages`);
  assert(norm(t1.pages.join(" ")).includes("Chapitre 3"), "texte absent du PDF");
  const ocr = await exportAs(page, "PDF recherchable");
  const t2 = await pdfText(ocr.bytes);
  assert(t2.numPages === 19, `PDF recherchable : ${t2.numPages} pages`);
  const first = norm(t2.pages[0]);
  assert(first.includes("Chapitre") && first.includes("3"), `couche texte page 1 : « ${first.slice(0, 120)} »`);
  assert(norm(t2.pages[1]).includes("membres") || norm(t2.pages[1]).length > 50, "couche texte page 2 vide");
  assert(ocr.bytes.length > 300_000, "images absentes du PDF recherchable");
  await bigDoc.context.close();
  bigDoc = null;
});

await test("10. Import PDF : texte intégré utilisé tel quel + PDF scanné reconnu par OCR", async () => {
  const { context, page } = await newPage();
  await chooseFiles(page, () => button(page, "Importer un PDF").click(), [fx("text.pdf")]);
  await page.getByRole("dialog", { name: "Ce PDF contient déjà du texte" }).waitFor();
  await page.getByRole("button", { name: /Utiliser le texte du PDF/ }).click();
  await page.waitForURL(/#\/doc\//);
  await waitOcrDone(page, 60_000);
  const docId = docIdFromUrl(page);
  let pages = await dbPages(page, docId);
  assert(pages.length === 3, `${pages.length} pages`);
  assert(pages[1].textSource === "pdf", "texte PDF non utilisé");
  assert(pages[1].text.includes("Ligne exacte numéro 2 : 1 234,56 € réglés le 02/02/2026."), `texte PDF : « ${pages[1].text} »`);
  // ajout d'un PDF scanné au même document
  await chooseFiles(page, () => button(page, "Ajouter des pages").click().then(() => page.getByRole("dialog").getByRole("button", { name: "PDF" }).click()), [fx("scanned.pdf")]);
  await page.getByText(/sur 5 traitée|Reconnaissance terminée · 5 pages/).first().waitFor({ timeout: 60_000 });
  await waitOcrDone(page, 120_000);
  pages = await dbPages(page, docId);
  assert(pages.length === 5, `${pages.length} pages après ajout`);
  assert(pages[3].textSource === "ocr" && norm(pages[3].text).includes("Chapitre 4"), `OCR PDF scanné : « ${pages[3].text.slice(0, 60)} »`);
  await context.close();
});

await test("12. Interrompre la reconnaissance (pause, rechargement) puis reprendre", async () => {
  const { context, page } = await newPage();
  await chooseFiles(page, () => button(page, "Importer des photos").click(), [1, 2, 3, 4, 5, 6].map(pageFile));
  await page.waitForURL(/#\/doc\//);
  const docId = docIdFromUrl(page);
  await page.getByText(/^Page \d+ · Reconnaissance du texte/).waitFor({ timeout: 60_000 });
  await button(page, "Pause").click();
  await page.getByText(/En pause : la reconnaissance reprendra/).waitFor();
  let pages = await dbPages(page, docId);
  assert(!pages.some((p) => p.ocrStatus === "processing"), "une page est restée « en cours » après la pause");
  const doneAtPause = pages.filter((p) => p.ocrStatus === "done").length;
  assert(doneAtPause < 6, "tout était déjà terminé avant la pause");
  await button(page, "Reprendre").click();
  await page.getByText(/^Page \d+ · /).waitFor({ timeout: 30_000 });
  // fermeture brutale en plein traitement
  await page.reload();
  await page.getByText(/sur 6 traitée|Reconnaissance terminée/).first().waitFor();
  await waitOcrDone(page, 180_000);
  pages = await dbPages(page, docId);
  assert(pages.every((p) => p.ocrStatus === "done" && p.text.includes("Chapitre")), "reprise incomplète");
  await context.close();
});

await test("14. Page blanche et image illisible : signalées, aucun texte inventé", async () => {
  const { context, page } = await newPage();
  await chooseFiles(page, () => button(page, "Importer des photos").click(), [fx("blank.png"), fx("noise.png")]);
  await page.waitForURL(/#\/doc\//);
  await waitOcrDone(page, 120_000);
  const [blank, noise] = await dbPages(page, docIdFromUrl(page));
  assert(blank.blank && blank.text === "", `page blanche : blank=${blank.blank} texte=« ${blank.text} »`);
  assert(noise.blank || noise.ocrStatus === "review", `bruit : statut ${noise.ocrStatus}, texte « ${noise.text.slice(0, 60)} »`);
  await page.getByText("Page vide").first().waitFor();
  await page.screenshot({ path: join(SHOTS, "doc-blank-noise.png") });
  await context.close();
});

// ---------------------------------------------------------------- caméra

const camBrowser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${fx("camera.mjpeg")}`],
});

await test("13. Accès caméra refusé : message clair + solutions de repli", async () => {
  const { context, page } = await newPage({ browserInstance: camBrowser, permissions: [] });
  await context.clearPermissions();
  await page.evaluate(() => {
    // refus explicite de l'utilisateur
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("refus", "NotAllowedError"));
  });
  await button(page, "Scanner avec la caméra").click();
  await page.getByText("Accès à la caméra refusé").waitFor();
  for (const name of ["Appareil photo du téléphone", "Importer des photos", "Réessayer"]) assert(await button(page, name).isVisible(), `bouton absent : ${name}`);
  await page.screenshot({ path: join(SHOTS, "scan-denied.png") });
  // la solution de repli fonctionne réellement
  await chooseFiles(page, () => button(page, "Importer des photos").click(), [pageFile(2)]);
  await page.waitForURL(/#\/doc\//);
  await context.close();
});

await test("Scan caméra multi-pages : détection des bords, perspective, OCR", async () => {
  const { context, page } = await newPage({ browserInstance: camBrowser, permissions: ["camera", "clipboard-read", "clipboard-write"] });
  await button(page, "Scanner avec la caméra").click();
  const shutter = page.getByRole("button", { name: "Prendre la photo" });
  await shutter.waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Prendre la photo"]').disabled, null, { timeout: 15_000 });
  await page.waitForTimeout(900); // laisse la détection en direct s'afficher
  await page.screenshot({ path: join(SHOTS, "scan-live.png") });
  for (let n = 1; n <= 3; n++) {
    await shutter.click();
    await page.getByRole("dialog", { name: "Vérifier la page" }).waitFor();
    await page.getByRole("img", { name: "Aperçu de la page recadrée" }).waitFor();
    if (n === 1) await page.screenshot({ path: join(SHOTS, "scan-review.png") });
    if (n === 2) {
      // recadrage manuel puis retour
      await button(page, "Recadrer").click();
      await page.getByRole("slider", { name: "Coin haut gauche" }).waitFor();
      await page.screenshot({ path: join(SHOTS, "scan-crop.png") });
      await button(page, "Valider le cadre").click();
    }
    await button(page, "Valider · page suivante").click();
    await page.getByText(`${n} page${n > 1 ? "s" : ""} scannée`).waitFor();
  }
  // visionneuse : page précédente / suivante, suppression
  await page.getByRole("button", { name: "Voir la page scannée 3" }).click();
  await page.getByText("Page 3 / 3").waitFor();
  await button(page, "Page précédente").click();
  await page.getByText("Page 2 / 3").waitFor();
  await button(page, "Supprimer").click();
  await page.getByRole("dialog", { name: "Supprimer cette page ?" }).getByRole("button", { name: "Supprimer" }).click();
  await page.getByText("2 pages scannées").waitFor();
  await page.getByRole("button", { name: "Retour à la caméra" }).click();
  await button(page, "Terminer").click();
  await page.waitForURL(/#\/doc\//);
  await waitOcrDone(page, 120_000);
  const pages = await dbPages(page, docIdFromUrl(page));
  assert(pages.length === 2, `${pages.length} pages`);
  const p = pages[0];
  assert(p.quad, "contours du document non détectés");
  const ratio = p.procH / p.procW;
  assert(Math.abs(ratio - 1754 / 1240) < 0.08, `proportions après redressement : ${ratio.toFixed(2)} (attendu ≈ 1,41)`);
  const t = norm(p.text);
  assert(t.includes("Chapitre 1") && t.includes("bibliothèque"), `OCR photo caméra : « ${t.slice(0, 160)} »`);
  await page.screenshot({ path: join(SHOTS, "scan-result-doc.png") });
  await context.close();
});

await test("Photo en perspective importée : recadrage automatique + OCR", async () => {
  const { context, page } = await newPage();
  await chooseFiles(page, () => button(page, "Importer des photos").click(), [fx("photo-perspective.jpg")]);
  await page.waitForURL(/#\/doc\//);
  await waitOcrDone(page, 120_000);
  const [p] = await dbPages(page, docIdFromUrl(page));
  assert(p.quad, "contours non détectés");
  const ratio = p.procH / p.procW;
  assert(Math.abs(ratio - 1754 / 1240) < 0.08, `proportions après redressement : ${ratio.toFixed(2)} (attendu ≈ 1,41)`);
  const t = norm(p.text);
  assert(t.includes("Référence dossier 1001") && t.includes("137,50"), `OCR : « ${t.slice(0, 200)} »`);
  await page.goto(`${BASE}#/doc/${docIdFromUrl(page)}/page/${p.id}`);
  await page.getByRole("img", { name: "Page 1" }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, "page-perspective-corrected.png") });
  await context.close();
});

await camBrowser.close();

// ---------------------------------------------------------------- mobile étroit + boutons

await test("15 + 17. Écran mobile étroit (360 px) : pas de débordement, boutons nommés", async () => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(BASE);
  await chooseFiles(page, () => button(page, "Importer des photos").click(), [pageFile(1), pageFile(2)]);
  await page.waitForURL(/#\/doc\//);
  await waitOcrDone(page, 120_000);
  const docId = docIdFromUrl(page);
  const screens = [
    ["home", ""],
    ["documents", "#/documents"],
    ["settings", "#/settings"],
    ["document", `#/doc/${docId}`],
    ["editor", `#/doc/${docId}/text`],
  ];
  const problems = [];
  for (const [name, hash] of screens) {
    await page.goto(BASE + hash);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) problems.push(`${name} : défilement horizontal de ${overflow} px`);
    const unnamed = await unnamedButtons(page);
    if (unnamed.length) problems.push(`${name} : boutons sans nom ${unnamed.join(" ; ")}`);
    await page.screenshot({ path: join(SHOTS, `mobile360-${name}.png`) });
  }
  await page.goto(`${BASE}#/doc/${docId}`);
  await page.getByRole("button", { name: "Exporter" }).first().click();
  await page.getByRole("dialog", { name: "Exporter le document" }).waitFor();
  await page.screenshot({ path: join(SHOTS, "mobile360-export.png") });
  assert(!problems.length, problems.join("\n"));
  await context.close();
});

// ---------------------------------------------------------------- hors ligne

await test("16. Hors ligne : l'application s'ouvre, documents et OCR disponibles", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload(); // la page est désormais contrôlée par le service worker
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  // un premier usage en ligne télécharge le moteur OCR et la langue
  await chooseFiles(page, () => button(page, "Importer des photos").click(), [pageFile(6)]);
  await page.waitForURL(/#\/doc\//);
  await waitOcrDone(page, 120_000);
  await page.goto(`${BASE}#/settings`);
  await page.getByText(/Reconnaissance \(Français\) : disponible hors ligne/).waitFor({ timeout: 10_000 });
  await page.getByText(/Interface : disponible hors ligne/).waitFor();

  await context.setOffline(true);
  await page.goto(`${BASE}#/documents`);
  await page.reload();
  await page.getByRole("heading", { name: "Mes documents" }).waitFor();
  await page.getByText("Chapitre 6").or(page.getByText(/page-06/)).first().waitFor();
  // nouvelle reconnaissance entièrement hors ligne (worker relancé après rechargement)
  await page.goto(BASE);
  await chooseFiles(page, () => button(page, "Importer des photos").click(), [pageFile(7)]);
  await page.waitForURL(/#\/doc\//);
  await waitOcrDone(page, 120_000);
  const [p] = await dbPages(page, docIdFromUrl(page));
  assert(norm(p.text).includes("Chapitre 7"), `OCR hors ligne : « ${p.text.slice(0, 60)} »`);
  // export hors ligne (modules pré-cachés)
  const { bytes } = await exportAs(page, "Word (.docx)");
  assert(unzipSync(new Uint8Array(bytes))["word/document.xml"], "export DOCX hors ligne invalide");
  await context.close();
});

await test("Sauvegarde .zip puis restauration du projet", async () => {
  const { context, page } = await newPage();
  await chooseFiles(page, () => button(page, "Importer des photos").click(), [pageFile(8), pageFile(9)]);
  await page.waitForURL(/#\/doc\//);
  await waitOcrDone(page, 120_000);
  await page.getByRole("button", { name: "Plus d'actions" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Sauvegarder le projet (.zip)" }).click()]);
  const zipPath = join(ROOT, ".out", "backup.scantext.zip");
  await download.saveAs(zipPath);
  await page.goto(`${BASE}#/documents`);
  await chooseFiles(page, () => button(page, "Restaurer").click(), [zipPath]);
  await page.getByText(/Projet restauré/).waitFor();
  await page.waitForURL(/#\/doc\//);
  const pages = await dbPages(page, docIdFromUrl(page));
  assert(pages.length === 2 && pages[1].text.includes("Chapitre 9"), "restauration incomplète");
  await context.close();
});

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scénarios réussis.`);
if (failed.length) {
  for (const f of failed) console.log(` - ${f.name}`);
  process.exit(1);
}
