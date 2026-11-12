import "../lib/formerly";
import React from "react";
import ReactDOM from "react-dom/client";
import "../look";
import "./mobile.css";
import MobileApp from "./MobileApp";
import { applyLook, loadModeId, loadThemeId } from "../themes";
import { longPressIsRightClick } from "./gestures";
import { leaveOtherAudioAlone } from "../lib/otherAudio";

async function bootstrap() {
  // `?mock` on the Vite dev server runs the UI in a plain browser (see docs/development.md).
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) await import("../dev/mock");
  applyLook(loadThemeId(), loadModeId());
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  longPressIsRightClick();
  leaveOtherAudioAlone();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <MobileApp />
    </React.StrictMode>,
  );
}

void bootstrap();
