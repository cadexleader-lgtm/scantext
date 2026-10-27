import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { createRequire } from "node:module";
import { APP_DESCRIPTION, APP_NAME, BACKGROUND_COLOR, THEME_COLOR } from "./src/config";

const require = createRequire(import.meta.url);
const tesseractVersion: string = require("tesseract.js/package.json").version;

/** Remplace les marqueurs %APP_NAME% etc. dans index.html. */
function htmlBranding(): Plugin {
  return {
    name: "html-branding",
    transformIndexHtml: (html) =>
      html
        .replaceAll("%APP_NAME%", APP_NAME)
        .replaceAll("%APP_DESCRIPTION%", APP_DESCRIPTION)
        .replaceAll("%THEME_COLOR%", THEME_COLOR),
  };
}

export default defineConfig({
  // Chemins relatifs : l'application fonctionne aussi dans un sous-dossier
  // (ex. GitHub Pages) grâce au routage par ancre (#/...).
  base: "./",
  define: {
    __OCR_CACHE__: JSON.stringify(`scantext-ocr-${tesseractVersion}`),
    __TESSERACT_VERSION__: JSON.stringify(tesseractVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
    htmlBranding(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["favicon.svg", "icons/*.png"],
      manifest: {
        name: APP_NAME,
        short_name: APP_NAME,
        description: APP_DESCRIPTION,
        lang: "fr",
        dir: "ltr",
        start_url: "./",
        scope: "./",
        display: "standalone",
        orientation: "any",
        background_color: BACKGROUND_COLOR,
        theme_color: THEME_COLOR,
        categories: ["productivity", "utilities"],
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Coquille de l'application + modules chargés à la demande (PDF, DOCX…)
        // pré-cachés : l'interface et les exports fonctionnent hors ligne.
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,webmanifest}"],
        // Les fichiers OCR (~4 Mo par appareil) ne sont mis en cache qu'au
        // premier usage, pour ne pas imposer 16 Mo de téléchargement à l'installation.
        globIgnores: ["tesseract/**"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes("/tesseract/"),
            handler: "CacheFirst",
            options: {
              cacheName: `scantext-ocr-${tesseractVersion}`,
              expiration: { maxEntries: 16 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: { format: "es" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
});
