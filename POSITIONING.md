# POSITIONING.md — Product point of view & competitive strategy

> **Status (2026-06): Personal tool, not commercialized.** After this analysis plus an
> eight-strategist evaluation, the founder chose to keep copilot-lite as a personal tool.
> The biggest "what we have to believe" — *people will pay for a better-feeling owned finance
> app when a free, good, owned one (Actual) already exists* — is an unfavorable bet here
> (free OSS competition + papercut-level pain). This document stands as a **completed strategy
> exercise and a reusable template**; the buyability experiment has moved to a different
> problem. See memory note `copilot-lite-personal-tool-decision` for the decision + portable playbook.
>
> **Scope amended (2026-10-02): the whole household picture.** As a personal tool, Daybook's
> job is the owner's household, not a market segment, so the spending ledger grows into net
> worth, investments, and income and taxes (§12). Two §11 non-goals were revised to match.
> §1–§10 stand as written: they describe the market bet that was set aside.

This is the strategy companion to `DESIGN.md`. `DESIGN.md` says *how we build*;
this says *what we believe, who it's for, and why we win*. When a product,
scoping, or messaging call is ambiguous, the answer should be derivable from
here. Living doc — revise when the market or our conviction changes.

> **North star — Optimize for the moment of *correction*, not the moment of *consumption*.**
> Every mainstream finance app is built around the glance (the dashboard you
> check, the feed you skim). We believe the value of a personal-finance tool is
> the *accuracy of the ledger underneath it*, and accuracy only comes from a
> human curating it. So we make correcting the app's guesses effortless,
> transparent, and one tap — and we do it on data the user owns.

---

## §1 — The opinion (what we believe)

Three convictions, in priority order. Everything downstream serves them.

1. **Transparent, not automatic.** Show the guess *and* how sure we are (auto-vs-edited
   tags, confidence-ranked review queues) rather than silently auto-applying and
   being wrong. Automation that's wrong erodes the only thing that matters: trust.
2. **Annotate truth, don't fabricate it.** Bank transactions are immutable facts.
   You overlay corrections; you never invent or delete rows. The ledger stays honest.
3. **You own it.** Local-first, single-user, no ads, no attention-mining, no cloud
   reading your spending. (On "no subscription," see §9 — the app is buy-once-own;
   only optional convenience services recur.)

The wedge in one line: **everyone else optimizes the glance; we optimize the
correction.** Correction is the reason customers stay and love it; ownership is
the reason they show up.

### Who it's for
The person who'd otherwise keep a **spreadsheet** — they want to *understand and
curate* their money, not just be shown a number. Burned by Mint dying /
miscategorizing / nagging; find YNAB's method too much religion; uneasy handing a
cloud every transaction. **Gardeners who tend their data**, not dashboard-glancers.

---

## §2 — Positioning map (with market sizing)

Axes: **Cloud↔Owned** (X) × **Consumption/glance ↔ Correction/control** (Y).
Sizes are order-of-magnitude estimates from public proxies (vendors disclose
little) — a strategy map, not a forecast. Full method + sources in §2.1.

```
                        CORRECTION / control
                               │
   ┌─────────────────────────────┼─────────────────────────────┐
   │  OWNED × CORRECTION  ← US     │  CLOUD × CORRECTION          │
   │  Actual, Firefly, beancount,  │  Monarch, YNAB, Lunch Money  │
   │  spreadsheet curators         │                              │
   │  ~50–200k active self-host    │  ~2–4M US paying subscribers │
   │  households TODAY +           │  (Monarch ~0.5–1M, YNAB      │
   │  ~15–25M US spreadsheet tail  │  ~0.5M) — the willing-to-pay │
   │  (latent ceiling)             │  refugee wave                │
   ├─────────────────────────────┼─────────────────────────────┤
   │  OWNED × CONSUMPTION          │  CLOUD × CONSUMPTION          │
   │  ~0 — structurally empty.     │  ~100M+ US / hundreds of M    │
   │  A glance-only tool has no    │  global. Mint legacy/Credit   │
   │  reason to be self-hosted;    │  Karma, Rocket Money (~3.4M), │
   │  those users just use a bank  │  Copilot, bank apps. The mass │
   │  app.                         │  market.                     │
   └─────────────────────────────┼─────────────────────────────┘
                               │
                        CONSUMPTION / glance
   OWNED ◀──────────────────────────────────────────▶ CLOUD
```

