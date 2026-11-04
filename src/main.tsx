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
  // `?mock` on the Vite dev server runs the UI in a plain browser (see docs/development.md); the web
  // demo, a build made with VITE_DEMO (demo/web.mjs), always does, on the example library.
  if ((import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) || import.meta.env.VITE_DEMO) {
    await import("./dev/mock");
  }
  applyLook(loadThemeId(), loadModeId());

  // The app is keyboard driven; the browser context menu only gets in the way.
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  // A board in a window of its own (scrapbook/boardWindow) shows only the board.
  const q = new URLSearchParams(location.search);
  const board = q.get("board");
  const { BoardWindow } = board ? await import("./screens/BoardWindow") : { BoardWindow: null };
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>{BoardWindow && board ? <BoardWindow id={board} root={q.get("root") ?? ""} /> : <App />}</React.StrictMode>,
  );
}

void bootstrap();
