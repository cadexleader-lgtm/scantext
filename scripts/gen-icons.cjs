// Génère les icônes PNG de la PWA à partir d'un SVG (via le Chromium de Playwright).
// Usage : node scripts/gen-icons.cjs  (à relancer seulement si le logo change)
const { chromium } = require("playwright");
const path = require("path");

const logo = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" ${pad ? "" : 'rx="14"'} fill="#1e3a8a"/>
  <g transform="${pad ? "translate(9.6 9.6) scale(0.7)" : ""}">
  <path d="M20 14h17l9 9v25a2 2 0 0 1-2 2H20a2 2 0 0 1-2-2V16a2 2 0 0 1 2-2z" fill="#fff"/>
  <path d="M37 14v9h9" fill="#bfdbfe"/>
  <rect x="23" y="29" width="18" height="3" rx="1.5" fill="#2563eb"/>
  <rect x="23" y="35" width="14" height="3" rx="1.5" fill="#2563eb"/>
  <rect x="23" y="41" width="16" height="3" rx="1.5" fill="#2563eb"/>
  <path d="M10 24v-8a6 6 0 0 1 6-6h4M54 24v-8a6 6 0 0 0-6-6h-1M10 40v8a6 6 0 0 0 6 6h4M54 40v8a6 6 0 0 1-6 6h-4" stroke="#93c5fd" stroke-width="3" fill="none" stroke-linecap="round"/>
  </g></svg>`;

(async () => {
  const browser = await chromium.launch();
  const out = path.join(__dirname, "..", "public", "icons");
  const jobs = [
    ["icon-192.png", 192, false],
    ["icon-512.png", 512, false],
    ["maskable-512.png", 512, true],
    ["apple-touch-icon.png", 180, true],
  ];
  for (const [name, size, pad] of jobs) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0;background:transparent">${logo(pad).replace("<svg", `<svg width="${size}" height="${size}"`)}</body></html>`);
    await page.screenshot({ path: path.join(out, name), omitBackground: !pad });
    await page.close();
  }
  await browser.close();
  console.log("icônes générées");
})();
