# DESIGN.md — Design principles & review

Three layers: **§1 Principles** (portable — copy into any app), **§2 Conventions**
(this app's realization — rewrite per app), **§3 Review checklist** (run per
feature / PR / screen). §1 and §3 travel unchanged; only §2 is app-specific.

> **The rule above the rules — Legibility beats cleverness.**
> A feature that can't be found, understood, or reached doesn't exist. Every
> principle below serves this. Depth is only worth building if it's *visible,
> teachable, and reachable.*

---

## §1 — Principles (portable)

Each principle carries a **test**: a yes/no question to run in review. If the
answer comes out wrong, the design isn't finished — capability is not the bar,
legibility is.

### 1. Anchor, then reveal — *visible*
Every surface has at least one always-visible entry point. Hover and secondary
states may *enhance* an action; they may never *gate* it. Progressive disclosure
layers off the anchor — it doesn't replace it.
- **Why:** hidden affordances don't get used — even by the author months later —
  and vanish entirely on touch.
- **Test:** remove every hover/secondary state — can you still reach every action?

### 2. Teach at the point of use — *understandable*
Name concepts in the user's words. Where the model isn't obvious, explain it in
one sentence where the user meets it — not in a manual.
- **Why:** a powerful concept the user can't parse is friction, not power. If the
  author has to ask "what does this mean?", it isn't self-teaching.
- **Test:** would a capable first-time user know what this does and why?

### 3. Reach is table stakes — or scoped on purpose — *reachable*
Touch, keyboard, and adequate contrast are defaults. Dropping one is a written
decision, not an accident.
- **Why:** an unstated gap is a silent break; "works on my machine" isn't a design.
- **Test:** works on touch and keyboard, with legible contrast? If not, did we
  decide that deliberately and write it down?

### 4. Correct, don't configure
Let users nudge the system's guess on the object itself; show what's *auto* vs.
*edited*. Prefer in-place correction to a settings panel.
- **Why:** people fix what's in front of them; they don't hunt through preferences.
- **Test:** is this a setting in a panel, or a nudge on the thing it affects?

### 5. Honest by default
Never present provisional or partial data as final. Withhold it, qualify it, or
project it — but don't overstate.
- **Why:** in anything numeric, trust is the product; one misleading figure costs it.
- **Test:** could this number mislead someone who reads it mid-process?

### 6. Rank ruthlessly
The single most important element on a surface wins visually. Equal weight is no
hierarchy.
- **Why:** if everything is emphasized, nothing is; the eye needs a place to land.
- **Test:** squint — is the loudest thing the thing that matters most?

### 7. One pattern per job
One paradigm per interaction class — dropdowns, confirmations, vocabulary.
Resist one-off micro-interactions.
- **Why:** every bespoke pattern is a thing to learn and a thing to maintain;
  consistency is a feature.
- **Test:** does this add a new way to do something the app already does another way?

### 8. Finish the states
Design empty, loading, partial, and error — not just the happy path.
- **Why:** the unhappy paths are where trust is won or lost, and they are most of
  real use.
- **Test:** what does this look like with zero items, while loading, and when it fails?

### 9. Complete the verbs — *capable*
Every domain object's expected operations — create, read, edit **each** attribute,
delete — are reachable in the UI, or the omission is a *deliberate, written*
decision (e.g. bank data is read-only). The audit artifact is a capability/CRUD
matrix: objects × operations; the blanks are the findings.
- **Why:** an *absent* capability can't be spotted by looking at a screen — only
  by checking the screen against what *should* be possible. This is the blind
  spot of a presentation-only review (we shipped category icon/color editing but
  not rename, and an API that accepted a field the UI never exposed).
- **Test:** for each object, list its attributes — is editing each one reachable?
  Is anything wired in the data model / API but not surfaced in the UI?

---

## §2 — This app's conventions (Daybook)

How the principles above are realized here. **Rewrite this section per app;** §1
and §3 carry over unchanged.

