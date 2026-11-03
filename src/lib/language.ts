import { useStore } from "../store";
import { albumPageKeys, useTags } from "../tagsStore";
import { api } from "./api";

/** The languages an album can be in, with their flags. */
export const LANGS: { code: string; name: string; flag: string }[] = [
  { code: "ja", name: "Japanese", flag: "🇯🇵" },
  { code: "en", name: "English", flag: "🇬🇧" },
  { code: "zh", name: "Chinese", flag: "🇨🇳" },
  { code: "ko", name: "Korean", flag: "🇰🇷" },
  { code: "es", name: "Spanish", flag: "🇪🇸" },
  { code: "fr", name: "French", flag: "🇫🇷" },
  { code: "de", name: "German", flag: "🇩🇪" },
  { code: "it", name: "Italian", flag: "🇮🇹" },
  { code: "pt", name: "Portuguese", flag: "🇧🇷" },
  { code: "ru", name: "Russian", flag: "🇷🇺" },
  { code: "vi", name: "Vietnamese", flag: "🇻🇳" },
  { code: "th", name: "Thai", flag: "🇹🇭" },
  { code: "id", name: "Indonesian", flag: "🇮🇩" },
];

export const langName = (code?: string | null) => LANGS.find((l) => l.code === code)?.name ?? "unknown";

/** Language names in a folder name ("[English]", "Japanese", "中国翻訳"): the strongest sign there is. */
const NAMED: [RegExp, string][] = [
  [/\benglish\b|英訳|英語/i, "en"],
  [/\bchinese\b|中国翻訳|中國翻譯|中国語|汉化|漢化|中文|翻译/i, "zh"],
  [/\bkorean\b|한국어|韓国翻訳|韓国語/i, "ko"],
  [/\b(spanish|español|espanol)\b/i, "es"],
  [/\b(french|français|francais)\b/i, "fr"],
  [/\b(german|deutsch)\b/i, "de"],
  [/\b(italian|italiano)\b/i, "it"],
  [/\b(portuguese|português|portugues)\b/i, "pt"],
  [/\brussian\b|русский/i, "ru"],
  [/\bvietnamese\b|tiếng việt/i, "vi"],
  [/\bthai\b/i, "th"],
  [/\bindonesian\b/i, "id"],
  [/\bjapanese\b|日本語/i, "ja"],
];

/** Short codes count only in brackets: "[EN]", "(JP)", "{RAW}". */
const CODES: Record<string, string> = { en: "en", eng: "en", jp: "ja", jpn: "ja", ja: "ja", raw: "ja", cn: "zh", chs: "zh", cht: "zh", zh: "zh", kr: "ko", kor: "ko", ko: "ko", es: "es", esp: "es", spa: "es", fr: "fr", fra: "fr", de: "de", ger: "de", it: "it", ita: "it", pt: "pt", "pt-br": "pt", ptbr: "pt", por: "pt", ru: "ru", rus: "ru", vi: "vi", vie: "vi", th: "th", tha: "th", id: "id", ind: "id" };

function named(name: string): string | null {
  for (const [re, code] of NAMED) if (re.test(name)) return code;
  for (const m of name.matchAll(/[[({]\s*([a-z-]{2,5})\s*[\])}]/gi)) {
    const code = CODES[m[1].toLowerCase()];
    if (code) return code;
  }
  return null;
}

/** The script a name is written in, a weak sign: a Japanese title may hold an English translation. */
function script(name: string): string | null {
  if (/[가-힯]/.test(name)) return "ko";
  if (/[぀-ヿ]/.test(name)) return "ja";
  if (/[Ѐ-ӿ]/.test(name)) return "ru";
  if (/[฀-๿]/.test(name)) return "th";
  if (/[一-鿿]/.test(name)) return "ja";
  return null;
}

/* What the pages show: each indexed page's picture embedding against descriptions of text in each
   script (the same model the tag search uses). Each page votes; a clear majority decides. */
const PROMPTS: Record<string, string[]> = {
  ja: ["a manga page with Japanese text", "Japanese hiragana and katakana writing in speech bubbles", "a raw Japanese manga page"],
  en: ["a comic page with English text", "English writing in speech bubbles", "a manga page translated into English"],
  zh: ["a manga page with Chinese text", "Chinese characters writing in speech bubbles", "a manga page translated into Chinese"],
  ko: ["a manhwa page with Korean text", "Korean hangul writing in speech bubbles", "a manga page translated into Korean"],
};
/** The prompts in words-and-pictures space, for the model the tag index is made with (each its own). */
let promptVecs: Promise<[string, Float32Array[]][]> | null = null;
let promptsFor = "";
const unit = (v: Float32Array) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

async function pagesLanguage(albumKey: string): Promise<string | null> {
  const root = useStore.getState().root;
  const keys = albumPageKeys(albumKey);
  if (!root || keys.length < 2) return null;
  const space = `${root}|${useTags.getState().models?.embedder ?? ""}`;
  if (promptsFor !== space) promptVecs = null;
  promptsFor = space;
  promptVecs ??= Promise.all(Object.entries(PROMPTS).map(async ([code, list]) => [code, await Promise.all(list.map(async (t) => unit(new Float32Array(await api.tagsEmbedText(root, t)))))] as [string, Float32Array[]]));
  const prompts = await promptVecs.catch((e) => {
    promptVecs = null;
    throw e;
  });
  // Each page against every prompt, in the backend (the page embeddings live there).
  const rows = (await api.tagsScores(root, keys, prompts.flatMap(([, ps]) => ps.map((p) => [...p])), {})).filter((r): r is number[] => !!r);
  if (rows.length < 2) return null;
  const votes = new Map<string, number>();
  for (const row of rows) {
    let at = 0;
    const scores = prompts
      .map(([code, ps]) => {
        const mean = row.slice(at, at + ps.length).reduce((a, x) => a + x, 0) / ps.length;
        at += ps.length;
        return [code, mean] as const;
      })
      .sort((a, b) => b[1] - a[1]);
    if (scores[0][1] - scores[1][1] < 0.004) continue; // this page can't tell
    votes.set(scores[0][0], (votes.get(scores[0][0]) ?? 0) + 1);
  }
  const best = [...votes].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 && best[1] >= 0.6 * rows.length ? best[0] : null;
}

/**
 * An album's language: a language named in its folder name; else what its indexed pages show;
 * else the script of its name. Null when none of them can tell.
 */
export async function guessLanguage(albumKey: string, name: string): Promise<string | null> {
  return named(name) ?? (await pagesLanguage(albumKey).catch(() => null)) ?? script(name);
}
