import { api } from "./api";
import { useTags } from "../tagsStore";

/**
 * How drawn a picture looks, worked out as the engine does when the tag index looks at it: its picture
 * against words for drawings and words for photos, the best of each compared. From DRAWN_MIN up, the
 * anime tagger looks at it, and People takes it for a drawing (its Character finder, not the Face
 * finder). Shown in Info, to see why a picture went one way. The words, the scale and DRAWN_MIN are
 * the engine's (engine/src/tagging.rs DRAWN, PHOTO, SIGLIP_SCALE; engine/src/main.rs DRAWN_MIN): keep
 * them in step.
 */
const DRAWN = ["an anime illustration", "a manga page", "a drawing", "a cartoon", "a comic", "digital art of a character", "an anime screenshot"];
const PHOTO = ["a photo", "a photo of a person", "a photo of a place", "a photo of food", "a photo of an animal", "a selfie"];
const SCALE = 112.90118;
export const DRAWN_MIN = -1;

/** The words' vectors, made once for a library and its matcher. */
let words: { space: string; vectors: Promise<number[][]> } | null = null;

/** The picture's drawn score (drawings about 2 to 4, photos −3 to −11); null while the tag index hasn't looked at it. */
export async function drawnScore(root: string, key: string): Promise<number | null> {
  const space = `${root}|${useTags.getState().models?.embedder ?? ""}`;
  if (words?.space !== space) words = { space, vectors: Promise.all([...DRAWN, ...PHOTO].map((t) => api.tagsEmbedText(root, t))) };
  const vectors = await words.vectors.catch((e) => {
    words = null;
    throw e;
  });
  const [row] = await api.tagsScores(root, [key], vectors, {});
  if (!row) return null;
  return SCALE * (Math.max(...row.slice(0, DRAWN.length)) - Math.max(...row.slice(DRAWN.length)));
}
