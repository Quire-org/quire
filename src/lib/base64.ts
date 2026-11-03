/** A file's bytes as base64, to hand to the backend. */
export function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error ?? new Error("could not read the picture"));
    r.readAsDataURL(blob);
  });
}
