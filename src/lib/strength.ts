/**
 * Rough passphrase strength: estimated bits of guessing entropy, with a
 * penalty for the common patterns people actually use. Not zxcvbn, but
 * enough to steer away from "Summer2024!" towards a few random words.
 */
export interface Strength {
  bits: number;
  label: "weak" | "fair" | "good" | "strong";
  /** Years to exhaust half the space at one guess per 50 ms (our Argon2 cost) on a single machine, times 1000 machines. */
  hint: string;
}

const COMMON = ["password", "passwort", "qwerty", "letmein", "welcome", "admin", "123456", "iloveyou", "monkey", "dragon", "summer", "winter", "media", "sorter", "vault", "secret"];

export function strength(p: string): Strength {
  if (!p) return { bits: 0, label: "weak", hint: "" };
  const words = p.trim().split(/[\s\-_.]+/).filter(Boolean);
  let bits: number;
  if (words.length >= 4 && words.every((w) => w.length >= 3)) {
    // Diceware-like: ~12.9 bits per word from a 7776-word list, less if words repeat.
    bits = new Set(words.map((w) => w.toLowerCase())).size * 12.9;
  } else {
    let pool = 0;
    if (/[a-z]/.test(p)) pool += 26;
    if (/[A-Z]/.test(p)) pool += 26;
    if (/[0-9]/.test(p)) pool += 10;
    if (/[^A-Za-z0-9]/.test(p)) pool += 33;
    bits = p.length * Math.log2(Math.max(pool, 2));
    // Patterns: repeats, sequences, a trailing year or "!" add little.
    if (/(.)\1{2,}/.test(p)) bits -= 10;
    if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf)/i.test(p)) bits -= 10;
    if (/(19|20)\d\d/.test(p)) bits -= 8;
    if (/[!?.]$/.test(p)) bits -= 3;
    // "Word2024!" shapes: one capitalised word plus digits and a symbol are
    // the first thing a cracker tries, whatever the character pool says.
    if (/^[A-Za-z]{3,12}\d{1,4}[^A-Za-z0-9]{0,2}$/.test(p)) bits = Math.min(bits, 28);
  }
  const lower = p.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) bits -= 15;
  bits = Math.max(0, Math.round(bits));
  // Guesses per second: 20/s per machine at our KDF cost, assume 1000 machines.
  const seconds = Math.pow(2, Math.min(bits, 200) - 1) / (20 * 1000);
  const years = seconds / 31_557_600;
  const hint = years < 1 / 365 ? "cracked within a day" : years < 1 ? `cracked within ${Math.max(1, Math.round(years * 365))} days` : years < 1e6 ? `~${Math.round(years).toLocaleString()} years to crack` : years < 1e12 ? "millions of years to crack" : "effectively uncrackable";
  const label = bits < 40 ? "weak" : bits < 55 ? "fair" : bits < 75 ? "good" : "strong";
  return { bits, label, hint };
}
