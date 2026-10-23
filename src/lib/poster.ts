/**
 * First-frame posters for video tiles. WebKit does not paint a frame for a
 * <video preload="metadata"> until it plays, so we grab one ourselves. Kept in
 * memory only, a couple at a time so the grid does not spawn dozens of decoders.
 */
const cache = new Map<string, Promise<string>>();
let active = 0;
const waiting: (() => void)[] = [];
const MAX_ACTIVE = 2;

function acquire(): Promise<void> {
  if (active < MAX_ACTIVE) {
    active++;
    return Promise.resolve();
  }
  return new Promise((r) =>
    waiting.push(() => {
      active++;
      r();
    }),
  );
}
function release() {
  active--;
  waiting.shift()?.();
}

export function videoPoster(url: string): Promise<string> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = (async () => {
    await acquire();
    try {
      const v = document.createElement("video");
      v.crossOrigin = "anonymous";
      v.muted = true;
      v.preload = "auto";
      v.playsInline = true;
      v.src = url;
      await new Promise<void>((resolve, reject) => {
        v.onloadedmetadata = () => resolve();
        v.onerror = () => reject(new Error("video decode failed"));
      });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 4000);
        v.onseeked = () => {
          clearTimeout(t);
          resolve();
        };
        v.onerror = () => reject(new Error("seek failed"));
        v.currentTime = Math.min(0.5, (isFinite(v.duration) ? v.duration : 1) / 10);
      });
      const w = 320;
      const h = Math.max(1, Math.round((w * v.videoHeight) / Math.max(1, v.videoWidth)));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d")!.drawImage(v, 0, 0, w, h);
      v.removeAttribute("src");
      v.load();
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.8));
      if (!blob) throw new Error("poster encode failed");
      return URL.createObjectURL(blob);
    } finally {
      release();
    }
  })();
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}
