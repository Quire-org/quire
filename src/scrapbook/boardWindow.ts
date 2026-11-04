import { useStore } from "../store";
import { pageOf, type ScrapDoc } from "./model";

/** The preview in a plain browser (`?mock`, or the web demo), which has no windows of its own to open. */
const inPreview = () => (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) || !!import.meta.env.VITE_DEMO;

/**
 * A board in a window of its own (BoardWindow), above other apps at first: a reference beside the
 * drawing app. One window a board: asked again, the one open comes forward.
 */
export async function openBoardWindow(doc: ScrapDoc): Promise<void> {
  const root = useStore.getState().root;
  if (!root) return;
  if (inPreview()) return void useStore.getState().toast("A board opens in its own window in the app", "info");
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const label = `board-${doc.id}`;
  const open = await WebviewWindow.getByLabel(label);
  if (open) return void (await open.setFocus());
  // As large as the board in its shape, within most of the screen.
  const { w, h } = pageOf(doc);
  const k = Math.min(1, (screen.availWidth * 0.6) / w, (screen.availHeight * 0.7) / h);
  const win = new WebviewWindow(label, {
    url: `index.html?board=${encodeURIComponent(doc.id)}&root=${encodeURIComponent(root)}`,
    title: doc.name || "Board",
    width: Math.max(320, Math.round(w * k)),
    height: Math.max(240, Math.round(h * k) + 36),
    alwaysOnTop: true,
  });
  win.once("tauri://error", (e) => useStore.getState().toast(`Could not open the board's window: ${String(e.payload)}`, "error"));
}
