import { base64 } from "./base64";

/** A picture's bytes as a small JPEG (its long side at most `side`), in base64: what is sent to ask a platform what it is. */
export async function smallJpeg(bytes: ArrayBuffer, side = 512): Promise<string> {
  const bmp = await createImageBitmap(new Blob([bytes]), { imageOrientation: "from-image" });
  const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("the picture couldn't be made small"))), "image/jpeg", 0.9));
  return base64(blob);
}