- **Cloud apps believe delight + automation drive value** → engagement product,
  beautiful glance, trust-the-AI, subscription. They optimize **consumption**.
- **YNAB believes a method changes behavior** → zero-based dogma. Optimizes **discipline**.
- **Spreadsheets believe in total control** → truth & ownership, brutal manual labor.
- **We believe trust comes from transparency + effortless correction + ownership.**

**Read of the map:** Quadrants 1 (mass-market) and 2 (Monarch/YNAB's payers) are
large and well-funded. Quadrant 3 is structurally empty. **Our quadrant is a small
but real active-self-hoster base (~50–200k households) sitting in front of a large
latent spreadsheet-budgeter tail (~15–25M US)** — and *the gate between the two is
product friction (install + bank-sync), not demand.* That makes our ceiling a
**product lever, not a marketing one.** Monarch is the **market-sorter**: its
~0.5–1M subs prove the willing wave exists; our quadrant captures the residual who
won't go cloud.

### §2.1 — Sizing method & confidence
- **Anchors:** ~30–45M US budgeting-*app* users; ~40% of US budgeters use spreadsheets
  (→ ~15–25M, the latent tail); Mint had ~3.6M active at 2024 shutdown.
- **Quadrant 2** from `revenue ÷ ~$100/yr ARPU` (Monarch ~$12–13M ARR, $850M val on
  $75M Series B; YNAB ~$47M rev) — crude, treat ±2×.
- **Quadrant 4 active installs** inferred from GitHub stars (Actual ~27k, Firefly ~23.7k)
  + community size (r/selfhosted ~758k) — *lowest-confidence cell*; privacy tools don't
  phone home, so no telemetry exists.
- **Quadrant 3 ≈ 0** is a structural claim (no product, no incentive), high-confidence by reasoning.
- Sources: getlatka/Sacra (Monarch), Appic/Wikipedia (YNAB), Bloomberg (Mint), Rocket Money
  blog, Tracxn (Copilot), GitHub (Actual/Firefly), gummysearch (subreddits), Debt.com/WalletHub
  (budgeting method shares).

---

## §3 — Beachhead (which segment first)

The macro cut (`self-host ability × ownership-dealbreaker`) already decided the
**quadrant** — owned, not cloud. The cut that matters *now* picks the beachhead
**inside** it: their **job** × their **relationship to effort**.

```
                        "IT SHOULD JUST WORK" (pragmatist)
                                   │
   ┌────────────────────────────────┼────────────────────────────────┐
   │  PRIORITY 3  (expansion)        │  ★ PRIORITY 1  (beachhead)      │
   │  Wants the full picture, easily.│  Wants to understand & fix      │
   │  Needs us to add net worth/     │  their SPENDING, owned, &       │
   │  investments + easy install.    │  pleasant. "Copilot, owned."    │
   ├────────────────────────────────┼────────────────────────────────┤
   │  ✗  NOT US                       │  PRIORITY 2                     │
   │  Firefly / beancount / ledger-   │  Actual power-users, rules-     │
   │  cli. Comprehensive + loves to   │  lovers, spreadsheet curators.  │
   │  configure.                      │  Win with less config + polish. │
   └────────────────────────────────┼────────────────────────────────┘
                                   │
                     "CONFIGURING IT IS THE APPEAL" (tinkerer)
   COMPREHENSIVE ACCOUNTING ◀───────────────────▶ SPENDING UNDERSTANDING
```

**Beachhead = spending-curation × pragmatist.** Realistic SAM today **~50–200k
households** (the active-self-hoster ∩ won't-pay-cloud ∩ wants-polish slice),
reachable at near-zero CAC through existing communities. **P2** adds the
spreadsheet tail as install/sync friction falls (single-digit millions over time).
**P3** (full-picture pragmatists) is unlocked by *product* — dead-simple install +
robust sync + later net worth — not marketing.

---

## §4 — Differentiation (in-quadrant)

Judged against the consideration set our customer actually shops — Spreadsheet →
Actual → Firefly → us. Cloud apps excluded (already ruled out). Scale 1=weak /
2=parity / 3=best; importance reflects *our segment*.

| JTBD pull theme | Importance | Spreadsheet | Actual | Firefly | **Ours** |
|---|:--:|:--:|:--:|:--:|:--:|
| See where my money goes | Critical · stakes | 2 | 3 | 2 | **3** |
| Own it & keep it forever (private, unkillable) | Critical | 3 | 3 | 3 | **3** |
| ◀ Does the grunt work — auto-cleans merchants, detects recurring | Very | 1 | 1 | 1 | **3** |
| ◀ Fix a wrong guess in one tap — not configure a rule | Very | 1 | 2 | 1 | **3** |
| ◀ Shows its work, so I trust the numbers | Very | 2 | 2 | 2 | **3** |
| ◀ Genuinely pleasant to use (incl. mobile) | Very | 1 | 2 | 1 | **3** |
| Comprehensive: net worth, investments, multi-currency | Somewhat | 1 | 2 | 3 | 1 |
| Auto-connect every bank | Somewhat | 1 | 3 | 2 | 2 |

**Ownership is parity (3/3/3/3) — the entry ticket, not the edge.** The four ◀ rows
are our differentiation, collapsing into **three pillars**:

1. **Effortless accuracy** — system does the detection *and* one-tap correction. No rulebook.
2. **Transparency you can trust** — auto-vs-edited, confidence queues, honest projections.
3. **Actually pleasant** — design-led, mobile-first — *the owned tool as good to use as the cloud ones.*

Position = **owned + actually good.**

---

## §5 — Competitors

### Actual Budget — the one that matters most

> **Actual is YNAB-without-the-subscription. We're Copilot-without-the-cloud.**
> Same quadrant, opposite DNA. We don't win Actual's committed envelope-budgeter —
> we win **the person who bounced off Actual's method/rules** and just wants to see
> and fix their spending, owned.

| | **Actual Budget** | **Ours** |
|---|---|---|
| Core job | Run an envelope / zero-based budget | Understand & curate spending |
| Categorization | **Rules engine** you write & maintain | **Auto-detect + correct in place** |
| Merchant cleanup | A rule you author | **Auto-normalized**, reversible; tap to fix |
| Recurring bills | **You declare** (scheduled txns) | **We detect** from history; you confirm |
| Trust layer | Deterministic (you wrote the rules) | **Auto-vs-edited + confidence queues** |
| Posture | Desktop-first; mobile is a PWA | **Mobile-first, correction-first** |

**Where Actual beats us:** envelope budgeting depth; bank-sync robustness
(SimpleFIN/GoCardless); maturity, community, E2E-encrypted multi-device sync, fuller
ledger. If someone wants "YNAB that I own," send them to Actual. **The one place
Actual can hurt us is sync** — close that gap (§9).

### Firefly III
Comprehensive double-entry ledger, multi-currency, powerful rules, full API —
utilitarian + config-heavy. Its customer is the comprehensive-accounting tinkerer
(✗ in §3). We win only the **mis-sorted pragmatist** who adopted Firefly for
self-hosting and is drowning in its accounting model — not the satisfied accountant.

### Monarch / Copilot (cloud, out of quadrant)
Best cloud experiences; win anyone who'll trade ownership for turnkey polish + full
sync + investments + (Monarch) household. We don't contest that customer. Monarch =
our market-sorter (§2).

### YNAB / Spreadsheet
YNAB = cloud + method (adjacent to Actual's customer, not ours). Spreadsheet = the
status quo and our truest **mindshare** competitor — we're "the spreadsheet's
control & honesty, minus the labor."

---

## §6 — Switching friction (JTBD "Forces of Progress")

Our customer faces almost **no Push**: incumbents are free, owned, "good enough,"
and — critically — **have no billing trigger**, so the annual "is this worth it?"
reconsideration that pushed people off YNAB *never fires* for Actual/Firefly.
That structural inertia is the single biggest reason they don't shop around.
The two retarding forces, per competitor:

**Current Actual user**
- *Anxiety (High):* migration feels lossy — only a per-account, transactions-only CSV
  export exists; budget/envelope state, rules, schedules, payee-merges have **no UI
  export**. Plus "will a younger owned tool be as safe?" (Actual itself had data-loss
  scares). Re-doing bank sync into our *weaker* sync is scary.
- *Inertia (High):* **no billing trigger → no reconsideration moment**; hundreds of
  passively-accumulated rules + Category-Learning + payee merges (invisible,
  non-portable); "good enough + free + owned" matches their identity.

**Current Firefly user**
- *Anxiety (High):* losing multi-currency, double-entry/reporting, and the rules
  engine — all real downgrades *for them* (which is why most Firefly users aren't
  ours). Firefly's own export "isn't database-complete," so lock-in dread attaches to
  any move.
- *Inertia (High):* bespoke API integrations (Plaid bridges, SMS/Telegram/HA flows),
  years-accreted account graph + rules, raw `mysqldump`-only migration. Heavy sunk cost.

**Shared:** no clean/complete/portable export (dominant shared anxiety); re-doing
bank sync; free+owned+privacy identity with no renewal trigger; large invisible
categorization config that doesn't export.

**Frictions → opportunities for us:**
1. A **blessed importer** (ingests Actual CSV/`db.sqlite`, Firefly CSV/API) neutralizes
   the #1 shared anxiety.
2. **"Nothing to rebuild"** — their biggest sunk cost (rules/payee-merges) is exactly the
   labor our auto-detection erases. Reframe inertia as our Pull.
3. **Mobile** — Actual is PWA-only, Firefly has no official app. A clean capability Pull.
4. Sync is the **lone load-bearing gap** (§9) — also our chance to *neutralize* the
   "re-do sync" anxiety by making ours better, not worse.

---

## §7 — Go-to-market: friction-busting trial & adoption plan

Because there's almost no Push, adoption is won by **manufacturing the
reconsideration moment, crushing switching anxiety, and reframing sunk cost.**

1. **Crush migration anxiety (the #1 friction).**
   - Ship a **first-class importer** for Actual & Firefly; be radically honest about
     what carries (transactions, categories, payees→merchants, splits, notes) vs what
     we deliberately don't (envelopes, hand-built rules). *Honesty is the feature:
     "you won't rebuild your rules — there's nothing to rebuild, we detect for you."*
   - **Reversibility as trust:** one-click full export (the thing both incumbents fail
     at). *"Your data is never trapped — leave any time, take everything."* This beats
     any reassurance about a young tool's longevity.
   - **Run alongside, no cutover:** import read-only; let them keep the old tool while
     they evaluate. Zero-risk trial.

2. **Manufacture the reconsideration moment at pain spikes.** No billing trigger means
   we reach users *when the present hurts*: be present in r/actualbudget, r/FireflyIII,
   r/selfhosted, HN, and the project forums when "Actual sync is flaky / mobile's just a
   PWA" or "Firefly's overwhelming / my import broke / GoCardless re-auth again." Every
   such complaint is a qualified lead (Monarch-as-market-sorter logic, applied
   in-quadrant). SEO the exact triggers: *"Actual Budget alternative with better
   mobile," "Firefly III too complex," "self-hosted budget that auto-categorizes."*

3. **Reframe sunk cost as the wedge.** Lead with "Nothing to rebuild." Their inertia
   (rules, payee merges, account graph, learned model) is precisely the labor we erase.

4. **Self-selection by honesty.** We're deliberately weaker on envelopes (vs Actual) and
   accounting/multi-currency (vs Firefly) — *say so loudly* so committed
   budgeters/accountants self-select OUT (no churn) and the overwhelmed pragmatist
   self-selects IN: *"Love envelope budgeting? Use Actual. Firefly more than you want? We're for you."*

5. **Trial mechanics — time-to-first-value is the game.** Free, full-featured, **runs in
   5 minutes** (invest in dead-simple/one-click install — the P3 gate), and delivers an
   instant "it did the grunt work" wow on first import (auto-cleans merchants,
   auto-categorizes, surfaces recurring immediately).

---

## §8 — Feature scorecard (B / T / D vs Actual + Firefly)

Not all gaps are equal: a **B** that undercuts a pillar must be fixed; a **B**
off-strategy for the beachhead is conceded on purpose.

**D — Differentiated:** auto merchant normalization · automatic recurring detection ·
one-tap inline correction · auto-vs-edited legibility · confidence-ranked review
queues · honest-by-default figures · design-led mobile-first UX · in-page shelf.

**T — At parity (table stakes):** local-first/owned *(entry ticket)* · CSV import ·
per-category budgets · splits · spending-by-category · notes & effective/posted dates ·
exclude-from-totals · dark mode. *(Watch: Actual's envelope budgeting is deeper.)*

**B — Below parity:**
- **🔧 Fix (load-bearing — undercuts the Effortless pillar):** **bank auto-sync
  robustness.** Our Plaid CLI bridge < Actual's SimpleFIN/GoCardless. **Highest-leverage
  non-design investment** (and see §9 — also our recurring-revenue line).
- **✗ Concede (Firefly's customer's job, not ours):** investments/net-worth/full ledger ·
  multi-currency · reporting depth · public API/importer ecosystem · maturity.
- **Deliberate non-goals:** heavy rules engine; multi-user/household.

**Takeaway:** keep extending the three pillars, and **fix sync.** Everything else below
parity, leave alone — chasing it pulls us toward Firefly's quadrant.

---

## §9 — Pricing & monetization

**The anchor problem:** our in-quadrant rivals (Actual, Firefly) are **$0 OSS** — we
can't out-cheap them. The cloud apps charge **$95–$199/yr** for convenience our
customer has already declined. Mint proves "free" only works if you **monetize the
user** — the one thing our wedge forbids (it's the grave we exist in opposition to).

| Competitor | Model | Price |
|---|---|---|
| Actual / Firefly | Free OSS (self-host) | $0 (+ optional SimpleFIN ~$15/yr, 3rd-party hosting ~$9/mo) |
| Monarch | Subscription | ~$99/yr core (~$199 Plus) |
| Copilot | Subscription | ~$95/yr |
| YNAB | Subscription | ~$109/yr |
| Lunch Money | Subscription, pay-what-you-want | from ~$50/yr |
| Mint (RIP) | Free, ad/referral on your data | $0 — the cautionary tale |

**Recommended: "pay once, own it" one-time license for the app + an optional paid
managed bank-sync service.**
- **One-time license** *makes the price *be* the positioning* — against $95–$199/yr-forever
  rivals, "buy it once, own it" is the most legible expression of §1.3, and "no
  subscription" stays literally true *of the product you own*. Suggested band **$40–$80**
  ("less than a year of Monarch, owned forever"); free full-featured trial.
- **Optional managed sync (~$3–5/mo or ~$30–40/yr)** is the strategic unlock: it
  **closes the one load-bearing gap (§8), funds ongoing dev, and is the one recurring
  fee this segment already pays** (SimpleFIN precedent) — while the app stays free/owned
  and self-hosters can still bring their own SimpleFIN/CSV.
- Continuity funded by **paid major versions ("buy v2") + sync MRR**, never a creeping
  subscription on the base app.
- **Reject:** pure donations (won't fund the polish that *is* our edge); open-core (our
  non-goals remove the upsell surface; gating the wedge invites backlash); any ad/data
  model (it's Mint's grave).

**"No subscription" = a literal promise about the product, a vibe about the company:**
> *You buy the app once and own it forever — no recurring fee, no cloud reading your
> data. If you want us to handle bank-sync, that's an optional paid service you can take
> or leave; the app works without it.*

---

## §10 — Messaging (above-the-fold)

Fletch rule: **clarity before cleverness** — a stranger must know *what it is* from the
headline alone.

**Eyebrow:** Self-hosted personal finance
**Headline:** *Import your bank transactions. See where your money goes. Fix what the app gets wrong.*
**Subhead:** It cleans up messy merchant names, flags recurring bills, and suggests a
category for every charge — showing how sure it is, so correcting one takes a single tap.
Everything runs on your own computer. No cloud, no ads.
**Trust microcopy:** *Your ledger lives on your computer; we never read your spending —
and optional bank-sync is a pass-through relay, not a copy.*
**Visual:** the Transactions screen — 2-line rows with tappable category chips. The
philosophy made visible.

Challenger headline to test: *"All the control of a spreadsheet. None of the data entry."*

> **Messaging conflict resolved (per §9):** the old microcopy *"…never touch our servers —
> because we don't have any"* becomes false once managed sync exists. Use the revised
> trust line above. Don't ship both claims.

---

## §11 — Deliberate non-goals
- **No budgeting religion** (no envelopes/zero-based). *(That's Actual/YNAB.)*
- **No cloud / multi-tenant SaaS** for the core app. *(Optional managed sync is a relay, not the product.)*
- **No multi-user.** One person keeps one household's books, every account and both
  earners included, with no logins, roles or sharing. *(Revised 2026-10-02: it read "No
  household / multi-user"; the household is now the subject, §12, but there is still one
  operator.)*
- **No accounting system.** Net worth, investment balances, and income and taxes are in
  scope as balances and flows (§12). Holdings analytics, cost basis, trading, tax filing,
  bill pay and multi-currency stay out. *(Revised 2026-10-02: it read "No comprehensive
  accounting (investments/net worth/multi-currency) as a core bet — possible P3 expansion,
  never the lead".)*
- **No rules engine.** Correct-don't-configure is the point.

---

## §12 — Scope: the whole household picture (amended 2026-10-02)

**Why.** Daybook answers "where is this month heading?" well, but spending is one flow among
several. The owner's real question is "where do we stand?": what the household owns and owes,
whether savings are growing, and whether income and taxes are on track. Today Daybook sees
only spending accounts (cards and checking). Its categories already point at the rest:
payments to homes, vehicles, loans, education savings, insurance, a small business and
taxes leave the ledger toward balances it can't see.

**The picture, in three layers.** Each one is a balance or a flow over time, never a
second ledger.

| Layer | What Daybook shows | Where the numbers come from |
|---|---|---|
| **Net worth** | What the household owns (homes, vehicles, cash, investments) and owes (mortgages, loans, card balances), dated, as a trend | Linked accounts' balances from the bank, daily; property and vehicle values, and anything not linked, the owner sets |
| **Investments** | Brokerage, retirement and education-savings balances; contributions in; growth | Balances and contributions only. Holdings and analytics stay in the owner's separate local portfolio project |
| **Income and taxes** | Income by source (wages, business, investment income); tax paid so far against the year's projected liability | Paid so far from the ledger; the projection from the owner's separate local tax-projection project |

**The convictions carry over.**
- *Honest (§1, and DESIGN.md §1.5).* Every balance says the date it's as of. A value the
  owner sets (a home's worth) is marked as an estimate. A tax projection is labelled as a
  projection, never shown as what's owed.
- *Transparent, not automatic.* Each figure shows its source: from the bank, or set by
  the owner (the auto vs. edited rule, DESIGN.md §2).
- *Annotate truth.* Statement balances are facts, and the owner's valuations are overlays
  on them, the same rule as transactions.
- *Owned.* Local only. Sensitive figures never enter the repo, which is public: docs,
  tests and fixtures use sample data.

**What this changes in the ledger.** A transfer today leaves every total and goes nowhere
(DESIGN.md §2, "A category that isn't counted"). With balances it gets a destination: a
529 contribution or a loan payment moves money from spending into an asset or against a
liability, and the net worth layer shows it arrive.

**In:** balances over time, net worth and its trend, contributions, income by source,
tax paid against projected.
**Out:** trading, holdings analytics and cost basis (the portfolio project's job), tax
forms and filing (the tax project's job, and it doesn't file either), bill pay,
multi-currency, multi-user.

**Order.** Each layer is useful alone and builds on the one before.
1. **Accounts and balances**, ending in net worth: every account and asset with a dated
   balance, from the bank where it's linked and set by the owner where it isn't.
2. **Investments**: balances and contributions, read from the portfolio project.
3. **Income and taxes**: income by source and tax paid against the projection, read from
   the tax project.

**Decided 2026-10-04, before building layer 1.**
- *How balances arrive.* A linked account records its balance once a day, from the bank
  data the sync already pulls; nothing new is linked or bought for it. What isn't linked
  (a home, a vehicle, an account at an unlinked institution) takes a value the owner
  enters with its date. No statement import: the links cover what it would add.
- *Property and vehicle values* count in net worth by default, each tagged as an
  estimate with its date; one more than a year old says so.
- *Where it lives.* Net worth has its own page; the dashboard stays about the month.
- *The two local projects* are layers 2 and 3, so how they feed Daybook is decided when
  those layers are planned.

---

## The name — decided 2026-09-20: Daybook
The codename was `copilot-lite`, and **"Copilot" is a direct competitor's name**. The app
is now **Daybook**: the accounting journal where each day's transactions are first
written down. Renamed: the repo, the visible app name, the icon letter, the README and the
package. Deliberately not renamed: the database file and internal keys (`data/copilot.db`,
`COPILOT_DB_PATH`, `copilot:*` storage keys), the Copilot Money CSV importer (it names a
data source), and the local working folder.
