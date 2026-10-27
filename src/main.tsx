import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { initPwa } from "./lib/pwa";
import { initStore } from "./lib/store";
import { startProcessing } from "./lib/ocr/queue";
import { cleanupOldOcrCaches } from "./lib/offline";

initPwa();
void initStore().then(() => startProcessing());
void cleanupOldOcrCaches();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
