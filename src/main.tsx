// First: the saved settings get Quire's names before any module reads them.
import "./lib/formerly";
import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/rajdhani/700.css";
import "@fontsource/share-tech-mono/400.css";
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import "@fontsource/quicksand/600.css";
import "@fontsource/quicksand/700.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/orbitron/500.css";
import "@fontsource/orbitron/700.css";
// Scrapbook's lettering.
import "@fontsource/bangers/400.css";
import "@fontsource/chakra-petch/700.css";
import "@fontsource/chakra-petch/700-italic.css";
import "@fontsource/caveat/500.css";
import "@fontsource/caveat/600.css";
import "@fontsource/caveat/700.css";
import "@fontsource/pacifico/400.css";
import "@fontsource/permanent-marker/400.css";
import "./themes/base.css";
import "./themes/cp2077.css";
import "./themes/ghost.css";
import "./themes/cozy.css";
import "./themes/midnight.css";
import "./themes/sunset.css";
import "./themes/gallery.css";
import "./themes/manga.css";
import "./app.css";
import App from "./App";
import { applyLook, loadModeId, loadThemeId } from "./themes";

async function bootstrap() {
  // `?mock` on the Vite dev server runs the UI in a plain browser (see README).
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    await import("./dev/mock");
  }
  applyLook(loadThemeId(), loadModeId());

  // The app is keyboard driven; the browser context menu only gets in the way.
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
