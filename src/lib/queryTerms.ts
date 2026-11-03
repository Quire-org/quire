/**
 * A search as its terms, as a search box writes them (separated by spaces): words that must all be
 * there, and words left out ("-sketch"). Find shows each as a chip, to add to, flip or take off.
 */
export const isLeftOut = (term: string) => term.length > 1 && term.startsWith("-");
/** The word without its sign. */
export const bare = (term: string) => (isLeftOut(term) ? term.slice(1) : term);
/** Must have it ↔ leave it out. */
export const flipped = (term: string) => (isLeftOut(term) ? bare(term) : `-${term}`);

export function termsOf(query: string): string[] {
  return withTerms([], query);
}

export const queryOf = (terms: string[]) => terms.join(" ");

/** What was typed added, each word a term; a word there already takes its new sign, where it was. */
export function withTerms(terms: string[], typed: string): string[] {
  const out = [...terms];
  for (const t of typed.split(/\s+/)) {
    if (!t || t === "-") continue;
    const at = out.findIndex((x) => bare(x) === bare(t));
    if (at >= 0) out[at] = t;
    else out.push(t);
  }
  return out;
}
