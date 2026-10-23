import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/rajdhani/700.css";
import "@fontsource/share-tech-mono/400.css";
import "./themes/base.css";
import "./themes/cp2077.css";
import "./themes/ghost.css";
import "./app.css";
import App from "./App";
import { applyTheme, loadThemeId } from "./themes";

async function bootstrap() {
  // `?mock` on the Vite dev server runs the UI in a plain browser (see README).
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    await import("./dev/mock");
  }
  applyTheme(loadThemeId());

  // The app is keyboard driven; the browser context menu only gets in the way.
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