- **The shelf is the control surface.** A vendor or category is edited in the
  right-side shelf, where its evidence (recent charges, totals, history) is on
  screen — not in a modal, not on a separate page. Drill down via the shelf; keep
  the user on the current page. *(serves: Correct-don't-configure, Anchor)*
- **Correction vocabulary.** One noun: a **plan** (a detected recurring bill or
  deposit; a vendor may carry several). Plain verbs the user owns, and no
  others: **In plan / Not in plan** (one toggle on a charge; an "edited" tag
  says the user decided, no tag means the detector did; in a list row the ↻
  glyph, in the muted grey (a mark, not a signal), means "in a plan that counts" and nothing else, so a charge taken out shows no
  glyph rather than a struck one), **Mark ended /
  Reactivate** (a plan stopped, or is back), **Not recurring** (never was a
  pattern: drop the plan), **Start a plan** (on a charge in no plan: this is
  a subscription the detector can't see; a plan from its amount, which the
  vendor's other charges at that amount join), **Add** (a plan the detector
  found: it counts, and its charges carry ↻, only once added, from the
  suggestions queue or its shelf), **Combine / Separate** (bank
  names that are one vendor). **Exclude from totals** and **split** are money verbs and live on
  the Transactions tab; the shelf only shows "not counted". Never "series",
  "excluded", "not detected" or "configure" in the UI. *(Teach, One-pattern)*
- **Auto vs. edited is always legible.** A field shows whether it holds the
  system's detected value or one the user set ("Auto · Monthly"; an "edited"
  tag). *(Correct-don't-configure, Honest)*
- **Dropdowns — one rule.** Native `<select>` for simple/keyboard cases (category,
  filters, sort), and it must *look* interactive (visible affordance). Custom
  dropdowns only when the content is rich (the combine picker, the emoji grid).
  No disguised controls. *(One-pattern, Anchor)*
- **Forward-looking figures are qualified — by a word, not a symbol.** Mid-month
  net is shown projected with a "so far" actual; bills read "paid so far of $X
  expected"; projections are withheld until enough of the month has elapsed. The
  qualifier is said once where figures share a frame: the month is the header
  picker, figure labels are sentence case ("Net", "Spent so far"), and each
  projected figure carries its "$X so far". No ≈ or ~ in front of a figure. *(Honest)*
- **A toast is for what you can't see.** A success message appears only when
  the outcome is off-screen (a vendor combined, a category deleted, a split
  applied), spans many things (Apply all, Overrides reset, dismissed vendors
  brought back), or would need an undo. When the object you touched shows the
  result — a row leaves a queue, a pill flips, a field shows its new value —
  it says nothing. Errors always speak. *(Honest, One-pattern)*
- **Review queues** surface low-confidence work (uncategorized, merge / name-cleanup
  candidates) for one-tap confirmation instead of auto-applying it. One decision
  per vendor: a vendor in two queues at once is answered in the one with the
  evidence, and the other points at it (an uncategorized duplicate candidate
  gets no category proposal; Combine sets its category). *(Correct-don't-configure)*
- **Tokens & theme.** One accent, neutral grays, dark mode via `data-theme` + CSS
  variables. New surfaces use the tokens and the scales below — never a
  hard-coded color, never a size off the scale. *(One-pattern)*
- **Touch is in scope; hover only enhances.** The app ships a mobile bottom nav
  and a bottom-sheet shelf, so every action has a resting state. The four pages
  are the tabs; Sign out and the theme control sit past a hairline in narrow
  labelled cells, not as another tab. Secondary controls sit at `opacity-60` and strengthen on hover/focus (the dashboard's
  drill chevron is the reference). `opacity-0 group-hover` gating is a defect,
  not a scope decision. List rows that open the shelf are keyboard rows
  (`rowButtonProps` — role, tabIndex, Enter/Space) since they hold nested
  controls and can't be `<button>`s. A chart says in words what it shows
(a `role="img"` label), and motion stops when the system asks for less. Small controls carry `tap` (`tap-native`
  for an input or select): on a coarse pointer the hit area grows 10px on
  every side without moving the type, so nothing you tap is under 32px.
  *(Reach)*
- **Transactions are source-of-truth bank data** — no manual create, no delete, and
  the merchant/amount/posted-date aren't editable by design. Corrections happen at
  the *vendor* level (rename/combine/recategorize) or as overlays on the charge
  (category, note, effective-date, recurring membership, exclude-from-totals,
  split). This is the deliberate answer to "Complete the verbs" for
  transactions; every overlay is reachable from the charge's shelf. *(Capable)*
- **A category that isn't counted is not counted anywhere.** Transfers (a card
  autopay and the card's "thank you" for it) leave every total, and a plan in
  such a category is neither a bill nor income: the Recurrings lists and the
  digest leave it out, and one line at the foot of the page names it so it
  doesn't vanish. *(Honest, One-pattern)*

### The one page — scales and anatomies

Every line here is a rule the code is checked against (`npm run lint:design`,
a ratchet: off-scale uses may fall or hold, never rise; `-- --update` records a
new floor). The audit that produced it lives in the session artifacts.

**Type** — six sizes, nothing between them.

| px | role | class |
|---|---|---|
| 11 | tags, uppercase labels (letter-spaced) | `text-[11px]` |
| 12 | captions, meta, secondary text | `text-xs` |
| 13 | rows and body | `text-[13px]` |
| 15 | card and section titles | `text-[15px]` |
| 18 | page title | `text-lg` |
| 24 | summary figures | `text-2xl` |

Weights: 400 body · 500 names and labels · 600 titles and figures. Case: sentence case
describes a figure ("Spent so far", "Left to pay"); uppercase, at 11px and
letter-spaced, names a section or a box ("BUDGET", "RECENT", "LAST 12
MONTHS"). A label never shouts a qualifier. Tabular
figures wherever numbers align.

**Colour** — the seven surface and text tokens as today (`--background`,
`--card`, `--border`, `--hover`, `--foreground`, `--muted`, `--accent`) plus
three semantic ones, `--good`, `--warn`, `--bad`, each with a dark value one
step lighter; tints are the token at 10–25%. Semantic colour is never the
accent and the accent is never semantic. Category colours are data, not chrome.
A budget bar is its category's own budget, full width (`BudgetBar`, the same
on the dashboard and the Categories page): the spend fills in the accent at
60%, past the budget the overage is `--bad`, and one marker says how far
through the budget's period we are (pace). A category's colour is on its
badge, never its bar; the recurring amount is in the row's caption and the
shelf, not on the bar. Under a bar, what's left is said, in the same words on
every page ("$416 left so far", "$1,350 over"): a spent / budget pair makes
you subtract. The dashboard's spending chart carries the month's budget as a
dotted line, the summary card's figure, withheld when material spending sits
outside the budget (the curve would count what the line doesn't).

**Space and shape** — spacing steps 4 · 8 · 12 · 16 · 24 · 32 (Tailwind 1 2 3
4 6 8). Card padding 16; the summary card 24. Rows 8 vertical × 16
horizontal (12 vertical for a one-line row on a phone: a 44px touch target,
and room for a difference under the amount). One radius for cards and controls (8px, `rounded-lg`); `full` for
pills and tags; nothing else.

**Summary card anatomy** — the month is said once, in the header picker, so the
card does not repeat it. Figure labels are sentence case, one or two words, and
carry the qualifier where one is due ("Spent so far"; a projected figure's
"$X so far" beneath it), with the whole the bar measures in the panel's caption
("78% of $42,530"); one height on every page (no floor: a caveat on what the bar
measures is a "?" hint beside the caption, never a line of its own, and a
verdict is written to fit one line);
then two panels centred on one line on the page's own 3:2 grid, run to the card's edges: the figures as columns
across the chart card's width below — the first, the result (net, spent so
far, paid so far), at the summary size and every other at the card-title
size, on every page — and the budget
across the category card's (its text starting on that card's text), with the hairline
in the middle of the gutter. The budget panel reads label, share, bar, then
the verdict at the card-title size — "on pace to finish under budget",
"2 overdue" — since every verdict describes the bar; counts that follow it
("· 20 upcoming · 60 paid", "· 6 not budgeted") are bookkeeping, a 12px muted
caption on the same line, never the verdict's size. They stack below desktop width. One colour signal per card, the verdict's: only a finished
month's net takes its colour.

**Page anatomy** — header: title, optional one-line subtitle, the month picker
in one slot on every page, page actions to its right (on a phone the title
and the picker hold one row and the subtitle, or the transactions figure, sits beneath both). Then the summary card
(the month). Transactions is the statement, and the exception: its net sits on
the title's line at the card-title size with its count beside it ("217 shown ·
so far"), because a second card above a day-by-day list would bury the
statement; every header is the same height, so switching tabs doesn't jump.
The month picker steps with ‹ › and reads the month in full. Then the toolbar — search, filters, sort — sitting directly
above the list it acts on, never in the header and never above the summary.
Then the list, in one of two patterns: **sections** for a handful of groups
(a small-caps title on the page above one card of rows — Recurrings, the
Dashboard queue), or a **continuous list with running headers** for many
small groups (a statement: one card, each day a sticky band in the page grey
carrying the date and the day's total — Transactions). Never one card per
day.

**Row anatomy** — leading column: a date where time is the subject, a glyph
where the vendor is. Name in 13/500 with a 12/400 meta line only when it
varies row to row. Category as a quiet property with a chevron. Amount right,
tabular, in one of three states: settled (600, foreground), provisional (500,
muted), overdue (600, warn). No row menu anywhere: verbs live in the shelf.
The cells are shared code (`RowCells.tsx`: `CategoryProperty`, `AmountCell`).

**Shelf anatomy** — header (name, descriptor, count and since); at most two
property cards, each marked auto or edited; one caption line; evidence as a
flush, edge-aligned list with the membership pill (a charge's rows) or the ↻
glyph (a category's vendors: the verb lives in the vendor shelf a tap away);
then match, the vendor's split rules (each removable, which restores what it
split), and the action row. The footer link follows the content, not the panel edge. Three shelves,
one anatomy: a **vendor** (or one of its plans; a vendor with several plans
lists them with their monthly total (only plans still billing: one that stopped, as when the bank renamed the vendor, is neither listed nor counted) in place of the cards, each opening its
own shelf), a **category** (its badge and name in the header are its icon, colour,
type and name editors; readings first, the setting last: two cards at one
size, each with what it's measured against under its label: spent, with the
trend (mid-month against the same days of last month), and what's left, "of
$10,375" and "$6,699 recurring" (the average month, and "No budget", without
one); under them the shared `BudgetBar`; the last 12 months as bars, their
each figure on its bar (420, 9.9k, 14k; the average line gives way to it), the average finished month dashed
and named "Avg $X", an unfinished month hatched; then the budget's field, a bordered amount and a
Monthly / Annual select, "Use $X" of the typical month when there is none,
and a save that holds from the month on screen on, as the field says while you
edit it ("From October on; earlier months keep theirs");
the Categories row only shows the budget), and a **charge** — the charge's cards are its date (the editor for an effective
date) and its amount (bank data); its caption carries the category and its
plan membership; then the note and its verbs (exclude from totals, split),
the vendor's recent charges and its spend by year (evidence only: the
vendor's controls stay on the vendor's shelf, where "category" means every
charge).
The charge's name in its header drills up to the vendor, with Back, and so
does "Open vendor" under the list: one label, whatever the count. A
transaction row opens the charge.
On a phone the shelf is a bottom sheet, and its handle is a promise: the
sheet's top drags down to close.

