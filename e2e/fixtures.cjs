// Génère les fichiers de test : pages imprimées, photo de page en perspective,
// page blanche, image illisible, PDF texte, PDF scanné, flux caméra simulé.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, ".out", "fixtures");

const SENTENCES = [
  "La réunion du conseil s'est tenue le mardi matin dans la grande salle.",
  "Les membres ont approuvé le budget prévisionnel après une longue discussion.",
  "Le trésorier a présenté les comptes de l'exercice avec beaucoup de précision.",
  "Une nouvelle bibliothèque ouvrira ses portes au printemps prochain.",
  "Les enfants de l'école élémentaire ont visité le musée régional.",
  "La commission a recommandé de rénover la toiture du gymnase municipal.",
  "Plusieurs habitants ont signalé des difficultés de stationnement.",
  "Le marché hebdomadaire accueille désormais des producteurs locaux.",
  "Une campagne de plantation d'arbres sera organisée en novembre.",
  "Le service des eaux a remplacé les canalisations de la rue principale.",
];

function pageHtml(n, title) {
  const paras = [0, 1, 2].map((k) => SENTENCES[(n + k) % SENTENCES.length]);
  return `<html><body style="margin:0;background:#fff"><div style="padding:110px 120px;font:30px Georgia,serif;color:#111;line-height:1.5">
    <h1 style="font-size:52px;margin:0 0 40px">${title}</h1>
    <p>${paras[0]} Référence dossier ${String(1000 + n)}.</p>
    <p>${paras[1]}</p>
    <p>${paras[2]} Montant : ${(n * 137.5).toFixed(2).replace(".", ",")} €.</p>
  </div></body></html>`;
}

async function shot(browser, html, file, { width = 1240, height = 1754, type = "png", quality } = {}) {
  const p = await browser.newPage({ viewport: { width, height } });
  await p.setContent(html);
  await p.screenshot({ path: file, type, quality });
  await p.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  // 20 pages imprimées numérotées
  for (let n = 1; n <= 20; n++) await shot(browser, pageHtml(n, `Chapitre ${n}`), path.join(OUT, `page-${String(n).padStart(2, "0")}.png`), { type: "png" });

  // page blanche et image illisible (bruit)
  await shot(browser, `<html><body style="margin:0;background:#fdfdfb"></body></html>`, path.join(OUT, "blank.png"));
  await shot(
    browser,
    `<html><body style="margin:0"><canvas id=c width=1240 height=1754></canvas><script>
      const c=document.getElementById('c').getContext('2d');const d=c.createImageData(1240,1754);
      let s=7;for(let i=0;i<d.data.length;i+=4){s=(s*1103515245+12345)&0x7fffffff;const v=s%255;d.data[i]=d.data[i+1]=d.data[i+2]=v;d.data[i+3]=255}
      c.putImageData(d,0,0);</script></body></html>`,
    path.join(OUT, "noise.png"),
  );

  // « photo » d'une page posée sur une table, en perspective, avec un éclairage inégal
  const pagePng = fs.readFileSync(path.join(OUT, "page-01.png")).toString("base64");
  const photoHtml = (w, h) => `<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;
      background:radial-gradient(circle at 30% 20%,#7a5a3a,#3b2a1c 70%);perspective:1400px">
      <img src="data:image/png;base64,${pagePng}" style="position:absolute;left:50%;top:50%;width:${w * 0.62}px;
        transform:translate(-50%,-50%) rotateX(16deg) rotateZ(-6deg);box-shadow:0 30px 60px rgba(0,0,0,.6)">
      <div style="position:absolute;inset:0;background:linear-gradient(110deg,rgba(0,0,0,.25),rgba(0,0,0,0) 45%,rgba(255,255,255,.08))"></div>
    </body></html>`;
  await shot(browser, photoHtml(1500, 2000), path.join(OUT, "photo-perspective.jpg"), { width: 1500, height: 2000, type: "jpeg", quality: 90 });
  // feuille posée sur un tissu gris clair moucheté (fond proche du papier : cas difficile)
  const fabricHtml = (w, h) => `<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#b9b9b6;perspective:1500px">
      <svg width="${w}" height="${h}" style="position:absolute;inset:0"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3"/>
        <feColorMatrix type="matrix" values="0 0 0 0 0.78  0 0 0 0 0.78  0 0 0 0 0.76  0 0 0 1.6 -0.3"/></filter>
        <rect width="100%" height="100%" filter="url(#n)"/></svg>
      <img src="data:image/png;base64,${pagePng}" style="position:absolute;left:52%;top:53%;width:${w * 0.7}px;
        transform:translate(-50%,-50%) rotateX(12deg) rotateY(-6deg) rotateZ(3deg);box-shadow:0 12px 30px rgba(0,0,0,.35)">
      <div style="position:absolute;inset:0;background:radial-gradient(circle at 80% 90%,rgba(0,0,0,.18),rgba(0,0,0,0) 60%)"></div>
    </body></html>`;
  await shot(browser, fabricHtml(1200, 1600), path.join(OUT, "photo-fabric.jpg"), { width: 1200, height: 1600, type: "jpeg", quality: 88 });

  // flux caméra simulé (MJPEG = images JPEG concaténées), format portrait
  await shot(browser, photoHtml(960, 1280), path.join(OUT, "camera-frame.jpg"), { width: 960, height: 1280, type: "jpeg", quality: 92 });
  const frame = fs.readFileSync(path.join(OUT, "camera-frame.jpg"));
  fs.writeFileSync(path.join(OUT, "camera.mjpeg"), Buffer.concat([frame, frame, frame]));

  // PDF « numérique » (texte intégré) et PDF « scanné » (images seulement)
  const { PDFDocument, StandardFonts } = require(path.join(__dirname, "..", "node_modules", "pdf-lib"));
  const textPdf = await PDFDocument.create();
  const font = await textPdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 3; n++) {
    const pg = textPdf.addPage([595, 842]);
    pg.drawText(`Rapport PDF page ${n}`, { x: 60, y: 760, size: 22, font });
    pg.drawText(`Ligne exacte numéro ${n} : 1 234,56 € réglés le 0${n}/02/2026.`, { x: 60, y: 720, size: 12, font });
  }
  fs.writeFileSync(path.join(OUT, "text.pdf"), await textPdf.save());

  const scanPdf = await PDFDocument.create();
  for (const n of [4, 5]) {
    const img = await scanPdf.embedPng(fs.readFileSync(path.join(OUT, `page-${String(n).padStart(2, "0")}.png`)));
    const pg = scanPdf.addPage([595, 842]);
    pg.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  }
  fs.writeFileSync(path.join(OUT, "scanned.pdf"), await scanPdf.save());

  await browser.close();
  console.log("fixtures →", OUT);
})();
