// Pure vendor-name similarity — no DB/query deps, so both queries.ts and
// merges.ts can use it without an import cycle. Combines three complementary
// signals (prefix-containment, Jaro-Winkler, token-set overlap) — see
// nameAffinity. Thresholds: NAME_MATCH = confident (auto), LOW_MATCH = a
// borderline band surfaced for confirmation.
import { achToLegacy } from "./merchant"; // pure, no imports of its own

// Lowercase, strip to alphanumerics — collapses punctuation/spacing/case so
// "Jimmy John's" and "Jimmy Johns" both become "jimmyjohns".
export const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export const NAME_MATCH = 0.9;
export const LOW_MATCH = 0.8;

const STOP_TOKENS = new Set([
  "inc", "llc", "co", "corp", "ltd", "the", "com", "payment", "bill", "pay",
]);

function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  const md = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1 = new Array(s1.length).fill(false);
  const m2 = new Array(s2.length).fill(false);
  let m = 0;
  for (let i = 0; i < s1.length; i++) {
    for (let j = Math.max(0, i - md); j < Math.min(i + md + 1, s2.length); j++) {
      if (!m2[j] && s1[i] === s2[j]) {
        m1[i] = m2[j] = true;
        m++;
        break;
      }
    }
  }
  if (!m) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k++]) t++;
  }
  t /= 2;
  return (m / s1.length + m / s2.length + (m - t) / m) / 3;
}

function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  let p = 0;
  while (p < 4 && p < a.length && p < b.length && a[p] === b[p]) p++;
  return j + p * 0.1 * (1 - j);
}

function tokenize(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2 && !STOP_TOKENS.has(t))
  );
}

// max(0..1) of three signals — covers truncation/junk suffixes (prefix), typos
// (Jaro-Winkler), and reordering/subset tokens (token-set).
export function nameAffinity(a: string, b: string): number {
  // Compared on the payee, not Chase's ACH labels (see achToLegacy).
  const na = normName(achToLegacy(a));
  const nb = normName(achToLegacy(b));
  if (!na || !nb) return 0;
  const [shortS, longS] = na.length <= nb.length ? [na, nb] : [nb, na];

  let shared = 0;
  while (shared < shortS.length && shortS[shared] === longS[shared]) shared++;
  const prefix = shortS.length >= 5 ? shared / shortS.length : 0;

  const jw = jaroWinkler(na, nb);

  const A = tokenize(a);
  const B = tokenize(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const tokens = A.size && B.size ? inter / Math.min(A.size, B.size) : 0;

  return Math.max(prefix, jw, tokens);
}
