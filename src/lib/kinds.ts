import type { MediaKind } from "./types";

const IMAGE = ["jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "bmp", "tif", "tiff", "avif"];
const RAW = ["cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "dng", "raf", "orf", "rw2", "pef", "srw", "3fr", "erf", "kdc", "mrw", "x3f"];
const VIDEO = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "mts", "m2ts", "mpg", "mpeg"];

/** Media kind from a file name, or null for anything the viewer cannot show. */
export function classifyName(name: string): MediaKind | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE.includes(ext)) return "image";
  if (RAW.includes(ext)) return "raw";
  if (VIDEO.includes(ext)) return "video";
  return null;
}
