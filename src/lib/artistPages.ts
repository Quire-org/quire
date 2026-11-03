/** An artist's other pages, as their platform profile lists them (several addresses of one account, often). */
export interface ArtistPage {
  label: string;
  url: string;
}

/** Their other pages a site each, in the order the sites first come: the several addresses of one account together. */
export function pageGroups(pages: ArtistPage[]): { label: string; pages: ArtistPage[] }[] {
  const groups = new Map<string, { label: string; pages: ArtistPage[] }>();
  for (const p of pages) {
    const k = p.label.trim().toLowerCase() || hostOf(p.url);
    const g = groups.get(k) ?? { label: p.label.trim() || hostOf(p.url), pages: [] };
    if (!g.pages.some((x) => x.url === p.url)) g.pages.push(p);
    groups.set(k, g);
  }
  return [...groups.values()];
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Two addresses on one site: the same name under its country or kind ("example.net", "www.example.net"). */
export const sameSite = (a: string, b: string) => {
  const base = (u: string) => hostOf(u).split(".").slice(-2).join(".");
  return !!base(a) && base(a) === base(b);
};

/** An address as it reads best in a line: without its scheme, "www." or a slash at the end. */
export const shortUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
