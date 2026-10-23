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

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 4000);
    v.onseeked = () => {
      clearTimeout(timer);
      resolve();
    };
    v.onerror = () => reject(new Error("seek failed"));
    v.currentTime = t;
  });
}

function paintedFrame(v: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const anyV = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    const timer = setTimeout(resolve, 250);
    if (anyV.requestVideoFrameCallback) {
      anyV.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
      // A paused video only delivers a frame callback after a tick of playback.
      v.play().then(() => v.pause()).catch(() => {});
    }
  });
}

function isBlank(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const d = ctx.getImageData(0, 0, w, h).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 64) sum += d[i] + d[i + 1] + d[i + 2];
  return sum / (d.length / 64) < 12;
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
      const duration = isFinite(v.duration) ? v.duration : 1;
      const w = 320;
      const h = Math.max(1, Math.round((w * v.videoHeight) / Math.max(1, v.videoWidth)));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      // WebKit fires `seeked` before the frame is painted; wait for a real frame
      // and try a couple of later spots if what we got is black.
      for (const t of [Math.min(0.5, duration / 10), Math.min(1.5, duration / 3), duration / 2]) {
        await seekTo(v, t);
        await paintedFrame(v);
        ctx.drawImage(v, 0, 0, w, h);
        if (!isBlank(ctx, w, h)) break;
      }
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
