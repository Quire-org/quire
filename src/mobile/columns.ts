import { useState } from "react";
import { HOME_DEVICE } from "../lib/platform";

/** Browse's tiles across, which the pictures of an artist or a tag follow too. */
export const TILE_COLS_KEY = "quire.mobile.browseCols";
export const TILE_COLS_DEFAULT = HOME_DEVICE === "tablet" ? 5 : 3;

/** How many tiles a grid has across, kept on this device as it was last set. */
export function useColumns(key: string, fallback: number): [number, (n: number) => void] {
  const [cols, setColsState] = useState(() => {
    try {
      return Number(localStorage.getItem(key)) || fallback;
    } catch {
      return fallback;
    }
  });
  const setCols = (n: number) => {
    setColsState(n);
    try {
      localStorage.setItem(key, String(n));
    } catch {
      /* for this run */
    }
  };
  return [cols, setCols];
}
