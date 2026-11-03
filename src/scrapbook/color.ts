/**
 * The colour space stickers are made in. A photo in wide colour (Display P3, as phones take them) loses
 * its most vivid colours in an ordinary (sRGB) canvas, so stickers are cut, tuned and saved in P3 when
 * this webview keeps it all the way into a PNG: a P3 red written to one and read back is still that
 * red. Otherwise (the PNG would come out untagged, its colours shifted) sRGB throughout. Checked once.
 */
let space: PredefinedColorSpace = "srgb";
let checked: Promise<PredefinedColorSpace> | null = null;

export function checkStickerSpace(): Promise<PredefinedColorSpace> {
  checked ??= (async (): Promise<PredefinedColorSpace> => {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      const ctx = c.getContext("2d", { colorSpace: "display-p3" });
      if (!ctx || ctx.getContextAttributes().colorSpace !== "display-p3") return "srgb";
      ctx.fillStyle = "color(display-p3 1 0 0)";
      ctx.fillRect(0, 0, 1, 1);
      const png = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
      if (!png) return "srgb";
      const back = document.createElement("canvas");
      back.width = back.height = 1;
      const bctx = back.getContext("2d", { colorSpace: "display-p3", willReadFrequently: true })!;
      bctx.drawImage(await createImageBitmap(png), 0, 0);
      const [r, g, b] = bctx.getImageData(0, 0, 1, 1).data;
      return r > 245 && g < 15 && b < 15 ? "display-p3" : "srgb";
    } catch {
      return "srgb";
    }
  })().then((s) => (space = s));
  return checked;
}

/** A canvas's 2D context in the stickers' colour space (or plain sRGB, for masks: their greys are values, not colours). */
export function stickerContext(c: HTMLCanvasElement, colour = true, read = false): CanvasRenderingContext2D {
  return c.getContext("2d", { colorSpace: colour ? space : "srgb", willReadFrequently: read })!;
}

/** Pixels in the stickers' colour space, to put on such a canvas. */
export function stickerImageData(data: Uint8ClampedArray, w: number, h: number): ImageData {
  return space === "srgb" ? new ImageData(data, w, h) : new ImageData(data, w, h, { colorSpace: space });
}

export const stickerSpace = () => space;
