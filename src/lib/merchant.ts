// Conservative canonicalization of bank-descriptor merchant strings, applied at
// import time. The same real merchant arrives under many descriptors — case
// drift ("JPMORGAN…" vs "Jpmorgan…"), wallet prefixes ("Aplpay …"), and
// volatile per-transaction junk (ACH/PPD reference ids, card "ending in 1234",
// dates, store/account numbers). This strips that noise and standardizes case so
// one merchant lands on one stable string, which lets exact-merchant grouping
// (recurring detection, paid-matching) actually work.
//
// Deliberately conservative: it removes obvious junk, never meaningful words, so
// intentionally-distinct merchants (e.g. "Edelman Payments" vs "Edelman
// Payroll") stay separate. The original descriptor is preserved in
// transactions.rawMerchant, so this is fully reversible. Idempotent:
// normalizeMerchant(normalizeMerchant(x)) === normalizeMerchant(x).
// Chase's newer ACH text: "ORIG CO NAME:AMERICAN EXPRESS CO ENTRY DESCR:ACH
// PMT SEC:WEB IND ID:M6710 ORIG ID:2005032111". Its labels outweigh the payee:
// every ACH debit shared "Orig Co Name … Entry Descr … Sec … Orig Id", so two
// payees compared as one (an Amex payment was combined into the Chase
// mortgage, 2026-10-05), and each new text named a new vendor. Rewritten into
// the older layout the same payees used ("AMERICAN EXPRESS ACH PMT M6710 WEB
// ID: 2005032111"), it normalizes to the names the household's vendors already
// have. Anything else passes through unchanged.
export function achToLegacy(text: string): string {
  const co = text.match(/ORIG CO NAME:\s*(.*?)\s+CO ENTRY DESCR:/i);
  const descr = text.match(/CO ENTRY DESCR:\s*(.*?)\s+SEC:/i);
  if (!co || !descr) return text;
  const field = (label: string) => text.match(new RegExp(`${label}:\\s*(\\S*)`, "i"))?.[1] ?? "";
  const sec = field("SEC");
  // A reference with digits in it ("M6710") is a code, not the payee; a word
  // ("EFT") is part of how the household's vendors are named.
  const ind = /\d/.test(field("IND ID")) ? "" : field("IND ID");
  return [co[1], descr[1], ind, sec ? `${sec} ID: ${field("ORIG ID")}` : ""].filter(Boolean).join(" ").trim();
}

export function normalizeMerchant(raw: string): string {
  const original = achToLegacy((raw ?? "").trim());
  let s = original;

  // Leading wallet / processor prefixes (may stack, e.g. "Aplpay Sp Rothys"):
  // the Apple Pay word, or any short payment-gateway code of the form "LETTERS*"
  // (SQ*, TST*, MDC*, DNH*, IC*, FSP*, PROPAY*, …), with or without a trailing
  // space ("Dnh*godaddy", "Mdc*south Central…").
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/^((aplpay|paypal)\s+|[a-z]{2,6}\s?\*\s*)/i, "");
    if (next === s) break;
    s = next;
  }

  // Volatile suffixes / embedded reference data:
  s = s.replace(/\b(ppd|ccd|web|tel|arc|ipp)\s*id:?.*$/i, ""); // ACH ref-id blocks
  s = s.replace(/\bending in\b.*$/i, ""); // card "ending in 2601 06/01"
  s = s.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " "); // dates mm/dd(/yy)
  s = s.replace(/\b\d{4,}\b/g, " "); // long digit runs (account/store/ref numbers)

  // Bare trailing ACH channel-code token, e.g. "…Water Bill Tel" or "Payment
  // Thank You Web". The id-form ("tel id: …") is handled above; this catches the
  // lone marker left at the end. Looped so stacked codes ("… Web Tel") all go,
  // which keeps the function idempotent.
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/[\s\-]+(ppd|ccd|web|tel|arc|ipp)\b\s*$/i, "");
    if (next === s) break;
    s = next;
  }

  // Tidy: collapse whitespace, drop dangling separators.
  s = s.replace(/\s{2,}/g, " ").replace(/[\s,#*:.\-]+$/g, "").trim();

  return canonCase(s || original); // never blank out a merchant
}

// Title-case at word starts only (not after apostrophes/hyphens, so "Mcdonald's"
// and "Chick-fil-a" stay readable) so mixed-case variants of one merchant unify.
function canonCase(s: string): string {
  return s.toLowerCase().replace(/(^|\s)([a-z])/g, (_, b, c) => b + c.toUpperCase());
}

// What a vendor is called on screen when no alias is set. Payment rails carry
// the payee AFTER them — "Zelle Payment To Rosy's Cleaning" — and the rail
// is noise in a list of bills: strip it for display only. The stored merchant
// is untouched (grouping, links, and settings still key on it), so this is
// safe to apply anywhere a merchant string is shown.
export function displayMerchant(merchant: string): string {
  const s = merchant.replace(/^zelle payment (to|from) /i, "").trim();
  return s || merchant;
}

// Normalize a bank-descriptor merchant string to a coarse vendor key so the
// drawer can roll up descriptor drift — e.g. "Benjamin Franklin",
// "Benjamin Franklin Plindianapolis In", "Benjamin Franklin Plumbin" all share
// one vendor, as do "Culvers Of Franklin" and "Aplpay Culvers Of Frfranklin In".
// Strips common wallet/processor prefixes, drops punctuation and pure-number
// tokens, and keys on the first two significant tokens. Heuristic by design: it
// under-merges (won't unify "Ben" vs "Benjamin") rather than risk lumping
// distinct vendors together.
//
// Payment-rail and fee prefixes carry the payee AFTER them — "Zelle Payment To
// Indy K-9", "Plan Fee - Ticketmaster" — so they're stripped too. Without this
// every Zelle payee keyed to "zelle payment" and became one vendor: the shelf
// rolled them up, the vendor filter showed them all, and "Not recurring" on one
// payee muted all 38 (seen on real data).
export function merchantKey(name: string): string {
  let s = name.toLowerCase().trim();
  s = s.replace(/^(aplpay |sq ?\*|tst\* ?|sp |pp\*|paypal \*|gpc\*|pos )/, "");
  s = s.replace(/^(zelle payment (to|from) |plan fee[\s-]+)/, "");
  s = s.replace(/[^a-z0-9 ]+/g, " ");
  const tokens = s.split(/\s+/).filter((t) => t && !/^\d+$/.test(t));
  return tokens.slice(0, 2).join(" ");
}
