# Daybook

[![tests](https://github.com/rod-feuer/daybook/actions/workflows/tests.yml/badge.svg)](https://github.com/rod-feuer/daybook/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-38BDF8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)](https://github.com/WiseLibs/better-sqlite3)

A local-only personal finance app: a daybook for a household. It keeps each day's
transactions, finds the recurring bills in them, and says where the month is heading,
on four screens: **Dashboard, Transactions, Categories, Recurrings**.

Built with Next.js 16 + Tailwind v4 + SQLite (better-sqlite3). All data stays on
your machine in `data/copilot.db` (gitignored) — nothing is sent anywhere except the
optional Claude categorization call (see below).

![Daybook dashboard](docs/dashboard.png)

> Shown with the built-in sample data.

## Prerequisites

- **Node 20+** (tested on Node 24). `better-sqlite3` is a native module, so a working
  C/C++ toolchain is needed — preinstalled on macOS (Xcode CLT) and most Linux setups.
- macOS or Linux. (Windows should work via WSL.)

## Setup

```bash
git clone https://github.com/rod-feuer/daybook.git
cd daybook
npm install
npm run dev            # http://localhost:3000
```

The SQLite database is created automatically on first run under `data/`. Charges
arrive from your bank: open the app and click **Sync from bank** (see
[Data sources](#data-sources)).

Bank sync needs the Plaid setup below; the rest of the app needs no environment variables.

## Environment variables

All optional. Put them in a `.env.local` file at the repo root (gitignored).

| Variable | Used for | Default |
|---|---|---|
| `TYPESAFE_API_KEY` | **Suggest categories** (preferred) — asks TypeSafe's Jev model about genuinely unknown merchants and gets a confidence back, so sure guesses, possible matches and "not sure" are told apart. Sends merchant names, category names, and up to three already-filed merchant names per category; never amounts, dates or accounts. | unset |
| `ANTHROPIC_API_KEY` | **Suggest categories** (fallback) — Claude Haiku answers when TypeSafe is unset or unreachable. No confidence, so every guess looks equally sure. Without either key, unknowns stay uncategorized. | unset |
| `PLAID_CLI_PATH` | **Sync from bank** — path to a `plaid` CLI binary that emits the expected JSON (advanced; the sync shells out to it). | `plaid` on `PATH` |
| `COPILOT_DB_PATH` | Override the SQLite file location. Tests set this to a throwaway file so they never touch `data/copilot.db`. | `data/copilot.db` |
| `APP_PASSWORD` | **Login gate.** When set, every page/API requires a session cookie (log in at `/login`). Leave unset for plain localhost dev — auth is off and nothing changes. **Set this before exposing the app beyond localhost** (e.g. over a private network / Tailscale). | unset (auth off) |
| `APP_SESSION_SECRET` | Optional key for signing the session cookie. Defaults to deriving from `APP_PASSWORD`; set it only if you want to rotate sessions independently. | derived from `APP_PASSWORD` |
| `DIGEST_IMESSAGE_TO` | **Daily digest.** The phone number (with country code) or Apple ID the daily text is sent to, through the Messages app on this Mac. Texting your own number works and does notify. | unset (the daily can only be printed) |
| `DIGEST_EMAIL_TO`, `SMTP_USER`, `SMTP_PASS` | **Weekly digest.** Where the Sunday email goes, and the account it is sent from. For Gmail, `SMTP_PASS` is a 16-letter **app password** (Google account → Security → App passwords; needs 2-step verification), never the account password. | unset (the weekly can only be printed) |
| `SMTP_HOST` | Mail server for the weekly digest. | `smtp.gmail.com` |

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env.local
```

## Scripts

```bash
npm run dev      # start the dev server (http://localhost:3000)
npm run build    # production build
npm start        # serve the production build
npm run lint     # eslint
npm test         # node:test suite (uses a temp DB via COPILOT_DB_PATH)
npm run smoke    # load every page/route in a real browser and assert no errors
                 # (requires the dev server running + Chrome; logs in with
                 # APP_PASSWORD from .env.local when the gate is on)
npm run test:clock  # re-run the suite against future clocks to catch date-rotted
                    # tests (ones that pass only because of today's date)
npm run digest -- daily   # send today's digest (what changed, what needs you) as an
                    # iMessage, only if there is something new; `weekly` emails the
                    # Sunday summary. Add --dry-run to print instead of sending, and
                    # --no-sync to skip the bank sync. Runs without the dev server.
npm run digest:install    # schedule both on this Mac (macOS LaunchAgents): the daily at
                    # 7:30am, the weekly on Sundays at 6pm, logging to data/digest.log.
                    # The Mac must be on and logged in; a run missed while asleep fires
                    # on wake. Re-run after moving the repo or upgrading Node (both
                    # paths are pinned). `npm run digest:uninstall` removes them.
```

## Design principle: code does the math, the model only judges

Per the project's CLAUDE.md (Rule 5), deterministic work is plain code; the model is
used for exactly one thing — classifying a *genuinely unseen* merchant into a category.

| Concern | How it's done |
|---|---|
| Dedupe, import, dashboard totals, cash-flow | Deterministic code (`src/lib/core.ts`) |
| Recurring detection (3+ regular, similar-amount charges) | Deterministic pattern match — **not** the model |
| Known-merchant categorization | Rule table (substring match), applied for free |
| **Unknown**-merchant categorization | On request: one TypeSafe Choice per merchant (or a batched Claude Haiku call as the fallback). Proposals go to the review queue; applying one caches it as a rule so it's never re-asked |

On 200 of the owner's already-categorized merchants the two tied on accuracy
(TypeSafe 59.5%, Haiku 61.5%, ±9.6). TypeSafe is preferred for its confidence:
at ≥0.8 it was right 80% of the time, below 0.5 only 38% — so the queue shows
the first as suggestions, the middle as "possible matches", and leaves the rest
under "need a closer look" instead of guessing.

Without either key, unknown merchants are simply left uncategorized (surfaced
in the UI, never silently faked).

## Data sources

- **Bank sync** (Plaid): the only source in the app. It runs on launch, from
  **Sync from bank**, and before each digest. See `src/lib/plaid.ts`.
- **Test fixtures only**: `POST /api/seed` (sample data) and `POST /api/import`
  (generic CSV: `Date, Name/Merchant/Description, Amount[, Account]`, negative =
  expense) exist only when `COPILOT_FIXTURES=1`, which `npm run test:ui` sets. In
  the app they return 404.

## Maintenance actions

- **Auto-categorize** — applies rules (free), then optionally the model for unknowns.
- **Clean up names** (Recurrings / Transactions) — re-tidies merchant names from their
  preserved original bank descriptors after the normalizer improves. Reversible via
  **Undo cleanup**; the original descriptor is kept in `rawMerchant`.
- **Re-scan** (Recurrings) — rebuilds recurring detection.

## Layout

- `src/lib/` — db, core logic (deterministic), categorize (model), import, queries, seed
- `src/app/api/` — route handlers
- `src/app/*/page.tsx` — the four screens
- `src/components/` — Sidebar, Shell, Actions (import/categorize/seed/month picker), shelf
- `tests/` — `node:test` suite (run with `npm test`)
