// First: the saved settings get Quire's names before any module reads them.
import "./lib/formerly";
import React from "react";
import ReactDOM from "react-dom/client";
import "./look";
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