**Buttons** — three tiers, named: primary (accent fill, at most one per page),
secondary (bordered), tertiary (text with an arrow, navigation only). A review
queue repeats one decision per row, so its accept is secondary and its
Dismiss quiet text — never a primary per row.
Destructive: secondary with `--bad` text, and only in a shelf.

**Pills and tags** — one pill: 11/500, full radius, 8px horizontal padding.
Tone says state: quiet border for the default, warn tint for what the user
chose, muted fill for what the system chose. The `edited` tag is the only tag.

---

## §3 — Design review checklist

Run against any new screen, component, or UI change. Each item maps to a §1
principle; a failed item means the design isn't done.

- [ ] **Visible** — every action reachable without hover; ≥1 always-visible anchor per surface. *(1)*
- [ ] **Teachable** — new concepts named in plain words and explained at the point of use. *(2)*
- [ ] **Reachable** — works on touch + keyboard with legible contrast, or the gap is written down. *(3)*
- [ ] **In-place** — corrections happen on the object, not in a settings panel; auto vs. edited is shown. *(4)*
- [ ] **Honest** — no provisional/partial number shown as final; qualified or withheld. *(5)*
- [ ] **Ranked** — the most important element is visually dominant. *(6)*
- [ ] **Consistent** — reuses the app's existing paradigm for this interaction; no new one-off. *(7)*
- [ ] **Complete states** — empty, loading, partial, and error all designed. *(8)*
- [ ] **Capable** — every object's create / edit-each-attribute / delete is reachable, or the omission is a written decision; nothing wired-in-the-API-but-unsurfaced. *(9)*
