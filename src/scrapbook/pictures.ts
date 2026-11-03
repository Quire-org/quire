import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { albumPages, useStore } from "../store";
import { isAlbumTagKey, useTags } from "../tagsStore";
import type { MediaItem } from "../lib/types";
import { coverUrl, useScrapbook } from "./store";
import { newId } from "./model";

/** The pictures that belong to a cover's album or tag (images only), up to a few hundred. */
export function useSourcePictures(target: { kind: "album"; key: string } | { kind: "tag"; id: string }): MediaItem[] {
  const all = useStore((x) => x.allItems);
  const albums = useStore((x) => x.albums);
  const root = useStore((x) => x.root);
  const tagData = useTags((x) => x.data);
  const [pages, setPages] = useState<MediaItem[]>([]);
  const album = target.kind === "album" ? albums.find((a) => a.key === target.key) : undefined;
  const albumPath = album?.path;
  useEffect(() => {
    if (!root || !album) return;
    let alive = true;
    void albumPages(root, album).then((list) => alive && setPages(list.filter((i) => i.kind === "image" || i.kind === "raw")), () => {});
    return () => {
      alive = false;
    };
  }, [root, albumPath]);
  return useMemo(() => {
    if (target.kind === "album") return pages;
    if (!tagData || !target.id) return [];
    // The tag's own pictures: albums carry tags whole, and aren't pictures to put on a cover.
    const byKey = new Map(all.map((i) => [i.key, i]));
    const out: MediaItem[] = [];
    for (const [k, list] of Object.entries(tagData.tags)) {
      if (!k || isAlbumTagKey(k) || !list.includes(target.id)) continue;
      const it = byKey.get(k);
      if (it && (it.kind === "image" || it.kind === "raw") && !it.albumKey) out.push(it);
    }
    return out;
  }, [target, pages, tagData, all]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A picture copied into the scrapbook's own files (scaled to fit `max`), so the cover keeps it whatever happens to the original. */
export async function copyPicture(it: MediaItem, max: number): Promise<{ blob: string; aspect: number }> {
  const root = useStore.getState().root;
  if (!root) throw new Error("no folder is open");
  const bytes = await api.readMediaImage(root, it.primary);
  const bmp = await createImageBitmap(new Blob([bytes]));
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const out = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("could not copy the picture"))), "image/jpeg", 0.88));
  const blob = `photo-${newId()}.jpg`;
  await useScrapbook.getState().putBlob(blob, out);
  return { blob, aspect: c.height / c.width };
}

/** The rendered picture of a scrapbook (a cover's id), as a URL; null without one. Follows it when the cover is saved again. */
export function useCoverUrl(book: string | undefined, wanted = true): string | null {
  const rendered = useScrapbook((x) => (book ? x.lib?.books[book]?.rendered : undefined));
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!book || !wanted) {
      setUrl(null);
      return;
    }
    void coverUrl(book).then((u) => alive && setUrl(u), () => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [book, wanted, rendered]);
  return url;
}
