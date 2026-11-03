import { useEffect, useState } from "react";

/**
 * A value worked out asynchronously (the backend's similarity search, say). It is shown only for the
 * `key` it was made for: a new key starts from `initial`, while a re-run for the same key keeps the
 * last value until the new one arrives, so lists don't flicker.
 */
export function useAsync<T>(key: string, fn: () => Promise<T> | T, deps: unknown[], initial: T): T {
  const [got, setGot] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve(fn())
      .then((value) => live && setGot({ key, value }))
      .catch(() => live && setGot({ key, value: initial }));
    return () => {
      live = false;
    };
  }, [key, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return got && got.key === key ? got.value : initial;
}
