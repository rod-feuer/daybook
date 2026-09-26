// UI behaviour checks in a real browser — the guards for what the code review
// shipped: honest load states, keyboard rows, un-gated actions, partial-month
// qualifiers, statement-mode overlays, and split → undo. Self-contained: starts
// its own `next dev` on a spare port against a throwaway DB (seed + a small CSV
// fixture), no login gate, no Plaid, and tears it all down after.
//
// Run: `npm run test:ui` (Chrome via PUPPETEER_EXECUTABLE_PATH, default: Mac
// Google Chrome). Stop `next dev` first — both write to `.next`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const PORT = Number(process.env.UI_PORT || 3100);
const BASE = `http://localhost:${PORT}`;
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DB = path.join(os.tmpdir(), `copilot-ui-${process.pid}-${Date.now()}.db`);
const NEXT = path.join(process.cwd(), "node_modules", ".bin", "next");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = new Date();
const CUR = now.toISOString().slice(0, 7);
const PAST = "2026-03"; // inside the seed's pinned window (Dec 2025 – May 2026)
const day = (offsetMonths, d) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, d)).toISOString().slice(0, 10);

// ---------- server lifecycle ----------
const server = spawn(NEXT, ["dev", "-p", String(PORT)], {
  detached: true, // own process group, so the whole tree can be killed at the end
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    COPILOT_DB_PATH: DB,
    NEXT_DIST_DIR: ".next-ui", // its own build folder: the dev server can stay up
    APP_PASSWORD: "", // no login gate (an already-set var wins over .env.local)
    PLAID_CLI_PATH: "/nonexistent/plaid", // launch sync fails fast and stays quiet
    // The suite never calls a model: both keys are blanked, so the queue (which
    // asks on its own when a key is set) stays quiet. The one test about model
    // suggestions answers the queue's requests in the browser.
    TYPESAFE_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    NODE_OPTIONS: "--max-old-space-size=4096",
  },
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const stopServer = () => {
  try { process.kill(-server.pid, "SIGTERM"); } catch {}
  if (!process.env.UI_KEEP_DB) for (const ext of ["", "-wal", "-shm"]) fs.rmSync(DB + ext, { force: true }); else console.log("kept", DB);
};
process.on("exit", stopServer);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

async function waitForServer() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(BASE + "/api/months");
      if (r.status === 401) throw new Error("login gate is on — APP_PASSWORD leaked into the test server");
      if (r.ok) return;
    } catch (e) {
      if (String(e.message).includes("login gate")) throw e;
    }
    await sleep(1000);
  }
  throw new Error(`server did not come up on ${BASE}\n${serverLog.slice(-2000)}`);
}

// ---------- fixture ----------
async function loadFixture() {
  await fetch(BASE + "/api/seed", { method: "POST" });
  // Current-month rows (the seed is pinned to May 2026) + a recent Netflix run so
  // one recurring is ACTIVE, + a Chipotle charge for statement mode.
  const rows = [
    ["Date", "Name", "Amount", "Account"],
    [day(0, 1), "Acme Corp Paycheck", "5200", "Checking"],
    // Last month's paycheck too: with a prior month's income the dashboard
    // projects the month, and the summary card's tick and verdict are real.
    [day(-1, 1), "Acme Corp Paycheck", "5200", "Checking"],
    [day(0, 2), "Whole Foods Market", "-54.20", "Credit"],
    [day(0, 3), "Chipotle", "-18.75", "Credit"],
    [day(0, 6), "Shell Gas Station", "-48.10", "Credit"], // a counted charge past day 5, so the month projects
    [day(0, 6), "Card Payment Received", "500", "Credit"], // goes into an excluded category below
    // …and it is monthly, so the card's "thank you" is a plan in a category that
    // is not counted: neither a bill nor income on the Recurrings page.
    [day(-2, 6), "Card Payment Received", "500", "Credit"],
    [day(-1, 6), "Card Payment Received", "500", "Credit"],
    [day(-2, 3), "Netflix", "-15.49", "Credit"],
    [day(-1, 3), "Netflix", "-15.49", "Credit"],
    [day(0, 3), "Netflix", "-15.49", "Credit"],
    // A subscription with no charge yet this month, so the recurrings page has
    // an upcoming (or overdue) row, not only paid ones.
    [day(-3, 28), "Spotify", "-9.99", "Credit"],
    [day(-2, 28), "Spotify", "-9.99", "Credit"],
    [day(-1, 28), "Spotify", "-9.99", "Credit"],
    // A vendor with two subscriptions on different days (a two-plan vendor),
    // for the vendor shelf's plan list. The 4th is charged this month too: a
    // monthly plan 50 days silent reads as stopped and leaves the Recurrings
    // list, which made this fixture age out of the check on the 23rd.
    ...[3, 2, 1].flatMap((m) => [[day(-m, 4), "Streamly", "-9.99", "Credit"], [day(-m, 19), "Streamly", "-15.49", "Credit"]]),
    [day(0, 4), "Streamly", "-9.99", "Credit"],
    // A bill paid this month at more than it usually is, so its recurrings row
    // carries a difference ("+$15.50") under the amount on a phone. More than 10% off,
    // or the detector reads it as the new price and there is no difference to show.
    [day(-3, 2), "Comcast Business", "-79.99", "Credit"],
    [day(-2, 2), "Comcast Business", "-79.99", "Credit"],
    [day(-1, 2), "Comcast Business", "-79.99", "Credit"],
    [day(0, 2), "Comcast Business", "-95.49", "Credit"],
    // Two vendors no rule knows, so they land uncategorized: the Uncategorized
    // filter, the queue's "Show all uncategorized", and "categorize → the row
    // leaves" have real rows to act on.
    // One vendor under two spellings, so the merge queue has a card: with the
    // history-backed category suggestion below, the Transactions page then
    // holds two review-queue rows at once.
    [day(-3, 5), "Jimmy John's", "-11.20", "Credit"],
    [day(-3, 19), "Jimmy John's", "-9.85", "Credit"],
    [day(-3, 12), "Jimmy Johns", "-12.05", "Credit"],
    [day(-3, 26), "Jimmy Johns", "-10.40", "Credit"],
    [day(-1, 7), "Zylo Widget Works", "-31.00", "Credit"],
    [day(-1, 8), "Quorra Bakehouse", "-12.40", "Credit"],
    // A vendor with no category under two spellings: the rarer one is a
    // duplicate candidate, so its category waits on the merge decision. Two
    // months back, so the dashboard's four-row list for last month still
    // reaches Pinewood (the history proposal) below Streamly, Quorra and Zylo.
    [day(-3, 11), "Marlow's Deli", "-14.20", "Credit"],
    [day(-3, 25), "Marlow's Deli", "-16.80", "Credit"],
    [day(-2, 12), "Marlows Deli", "-15.10", "Credit"],
  ];
  const csv = rows.map((r) => r.join(",")).join("\n");
  const imp = await (await fetch(BASE + "/api/import", { method: "POST", body: csv })).json();
  if (!imp.inserted) throw new Error("fixture import inserted nothing: " + JSON.stringify(imp));
  const cats = await (await fetch(BASE + "/api/categories")).json();
  const groceries = cats.find((c) => c.name === "Groceries");
  // A vendor with two charges filed by hand and a third that arrives later
  // uncategorized: the queue proposes the category from history, so the
  // "change a suggestion before Apply" check has a real row. Irregular days
  // and amounts, or three charges on the 9th would read as a monthly plan and
  // the plan would backfill its category onto the third.
  {
    const first = await (await fetch(BASE + "/api/transactions?q=Pinewood&limit=5")).json();
    if ((first.rows ?? []).length === 0) {
      const csv2 = [["Date", "Name", "Amount", "Account"], [day(-3, 9), "Pinewood Hardware", "-40.00", "Credit"], [day(-3, 21), "Pinewood Hardware", "-9.00", "Credit"]].map((r) => r.join(",")).join("\n");
      await fetch(BASE + "/api/import", { method: "POST", body: csv2 });
      const rows = (await (await fetch(BASE + "/api/transactions?q=Pinewood&limit=5")).json()).rows ?? [];
      for (const r of rows) await fetch(`${BASE}/api/transactions/${r.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ categoryId: groceries?.id ?? null }) });
      const csv3 = [["Date", "Name", "Amount", "Account"], [day(-1, 4), "Pinewood Hardware", "-90.00", "Credit"]].map((r) => r.join(",")).join("\n");
      await fetch(BASE + "/api/import", { method: "POST", body: csv3 });
    }
  }
  if (!groceries) throw new Error("seed has no Groceries category");
  const b = await fetch(`${BASE}/api/categories/${groceries.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ budget: 500, period: "monthly" }),
  });
  if (!b.ok) throw new Error("could not set a budget");
  // An excluded category (a transfer bucket) holding an inflow: must never read as income.
  await fetch(BASE + "/api/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Transfers", icon: "↔", color: "#888888", kind: "expense" }) });
  const transfers = (await (await fetch(BASE + "/api/categories")).json()).find((c) => c.name === "Transfers");
  if (!transfers) throw new Error("could not create the Transfers category");
  await fetch(`${BASE}/api/categories/${transfers.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ excludeFromTotals: true }) });
  const cps = (await (await fetch(BASE + "/api/transactions?q=Card%20Payment&limit=5")).json()).rows ?? [];
  if (cps.length === 0) throw new Error("fixture row 'Card Payment Received' not found");
  for (const cp of cps) await fetch(`${BASE}/api/transactions/${cp.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ categoryId: transfers.id }) });
  await fetch(BASE + "/api/recompute", { method: "POST" }); // the plan takes its category
}

// A plan in a category that is not counted (Transfers) is neither a bill nor
// income: the Recurrings page leaves it out of both lists and names it in one
// line at the foot. Before, the lists split plans by sign alone, so a card's
// "Thank You" for its autopay read as recurring income.
async function notCountedPlans(browser) {
  await withPage(browser, async (page) => {
    const plan = (await (await fetch(BASE + "/api/recurrings?month=" + CUR)).json()).find((r) => /Card Payment Received/.test(r.merchant));
    record("not counted", "the fixture's card payment is a plan in a category that is not counted", !!plan && plan.categoryExcluded === 1, plan ? `${plan.merchant} ${plan.cadence}, excluded=${plan.categoryExcluded}` : "no plan");
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-drawer-row]")].map((x) => x.innerText.replace(/\s+/g, " "));
      return { listed: rows.some((t) => /Card Payment Received/.test(t)), foot: document.querySelector("[data-not-counted]")?.textContent.replace(/\s+/g, " ").trim() ?? null, income: !!document.body.innerText.match(/Recurring income/i) };
    });
    record("not counted", "it is in neither list, and the foot line names it with its category", !r.listed && !!r.foot && /Card Payment Received \(Transfers\)/.test(r.foot), `listed=${r.listed}; foot: ${r.foot}`);
  });
}

// ---------- helpers ----------
const results = [];
const record = (group, name, ok, detail = "") => {
  results.push({ group, check: name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${group} · ${name}${detail ? " — " + detail : ""}`);
};
const lowerText = (page) => page.evaluate(() => document.body.innerText.toLowerCase());
const shelfSel = "aside.fixed"; // the drawer; the sidebar is also an <aside>
const shelfIs = (page, open) =>
  page.waitForFunction((sel, want) => {
    const a = document.querySelector(sel);
    return (!!a && a.innerText.trim().length > 0) === want;
  }, { timeout: 8000 }, shelfSel, open);
const shelfSettled = (page) =>
  page.waitForFunction((sel) => { const a = document.querySelector(sel); return !!a && !a.querySelector(".animate-pulse"); }, { timeout: 8000 }, shelfSel);
const pickMonth = async (page, m) => {
  await page.evaluate((m) => {
    const s = [...document.querySelectorAll("select")].find((x) => [...x.options].some((o) => o.value === m));
    if (s) { s.value = m; s.dispatchEvent(new Event("change", { bubbles: true })); }
  }, m);
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }); // the month's data, not the old month's
};
async function withPage(browser, fn, { width = 1280, height = 900 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  try { await fn(page, errs); } finally { await page.close(); }
}

// ---------- cases ----------
// Only the latest shelf read may land. A slow read for vendor A that answered
// after the shelf had moved to vendor B used to put A's name, amounts and plan
// id under B's target, where an edit would mix the two. Hold A's read, open B,
// let A's late answer arrive: the shelf must still be B.
async function staleShelfRead(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const names = await page.$$eval("[data-drawer-row]", (rows) => rows.slice(0, 2).map((r) => r.children[1].textContent.replace("✎", "").trim()));
    await page.setRequestInterception(true);
    let held = false;
    page.on("request", (req) => {
      if (!held && req.url().includes("/api/merchant?")) { held = true; setTimeout(() => req.continue(), 2000); }
      else req.continue();
    });
    const rows = await page.$$("[data-drawer-row]");
    await rows[0].click(); await sleep(250); // A: its read is held
    await rows[1].click();                   // B: answers at once
    await sleep(3000);                       // A's late answer has landed
    const head = await page.$eval("[data-shelf] header", (h) => h.innerText.split("\n")[0].replace("✎", "").trim());
    record("stale shelf read", "a late answer for the previous vendor never replaces the open one", held && names.length === 2 && names[0] !== names[1] && head === names[1], `opened ${names[0]} then ${names[1]}; shelf shows ${head}`);
  });
}
// DESIGN.md §2 "Touch is in scope": on a phone (a coarse pointer) every small
// control's hit area is at least 32px tall, grown around the type by `tap` /
// `tap-native`. Measured by probing where a touch lands, since a pseudo-element
// widens what a control receives without changing its box.
async function tapTargets(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  try {
    for (const path of ["/transactions", "/recurrings", "/categories"]) {
      await page.goto(BASE + path, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const r = await page.evaluate(() => {
        const coarse = matchMedia("(pointer: coarse)").matches;
        const hits = (el, x, y) => { const h = document.elementFromPoint(x, y); return !!h && (h === el || el.contains(h)); };
        const short = [];
        let n = 0;
        for (const el of document.querySelectorAll(".tap, .tap-native")) {
          const b = el.getBoundingClientRect();
          if (b.width === 0 || b.top < 120 || b.bottom > innerHeight - 90) continue; // in view, clear of the header and the nav
          n++;
          const cx = b.left + b.width / 2;
          let top = b.top, bottom = b.bottom;
          for (let y = b.top - 1; y >= b.top - 16; y--) { if (hits(el, cx, y)) top = y; else break; }
          for (let y = b.bottom + 1; y <= b.bottom + 16; y++) { if (hits(el, cx, y)) bottom = y; else break; }
          // Name what took the touch instead, so a short target says why.
          const blocker = (y) => { const h = document.elementFromPoint(cx, y); return h ? `${h.tagName.toLowerCase()}.${[...h.classList].slice(0, 2).join(".")}` : "nothing"; };
          if (Math.round(bottom - top) < 32) short.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent.trim()).slice(0, 24)}" ${Math.round(bottom - top)}px (above: ${blocker(top - 1)}, below: ${blocker(bottom + 1)})`);
        }
        return { coarse, n, short };
      });
      record("tap targets", `${path}: every small control is at least 32px tall to a touch`, r.coarse && r.n > 0 && r.short.length === 0, r.coarse ? `${r.n} checked${r.short.length ? "; short: " + r.short.slice(0, 4).join(", ") : ""}` : "pointer: coarse not emulated");
    }
  } finally { await page.close(); }
}
async function honestLoadStates(browser) {
  const cases = [
    { route: "/", fail: /\/api\/dashboard/, empty: "nothing here yet", what: "the dashboard" },
    { route: "/transactions", fail: /\/api\/transactions\?/, empty: "no transactions match.", what: "transactions" },
    { route: "/categories", fail: /\/api\/categories(\?|$)/, empty: "no categories.", what: "categories" },
    { route: "/recurrings", fail: /\/api\/recurrings\?/, empty: "no recurring patterns", what: "recurring bills" },
  ];
  for (const c of cases) {
    await withPage(browser, async (page, errs) => {
      let failing = true;
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        if (failing && c.fail.test(req.url())) req.respond({ status: 500, contentType: "application/json", body: '{"error":"forced"}' });
        else req.continue();
      });
      await page.goto(BASE + c.route, { waitUntil: "domcontentloaded" });
      await page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t), { timeout: 15000 }, `couldn’t load ${c.what}`);
      const emptyShown = (await lowerText(page)).includes(c.empty);
      failing = false;
      await page.click("button::-p-text(Retry)");
      await page.waitForFunction(() => !document.body.innerText.includes("Couldn’t load"), { timeout: 15000 });
      record("load states", c.route, !emptyShown && errs.length === 0, emptyShown ? "empty state shown during error" : errs[0] || "error → retry → recovered");
    });
  }
  await withPage(browser, async (page, errs) => {
    let failing = false;
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (failing && /\/api\/(merchant|category)\?/.test(req.url())) req.respond({ status: 500, contentType: "application/json", body: '{"error":"forced"}' });
      else req.continue();
    });
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    failing = true;
    await page.click("[data-drawer-row]");
    await page.waitForFunction(() => document.body.innerText.includes("Couldn’t load this"), { timeout: 8000 });
    failing = false;
    await page.click(`${shelfSel} button::-p-text(Retry)`);
    let ok = true;
    try { await page.waitForFunction((sel) => !document.body.innerText.includes("Couldn’t load") && !document.querySelector(sel + " .animate-pulse"), { timeout: 8000 }, shelfSel); } catch { ok = false; }
    record("load states", "shelf", ok && errs.length === 0, ok ? "error → retry → loaded" : "did not recover");
  });
}

async function keyboardRows(browser) {
  await withPage(browser, async (page, errs) => {
    for (const route of ["/transactions", "/categories", "/recurrings"]) {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const f = await page.evaluate(() => { const el = document.querySelector("[data-drawer-row]"); el.focus(); return { focused: document.activeElement === el, role: el.getAttribute("role") }; });
      await page.keyboard.press("Enter");
      let opened = true; try { await shelfIs(page, true); } catch { opened = false; }
      await page.keyboard.press("Escape"); try { await shelfIs(page, false); } catch {}
      record("keyboard rows", route, f.focused && f.role === "button" && opened, `role=${f.role}, Enter opens shelf: ${opened}`);
    }
    // A transaction row opens the CHARGE's shelf (no row menu): the note
    // field and the charge's verbs are there, and Open vendor drills up.
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    await page.evaluate(() => document.querySelector("[data-drawer-row]").focus());
    await page.keyboard.press("Enter"); await shelfIs(page, true); await shelfSettled(page);
    const charge = await page.evaluate((sel) => { const a = document.querySelector(sel); const btns = [...a.querySelectorAll("button")].map((b) => b.textContent.trim()); const recent = a.querySelectorAll("[data-charge-recent] li").length; const marked = a.querySelectorAll("[data-charge-recent] [data-active]").length; return { note: !!a.querySelector("input[placeholder='What was this for?']"), verbs: btns.filter((x) => /totals|Split|Open vendor|charges →/.test(x)).length, menus: document.querySelectorAll("[data-drawer-row] button[aria-haspopup]").length, recent, marked }; }, shelfSel);
    record("keyboard rows", "Enter on a transaction opens the charge's shelf: note field, its verbs, no row menu", charge.note && charge.verbs >= 2 && charge.menus === 0, `note=${charge.note}, verbs=${charge.verbs}, row menus=${charge.menus}`);
    record("keyboard rows", "the charge's shelf lists the vendor's recent charges with this one marked", charge.recent >= 1 && charge.marked === 1, `${charge.recent} recent, ${charge.marked} marked`);
    // A recent row steps the shelf to that charge (when the vendor has another).
    {
      const other = await page.$(`${shelfSel} [data-charge-recent] li [role='button']`);
      if (other) {
        const before = await page.$eval(`${shelfSel} [data-charge-recent] [data-active]`, (e) => e.textContent);
        await other.click(); await shelfSettled(page); await sleep(300);
        const after = await page.$eval(`${shelfSel} [data-charge-recent] [data-active]`, (e) => e.textContent);
        record("keyboard rows", "a recent row steps the shelf to that charge", before !== after, `${before.trim().slice(0, 20)} → ${after.trim().slice(0, 20)}`);
      }
    }
    await page.keyboard.press("Escape");
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    const catRows = await page.$$("[data-drawer-row]");
    let ok = null;
    for (let i = 0; i < Math.min(catRows.length, 8) && ok === null; i++) {
      await catRows[i].click(); await shelfIs(page, true); await shelfSettled(page);
      if (!(await page.$(`${shelfSel} [role='button']`))) continue;
      await page.evaluate((sel) => document.querySelector(sel + " [role='button']").focus(), shelfSel);
      await page.keyboard.press("Enter");
      try { await page.waitForSelector(`${shelfSel} button::-p-text(Combine)`, { timeout: 8000 }); ok = true; } catch { ok = false; }
    }
    record("keyboard rows", "shelf row → vendor", ok === true, ok === null ? "no category with rows" : "");
    if (errs.length) record("keyboard rows", "page errors", false, errs[0]);
  });
}

// One page anatomy (DESIGN.md §2): the month picker is the FIRST control in
// the header's right-hand cluster on every page; search, filters and sort sit
// in a toolbar row under the header, never in it; at most one primary button.
async function pageHeader(browser) {
  await withPage(browser, async (page) => {
    for (const route of ["/", "/transactions", "/categories", "/recurrings"]) {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await page.waitForSelector("header h1");
      const r = await page.evaluate(() => {
        const header = document.querySelector("header");
        const cluster = header.querySelector("h1").parentElement.nextElementSibling;
        const first = cluster && cluster.querySelector("select, button, input, a");
        const monthFirst = !!first && first.tagName === "SELECT" && [...first.options].some((o) => /^\d{4}-\d{2}$/.test(o.value));
        // Import's hidden file input lives in the header; only a visible text input counts as search.
        const inputsInHeader = header.querySelectorAll("input:not([type=file]):not([type=hidden])").length;
        const primaries = document.querySelectorAll("main .btn-primary, header .btn-primary").length;
        return { monthFirst, inputsInHeader, primaries };
      });
      record("page header", `${route} month picker leads the header's right cluster; no search in the header; ≤1 primary button`, r.monthFirst && r.inputsInHeader === 0 && r.primaries <= 1, `monthFirst=${r.monthFirst}, inputs=${r.inputsInHeader}, primaries=${r.primaries}`);
    }
  });
}

// The dashboard in the app's anatomy: one summary card (as Categories and
// Recurrings), and the uncategorized queue as a section title above a card of
// standard rows — never a card nested in a tinted card.
async function dashboardAnatomy(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-summary]");
    const r = await page.evaluate(() => {
      const summary = document.querySelector("[data-summary]");
      const figures = summary ? summary.querySelectorAll(".stat-label").length : 0;
      const bar = !!summary?.querySelector("[role='progressbar']");
      const q = document.querySelector("[data-uncategorized]");
      const nested = document.querySelectorAll(".card .card").length;
      const rows = q ? q.querySelectorAll("[data-drawer-row] [data-category-property]").length : null;
      const summaryFirst = summary && q ? summary.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING : true;
      return { figures, bar, nested, rows, summaryFirst: !!summaryFirst, hasQueue: !!q };
    });
    record("dashboard", "one summary card with net, income and expenses and a bar", r.figures >= 3 && r.bar, `${r.figures} figures, bar=${r.bar}`);
    record("dashboard", "no card nested in a card", r.nested === 0, `${r.nested} nested`);
    // The queue's heading starts where its rows' text starts (structure, not a tuned offset).
    const align = await page.evaluate(() => {
      const q = document.querySelector("[data-uncategorized]");
      const h = q?.querySelector("h3")?.getBoundingClientRect().left;
      const t = q?.querySelector("[data-drawer-row] > div")?.getBoundingClientRect().left;
      return h == null || t == null ? null : { h, t };
    });
    record("dashboard", "the queue's heading lines up with its rows' text", !!align && Math.abs(align.h - align.t) < 0.5, align ? `heading ${align.h}px, row text ${align.t}px` : "no queue");
    // One frame: the three big figures are all month-end views or all actuals,
    // never a mix, and the headline can be checked on the card — income minus
    // expenses is the net. (It used to lead with a projected net beside two
    // actuals, built from a projected spend the card never showed.) They share a
    // top line, and the bar says what it measures.
    const f = await page.evaluate(() => {
      const card = document.querySelector("[data-summary]");
      const figs = [...card.querySelectorAll(".text-2xl")].map((el) => ({ value: Number(el.textContent.replace(/[^0-9.]/g, "")) * (/[−-]/.test(el.textContent) ? -1 : 1), label: el.nextElementSibling?.textContent.toLowerCase() ?? "", sub: el.nextElementSibling?.nextElementSibling?.textContent.toLowerCase() ?? "", top: Math.round(el.getBoundingClientRect().top) }));
      return { figs, caption: card.querySelector("[data-bar-caption]")?.textContent ?? "", eyebrow: card.querySelector("[data-eyebrow]")?.textContent.toLowerCase() ?? "", frameWords: (card.innerText.match(/projected|expected/gi) ?? []).length };
    });
    const [net, income, expenses] = f.figs;
    // The eyebrow is the month's name on every card; the labels are one word each (plus
    // "so far" while a month is in progress but too early to project); a
    // projected figure's frame is the "$X so far" beneath it (the projection is
    // the whole month, the actual is what has posted). Three labels each carried
    // "projected" before, and the card read as a paragraph.
    const forward = f.figs.every((x) => x.sub.includes("so far"));
    record("dashboard", "the three big figures are in one frame and reconcile: income − expenses = net", f.figs.length === 3 && /^net( so far)?\|income( so far)?\|expenses( so far)?$/.test(f.figs.map((x) => x.label).join("|")) && Math.abs(income.value - expenses.value - net.value) <= 1, `${f.eyebrow || "(no eyebrow)"}: ` + f.figs.map((x) => `${x.label} ${x.value}`).join(" | "));
    record("dashboard", "the eyebrow is the month's name, with no frame word; a projected figure carries its actual so far beneath it", /^(january|february|march|april|may|june|july|august|september|october|november|december)$/.test(f.eyebrow) && f.frameWords === 0, `"${f.eyebrow}" · ${f.frameWords} frame word(s) · ` + (forward ? f.figs.map((x) => x.sub).join(" | ") : "not projecting in this fixture month"));
    // The verdict is the card's sentence and reads first. Two panels: the
    // three figures as equal columns from the left, and the budget (its label,
    // its share, the bar, the note) to their right, level with them — one
    // column in a full-width card left the right two thirds empty.
    const order = await page.evaluate(() => { const card = document.querySelector("[data-summary]"); const y = (sel) => Math.round(card.querySelector(sel)?.getBoundingClientRect().top ?? -1); const figs = [...card.querySelectorAll(".text-2xl")].map((e) => e.getBoundingClientRect()); const panel = card.querySelector("[data-budget-panel]").getBoundingClientRect(); const bar = card.querySelector("[role=progressbar]").getBoundingClientRect(); const cap = card.querySelector("[data-bar-caption]")?.getBoundingClientRect(); const pitch = figs.length === 3 ? [Math.round(figs[1].left - figs[0].left), Math.round(figs[2].left - figs[1].left)] : []; const barBottom = Math.round(bar.bottom); const inPanel = !!card.querySelector("[data-budget-panel] [data-status]"); return { statusUnderBar: inPanel && y("[data-status]") >= barBottom, pitch, panelRight: figs.length ? panel.left > figs[figs.length - 1].right : false, panelLevel: figs.length ? Math.abs((panel.top + panel.bottom) / 2 - (figs[0].top + figs[0].bottom) / 2) <= 24 : false, capAboveBar: cap ? cap.bottom <= bar.top + 1 && cap.right >= bar.right - 32 : null }; });
    // The card's inner grid is the page grid (3:2, 24px gap) run to the
    // card's edges: the three figures span the chart card's width below and
    // start on its text; the hairline stands in the middle of the gutter; the
    // budget panel's text starts on the category card's text.
    const aligned = await page.evaluate(() => { const cards = [...document.querySelectorAll(".card")]; const chart = cards.find((c) => /Spending this month/.test(c.textContent))?.getBoundingClientRect(); const cat = cards.find((c) => /Spending by category/.test(c.textContent))?.getBoundingClientRect(); const title = [...document.querySelectorAll("h3")].find((h) => /Spending by category/.test(h.textContent))?.getBoundingClientRect(); const label = document.querySelector("[data-budget-panel] .stat-label")?.getBoundingClientRect(); const cell = document.querySelector("[data-summary] [data-figure-pair]")?.parentElement?.getBoundingClientRect(); const figs = [...document.querySelectorAll("[data-summary] .text-2xl")].map((e) => e.getBoundingClientRect()); if (!chart || !cat || !title || !label || !cell || figs.length !== 3) return null; return { line: Math.round(cell.right + 12 - (chart.right + cat.left) / 2), firstFig: Math.round(figs[0].left - (chart.left + 24)), lastFigInside: figs[2].right <= chart.right, text: Math.round(label.left - title.left) }; });
    record("dashboard", "the hairline is centred in the gutter below; the figures span the chart card and the budget panel's text starts on the category card's", !!aligned && Math.abs(aligned.line) <= 1 && Math.abs(aligned.firstFig) <= 1 && aligned.lastFigInside && Math.abs(aligned.text) <= 1, aligned ? `line Δ${aligned.line}px from gutter centre; first figure Δ${aligned.firstFig}px from the chart's text; last inside=${aligned.lastFigInside}; panel text Δ${aligned.text}px` : "cards not found");
    // The projected month end is a tick on the budget bar, so the verdict can
    // be checked against the gauge: under budget, the tick is short of the end
    // by the amount the sentence names. The fixture is too early to project,
    // so the tick is absent there and the check reads the sentence instead.
    const tick = await page.evaluate(() => { const card = document.querySelector("[data-summary]"); const bar = card.querySelector("[role=progressbar]").getBoundingClientRect(); const mark = card.querySelector("[data-bar-mark]")?.getBoundingClientRect(); const verdict = card.querySelector("[data-status]")?.textContent ?? ""; const m = verdict.match(/finish \$([\d,]+) (under|over) budget/); const total = Number((card.querySelector("[data-bar-caption]")?.textContent.match(/of \$([\d,]+)/)?.[1] ?? "0").replace(/,/g, "")); if (!mark) return { absent: true, tooEarly: /too early/i.test(verdict) }; const at = ((mark.left + mark.right) / 2 - bar.left) / bar.width; const said = m ? Number(m[1].replace(/,/g, "")) : null; return { absent: false, at, expected: said != null && total ? (m[2] === "under" ? 1 - said / total : 1) : null }; });
    record("dashboard", "the budget bar carries a tick at the projected month end, short of the end by what the verdict says", tick.absent ? tick.tooEarly : tick.expected != null && Math.abs(tick.at - tick.expected) <= 0.01, tick.absent ? `no tick: ${tick.tooEarly ? "too early to project, as the verdict says" : "but the month is projected"}` : `tick at ${(tick.at * 100).toFixed(1)}%, verdict implies ${(tick.expected * 100).toFixed(1)}%`);
    record("dashboard", "the verdict is the budget panel's conclusion, under its bar; the figures are equal columns; the panel sits to their right, level, its share above its bar", order.statusUnderBar && order.pitch.length === 2 && order.pitch[0] === order.pitch[1] && order.panelRight && order.panelLevel && order.capAboveBar === true, `verdict under bar=${order.statusUnderBar}; column pitch ${order.pitch.join("/")}px; panel right=${order.panelRight}, level=${order.panelLevel}; caption above bar=${order.capAboveBar}`);
    record("dashboard", "the figures share a top line, and the bar says its share of the whole without repeating the spent figure", new Set(f.figs.map((x) => x.top)).size === 1 && /^\d+% of \$[\d,]+$/.test(f.caption.trim()), `tops ${f.figs.map((x) => x.top).join(",")}; "${f.caption}"`);
    // The budget story is told once, in the summary card. A second copy of it
    // (a "Budgeted spend" block with its own bar) and a strip under the chart
    // repeated the same figures up to four times. What only the block said
    // survives as one line on the card: spending outside budgeted categories,
    // bridging the bar's figure to the Expenses figure.
    const once = await page.evaluate(() => { const main = document.querySelector("main").innerText; const cap = document.querySelector("[data-bar-caption]")?.textContent ?? ""; const total = cap.match(/of (\$[\d,]+)$/)?.[1] ?? null; const n = (t) => Number(t.replace(/[^0-9.]/g, "")); const note = document.querySelector("[data-summary] [data-hint]")?.getAttribute("data-hint") ?? ""; const extra = n(note.match(/\$[\d,]+/)?.[0] ?? "0"); const figs = [...document.querySelectorAll("[data-summary] .text-2xl")]; const sub = figs[2]?.nextElementSibling?.nextElementSibling?.textContent ?? ""; const all = n(/so far/.test(sub) ? sub : (figs[2]?.textContent ?? "0")); const pct = n(cap.match(/^\d+%/)?.[0] ?? "0"); const spent = Math.round((pct / 100) * n(total ?? "0")); return { total, totalCount: total ? main.split(`of ${total}`).length - 1 : 0, bars: document.querySelectorAll("[data-summary] [role=progressbar]").length, block: /Budgeted spend/i.test(main), strip: /avg \/ day/i.test(main), note, bridges: note ? Math.abs(spent + extra - all) <= 3 : null }; }); // ±$3: the bar's share is a whole percent of a $500 budget
    record("dashboard", "the budget is stated once: no second budget block, no figure strip under the chart", once.total !== null && once.totalCount === 1 && !once.block && !once.strip, `"of ${once.total}" appears ${once.totalCount}×, block=${once.block}, strip=${once.strip}`);
    record("dashboard", "spending outside budgeted categories is a hint beside the bar's caption (no line of its own), and the bar's share plus it is the Expenses figure", once.bridges === true && /^The bar leaves out \$[\d,]+ spent in categories without a budget\.$/.test(once.note), once.note || "no hint");
    record("dashboard", "uncategorized queue is standard rows below the summary (when present)", !r.hasQueue || (r.rows > 0 && r.summaryFirst), r.hasQueue ? `${r.rows} rows, summary first=${r.summaryFirst}` : "no queue in the fixture");
  });
}

async function restingActions(browser) {
  await withPage(browser, async (page) => {
    // The guard is the RESTING value (the control exists without hover). The
    // hover strengthening is only checkable where the browser reports a hover-
    // capable pointer — Tailwind wraps `hover:` in @media (hover: hover), and
    // headless Linux Chrome reports none, so there the hover half is n/a.
    const canHover = await page.evaluate(() => matchMedia("(hover: hover)").matches);
    const measure = async (label, selector) => {
      const h = await page.waitForSelector(selector, { timeout: 8000 });
      const rest = Number(await h.evaluate((el) => getComputedStyle(el).opacity));
      await h.hover(); await sleep(250);
      const hover = Number(await h.evaluate((el) => getComputedStyle(el).opacity));
      await page.mouse.move(0, 0); await sleep(150);
      const ok = rest >= 0.5 && (!canHover || hover >= 0.99);
      record("resting actions", label, ok, `rest ${rest}, hover ${canHover ? hover : "n/a (no hover pointer)"}`);
    };
    // The category's verbs live in its shelf (no verb on the row).
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const rowVerbs = await page.$$eval("[data-drawer-row] button", (bs) => bs.filter((b) => /delete|exclude from totals/i.test(b.textContent || b.getAttribute("aria-label") || "")).length);
    record("resting actions", "categories · no delete or exclude verb on a row", rowVerbs === 0, `${rowVerbs} row verbs`);
    await page.click("[data-drawer-row]"); await shelfIs(page, true); await shelfSettled(page);
    await measure("shelf · exclude from totals", `${shelfSel} button::-p-text(xclude from totals)`);
    await measure("shelf · delete category", `${shelfSel} button[aria-label^='Delete ']`);
    // No row menu on the category shelf either: its rows carry a glyph and an amount.
    const shelfMenus = await page.$$eval(`${shelfSel} button[aria-label='Edit transaction']`, (bs) => bs.length);
    record("resting actions", "shelf · no row menu on the category shelf", shelfMenus === 0, `${shelfMenus} menus`);
    // One shelf anatomy (DESIGN.md §2): at most two property cards, and the
    // way out follows the content rather than sitting in a pinned footer. The
    // link is found by where it goes: its label carries the count, or names
    // the vendor on a plan's shelf.
    for (const [route, label] of [["/categories", "category shelf"], ["/recurrings", "vendor shelf"]]) {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await page.click("[data-drawer-row]"); await shelfIs(page, true); await shelfSettled(page);
      const a = await page.evaluate((sel) => { const s = document.querySelector(sel); const cards = s.querySelectorAll("[data-property-card]").length; const link = s.querySelector("a[href^='/transactions?']"); const inScroll = !!link && !link.closest("footer") && !!link.closest(".overflow-y-auto"); return { cards, inScroll }; }, shelfSel);
      record("resting actions", `${label} · ≤2 property cards; the View-all link follows the content`, a.cards <= 2 && a.inScroll, `${a.cards} cards, link in scroll body=${a.inScroll}`);
      await page.keyboard.press("Escape");
    }
    // One category treatment: the quiet property, no tint, on both list pages.
    for (const route of ["/transactions", "/recurrings"]) {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row] [data-category-property]");
      const r = await page.$$eval("[data-drawer-row] [data-category-property]", (els) => {
        const visible = els.filter((e) => e.offsetParent !== null);
        const tinted = visible.filter((e) => { const bg = getComputedStyle(e).backgroundColor; return bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent"; }).length;
        return { n: visible.length, tinted, tints: [...new Set(els.map((e) => e.querySelector("select") ? "select" : "none"))] };
      });
      record("resting actions", `${route} · category is the quiet property (no tint, native select)`, r.n > 0 && r.tinted === 0 && r.tints.join() === "select", `${r.n} properties, ${r.tinted} tinted`);
    }
  });
}

async function partialMonthQualifiers(browser) {
  await withPage(browser, async (page) => {
    const check = async (route, month, needles, expect) => {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await pickMonth(page, month);
      const t = await lowerText(page);
      for (const n of needles) {
        const present = t.includes(n.toLowerCase());
        record("qualifiers", `${route} ${month} "${n}"`, present === expect, expect ? (present ? "present" : "MISSING") : (present ? "SHOWN on a past month" : "absent"));
      }
    };
    await check("/", CUR, ["so far"], true); // "$X so far" under each figure
    await check("/categories", CUR, ["spent so far"], true); // the label
    await check("/recurrings", CUR, ["paid so far"], true); // the label
    await check("/transactions", CUR, ["· net", "so far"], true);
    await check("/", PAST, ["so far", ", projected"], false);
    // A finished month's summary is plain actuals: no forward-looking word in the
    // card. (Scoped to the card: the chart's legend says "Projected" on any month.)
    const pastCard = (await page.evaluate(() => document.querySelector("[data-summary]")?.innerText ?? "")).toLowerCase();
    record("qualifiers", `/ ${PAST} summary card is plain actuals`, pastCard.length > 0 && !/so far|projected|expected|on pace/.test(pastCard), pastCard.replace(/\s+/g, " ").slice(0, 120));
    await check("/categories", PAST, ["so far"], false);
    await check("/recurrings", PAST, ["so far"], false);
    await check("/transactions", PAST, ["so far"], false);
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    await page.click("[data-drawer-row]"); await shelfIs(page, true); await shelfSettled(page);
    const shelf = (await page.evaluate((sel) => document.querySelector(sel).innerText, shelfSel)).toLowerCase();
    // "spent so far" always; the trend line reads "… vs last month so far" when
    // there is a last month to compare with, and "new this month" when not.
    record("qualifiers", "shelf (category, current month)", shelf.includes("spent so far") && (!shelf.includes("vs last month") || shelf.includes("vs last month so far")), shelf.includes("vs last month") ? "trend qualified" : "no prior month in the fixture");
  });
}

// A vendor view's header counts and totals only the charges that count — the
// same rule as the page's net above it. Summing every row put an excluded
// duplicate into the total, so one screen read "net −$1,200.00" over
// "−$1,300.00 total".
async function vendorHeaderCounts(browser) {
  await withPage(browser, async (page) => {
    const url = BASE + "/transactions?vendor=Chipotle";
    await page.goto(url, { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-vendor-total]");
    const read = () => page.evaluate(() => {
      const money = (s) => Number(s.replace(/[^0-9.]/g, ""));
      const head = document.querySelector("[data-vendor-total]").closest("div.flex").innerText;
      const sub = [...document.querySelectorAll("p, div, span")].map((e) => e.textContent).find((x) => /^\d+ shown · net/.test(x || "")) || "";
      return { total: money(document.querySelector("[data-vendor-total]").textContent), net: money(sub.split("net")[1] || ""), count: Number((head.match(/(\d+) transactions?/) || [])[1]), notCounted: Number((head.match(/(\d+) not counted/) || [0, 0])[1]), rows: document.querySelectorAll("[data-drawer-row]").length };
    });
    const before = await read();
    const id = await page.evaluate(async () => { const d = await (await fetch("/api/transactions?vendor=Chipotle&limit=50")).json(); return (d.rows ?? d.transactions ?? d)[0].id; });
    const amount = await page.evaluate(async (id) => { const d = await (await fetch(`/api/transactions/${id}`)).json(); await fetch(`/api/transactions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ excluded: true }) }); return Math.abs(d.amount); }, id);
    await page.goto(url, { waitUntil: "networkidle2" }); await page.waitForSelector("[data-vendor-total]");
    const after = await read();
    await page.evaluate(async (id) => { await fetch(`/api/transactions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ excluded: false }) }); }, id);
    const cents = (n) => Math.round(n * 100);
    record("vendor header", "an excluded charge leaves the header's total and count, and is named as not counted",
      before.notCounted === 0 && cents(before.total) === cents(before.net) && after.rows === before.rows && after.count === before.count - 1 && after.notCounted === 1 && cents(after.total) === cents(before.total - amount) && cents(after.total) === cents(after.net),
      `before ${before.count} tx $${before.total} (net $${before.net}); after ${after.count} tx + ${after.notCounted} not counted $${after.total} (net $${after.net}), ${after.rows} rows still listed`);
  });
}

// The heading names a category for the whole vendor, and a row matching it
// hides its own. Ben Franklin's two houses split its charges, so the heading
// said Lake Home over the Carmel charges and the Lake rows showed nothing. A
// vendor whose charges disagree names no category; one that agrees still does.
async function vendorHeaderCategory(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    const setup = await page.evaluate(async () => {
      const rows = (await (await fetch("/api/transactions?vendor=Streamly&limit=50")).json()).rows;
      const cats = (await (await fetch("/api/categories")).json()).filter((c) => c.kind === "expense");
      const [a, b] = cats;
      const before = rows.map((r) => [r.id, r.categoryId]);
      for (const r of rows) await fetch(`/api/transactions/${r.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ categoryId: Math.abs(r.amount) < 10 ? a.id : b.id }) });
      return { before, names: [a.name, b.name], n: rows.length };
    });
    const read = async (vendor) => {
      await page.goto(BASE + `/transactions?vendor=${vendor}`, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-vendor-total]");
      return page.evaluate(() => ({
        head: document.querySelector("[data-vendor-total]").closest("div.flex").innerText,
        rows: [...document.querySelectorAll("[data-drawer-row]")].map((r) => r.innerText),
      }));
    };
    const mixed = await read("Streamly");
    const [a, b] = setup.names;
    const eachRowNamed = mixed.rows.length === setup.n && mixed.rows.every((t) => t.includes(a) || t.includes(b));
    record("vendor header", "a vendor whose charges sit in two categories names neither in its heading, and every row shows its own",
      !mixed.head.includes(a) && !mixed.head.includes(b) && eachRowNamed,
      `heading "${mixed.head.split("\n").slice(0, 2).join(" / ")}"; ${mixed.rows.filter((t) => t.includes(a) || t.includes(b)).length}/${setup.n} rows named`);
    const agree = await page.evaluate(async () => {
      const r = (await (await fetch("/api/transactions?vendor=Chipotle&limit=50")).json()).rows[0];
      return r.categoryName;
    });
    const shared = await read("Chipotle");
    record("vendor header", "a vendor whose charges agree still names its category in the heading",
      !!agree && shared.head.includes(agree), `"${agree}" in heading=${!!agree && shared.head.includes(agree)}`);
    await page.evaluate(async (before) => {
      for (const [id, categoryId] of before) await fetch(`/api/transactions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ categoryId }) });
    }, setup.before);
  });
}

// Split drift: a split rule matches to the cent, so a price change makes it miss
// silently. The charge it missed is tagged in the list, its shelf says why and
// offers the same parts scaled to the new total, and one tap splits it.
async function splitDrift(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/transactions?vendor=Chipotle", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const setup = await page.evaluate(async () => {
      const d = await (await fetch("/api/transactions?vendor=Chipotle&limit=50")).json();
      const rows = (d.rows ?? d.transactions ?? d).filter((r) => r.amount < 0 && !r.excluded && !r.pending);
      const mags = rows.map((r) => Math.abs(r.amount));
      let pair = null;
      for (const a of rows) for (const b of rows) {
        const A = Math.abs(a.amount), B = Math.abs(b.amount);
        if (a.id !== b.id && Math.abs(A - B) > 0.01 && Math.abs(A - B) <= 0.1 * A && mags.filter((m) => Math.abs(m - B) < 0.005).length === 1 && mags.filter((m) => Math.abs(m - A) < 0.005).length === 1) { pair = [a, b]; break; }
      }
      if (!pair) return { error: "no two fixture charges within 10% of each other: " + mags.join(", ") };
      const cats = await (await fetch("/api/categories")).json();
      const [c1, c2] = cats.filter((c) => c.kind === "expense").slice(0, 2);
      const A = Math.abs(pair[0].amount), half = Math.round(A * 50) / 100;
      const res = await fetch(`/api/transactions/${pair[0].id}/split`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parts: [{ categoryId: c1.id, amount: half, label: "Mine" }, { categoryId: c2.id, amount: Number((A - half).toFixed(2)), label: "Theirs" }] }) });
      return { ruleCharge: pair[0].id, missed: pair[1].id, missedAmount: Math.abs(pair[1].amount), ok: res.ok };
    });
    if (setup.error || !setup.ok) { record("split drift", "fixture", false, setup.error ?? "could not create the split rule"); return; }
    try {
      await page.goto(BASE + "/transactions?vendor=Chipotle", { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const tagged = await page.$$eval("[data-drawer-row]", (rows) => rows.filter((r) => r.querySelector("[data-split-drift-tag]")).map((r) => r.innerText.replace(/\s+/g, " ")));
      const money = "$" + setup.missedAmount.toFixed(2);
      record("split drift", "the list tags the charge the rule missed, and only it", tagged.length === 1 && tagged[0].includes(money), `${tagged.length} tagged: ${tagged[0] ?? ""}`);
      await page.evaluate(() => { const r = [...document.querySelectorAll("[data-drawer-row]")].find((x) => x.querySelector("[data-split-drift-tag]")); r.scrollIntoView({ block: "center" }); r.click(); });
      await shelfIs(page, true); await shelfSettled(page);
      const notice = await page.$eval(`${shelfSel} [data-split-drift]`, (n) => n.innerText.replace(/\s+/g, " ")).catch(() => null);
      const sums = notice ? [...notice.matchAll(/(?:Mine|Theirs) \$([0-9.,]+)/g)].reduce((a, m) => a + Number(m[1].replace(/,/g, "")), 0) : 0;
      record("split drift", "the shelf says the rule missed and offers the same parts, summing to this charge", !!notice && /wasn.t split/.test(notice) && Math.round(sums * 100) === Math.round(setup.missedAmount * 100), notice ?? "no notice");
      await page.click(`${shelfSel} [data-split-drift] button`);
      const split = await page.waitForFunction((sel) => /Undo split \(2 parts\)/.test(document.querySelector(sel)?.innerText ?? "") && !document.querySelector(sel + " [data-split-drift]"), { timeout: 10000 }, shelfSel).then(() => true).catch(() => false);
      record("split drift", "one tap splits it the same way, and the notice is gone", split, split ? "Undo split (2 parts)" : "still unsplit");
    } finally {
      await page.evaluate(async (s) => { for (const id of [s.missed, s.ruleCharge]) await fetch(`/api/transactions/${id}/split`, { method: "DELETE" }); }, setup);
    }
  });
}

// A split rule is listed in its vendor's shelf and can be removed there: two
// presses (the first arms it), and the charge it split counts whole again.
async function splitRulesInShelf(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/transactions?vendor=Chipotle", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const setup = await page.evaluate(async () => {
      const d = await (await fetch("/api/transactions?vendor=Chipotle&limit=50")).json();
      const t = (d.rows ?? d.transactions ?? d).find((r) => r.amount < 0 && !r.excluded && !r.pending);
      const cats = (await (await fetch("/api/categories")).json()).filter((c) => c.kind === "expense").slice(0, 2);
      const A = Math.abs(t.amount), half = Math.round(A * 50) / 100;
      const res = await fetch(`/api/transactions/${t.id}/split`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parts: [{ categoryId: cats[0].id, amount: half, label: "Mine" }, { categoryId: cats[1].id, amount: Number((A - half).toFixed(2)), label: "Theirs" }] }) });
      return { id: t.id, ok: res.ok };
    });
    if (!setup.ok) { record("split rules", "fixture", false, "could not create the split"); return; }
    try {
      await page.goto(BASE + "/transactions?vendor=Chipotle", { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      await page.evaluate(() => { const r = [...document.querySelectorAll("[data-drawer-row]")].find((x) => !/split ·|excluded/.test(x.innerText)); r.click(); });
      await shelfIs(page, true); await shelfSettled(page);
      await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button, ${sel} a`)].find((b) => /charges →|Open vendor/.test(b.textContent))?.click(), shelfSel);
      const listed = await page.waitForSelector(`${shelfSel} [data-split-rules]`, { timeout: 8000 }).then(() => true).catch(() => false);
      const text = listed ? await page.$eval(`${shelfSel} [data-split-rules]`, (n) => n.innerText.replace(/\s+/g, " ")) : "";
      record("split rules", "the vendor's shelf lists its split, with its parts and how many charges it split", listed && /into Mine .* Theirs .*applied to 1 charge/.test(text), text || "no Splits section");
      if (listed) {
        const btn = `${shelfSel} [data-split-rules] button[aria-label^='Remove']`;
        await page.click(btn); await sleep(200);
        const armed = await page.$eval(btn, (b) => b.textContent.trim());
        const stillThere = await page.evaluate(async (id) => (await (await fetch(`/api/transactions/${id}`)).json()).excluded === 1, setup.id);
        await page.click(btn);
        const gone = await page.waitForFunction((sel) => !document.querySelector(`${sel} [data-split-rules]`), { timeout: 10000 }, shelfSel).then(() => true).catch(() => false);
        const restored = await page.evaluate(async (id) => { const t = await (await fetch(`/api/transactions/${id}`)).json(); return t.excluded === 0 && t.splitParts === 0; }, setup.id);
        record("split rules", "Remove takes two presses, then the split is gone and its charge counts whole again", /Restore 1 and remove\?/.test(armed) && stillThere && gone && restored, `armed: "${armed}"; after one press still split=${stillThere}; section gone=${gone}; charge restored=${restored}`);
      }
    } finally {
      await page.evaluate(async (id) => { await fetch(`/api/transactions/${id}/split`, { method: "DELETE" }); }, setup.id);
    }
  });
}

// A review queue repeats one decision per row, so its accept can't be the
// page's primary: four merge cards put four filled buttons on one page. Accept
// is secondary, Dismiss is quiet text (the pair still ranks), and the page
// keeps at most one primary however many rows its queues hold.
async function queueButtons(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-queue-accept]");
    const r = await page.evaluate(() => {
      const bg = (el) => getComputedStyle(el).backgroundColor;
      const accent = (() => { const p = document.createElement("span"); p.style.background = "var(--accent)"; document.body.append(p); const c = getComputedStyle(p).backgroundColor; p.remove(); return c; })();
      const accepts = [...document.querySelectorAll("[data-queue-accept]")], dismisses = [...document.querySelectorAll("[data-queue-dismiss]")];
      return {
        accepts: accepts.length,
        labels: [...new Set(accepts.map((b) => b.textContent.trim()))].join("/"),
        filled: accepts.filter((b) => bg(b) === accent).length,
        bordered: accepts.filter((b) => parseFloat(getComputedStyle(b).borderTopWidth) >= 1).length,
        dismissQuiet: dismisses.length === accepts.length && dismisses.every((b) => parseFloat(getComputedStyle(b).borderTopWidth) === 0),
        primaries: document.querySelectorAll("main .btn-primary, header .btn-primary").length,
      };
    });
    record("queue buttons", "with several queue rows on the page, accept is secondary, Dismiss is quiet, and no row adds a primary", r.accepts >= 2 && r.filled === 0 && r.bordered === r.accepts && r.dismissQuiet && r.primaries <= 1, `${r.accepts} accept buttons (${r.labels}), ${r.filled} filled, ${r.bordered} bordered; dismiss quiet=${r.dismissQuiet}; ${r.primaries} primaries on the page`);
  });
}

// Model suggestions: the queue asks on its own when the page loads (a suggestion
// you must press a button to see is one you mostly don't see), and shows the
// answer by confidence — sure ones as suggestions, middling ones tagged
// "possible match" and left out of Apply all, the rest counted as "not sure"
// rather than guessed at. The model's likeliest categories lead the picker.
// Every request is answered here, in the browser; no API is called.
async function modelSuggestionTiers(browser) {
  await withPage(browser, async (page) => {
    const cats = await (await fetch(BASE + "/api/categories")).json();
    const pick = (i) => cats.filter((c) => c.kind === "expense")[i];
    const sug = (merchant, c, tier) => ({ merchant, categoryId: c.id, categoryName: c.name, categoryIcon: c.icon, count: 1, source: "ai", possible: tier === "possible" || undefined, guess: tier === "guess" || undefined, alternatives: [c.id, pick(3).id, pick(4).id] });
    const state = { mode: "waiting", asks: 0 };
    const reads = {
      waiting: { suggestions: [], needsModelCount: 3, dismissedCount: 0, modelEnabled: true },
      answered: { suggestions: [sug("Zylo Widget Works", pick(0), "sure"), sug("Quorra Bakehouse", pick(1), "possible"), sug("Cryptic Llc 0042", pick(2), "guess")], needsModelCount: 0, dismissedCount: 0, modelEnabled: true },
      one: { suggestions: [], needsModelCount: 1, dismissedCount: 0, modelEnabled: false },
      two: { suggestions: [], needsModelCount: 2, dismissedCount: 0, modelEnabled: false },
    };
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (!req.url().endsWith("/api/category-suggestions")) return req.continue();
      if (req.method() === "POST" && (req.postData() ?? "").includes("suggestAI")) { state.asks++; state.mode = "answered"; return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ asked: 3, answered: 3, provider: "typesafe" }) }); }
      if (req.method() === "GET") return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(reads[state.mode]) });
      req.continue();
    });
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    const shown = await page.waitForSelector("[data-possible]", { timeout: 8000 }).then(() => true).catch(() => false);
    record("model suggestions", "the queue asks the model on its own: suggestions appear with no press, and there is no Suggest button", shown && state.asks === 1 && !(await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /Suggest with AI/.test(b.textContent)))), `asks=${state.asks}, shown=${shown}`);
    if (!shown) return;
    const r = await page.evaluate((likely) => {
      const rows = [...document.querySelectorAll("[data-suggestion]")].map((li) => ({ name: li.querySelector(".truncate").textContent, tier: li.querySelector("[data-possible]")?.getAttribute("data-possible") ?? "sure", tag: li.querySelector("[data-possible]")?.textContent.trim() ?? "", category: li.querySelector("[data-category-property] .truncate")?.textContent.trim() ?? "" }));
      const row = [...document.querySelectorAll("[data-suggestion]")].find((li) => li.querySelector("[data-possible='possible']"));
      const groups = [...row.querySelectorAll("select optgroup")].map((g) => ({ label: g.label, first: [...g.children].slice(0, 3).map((o) => Number(o.value)) }));
      return { rows, applyAll: document.querySelector("[data-apply-all]")?.textContent.trim(), groups, likely };
    }, [pick(1).id, pick(3).id, pick(4).id]);
    const mine = r.rows.filter((x) => ["Zylo Widget Works", "Quorra Bakehouse", "Cryptic Llc 0042"].includes(x.name));
    record("model suggestions", "every answer is shown with its category, in order of trust: sure, possible match, a guess", JSON.stringify(mine.map((x) => [x.name, x.tier, x.tag])) === JSON.stringify([["Zylo Widget Works", "sure", ""], ["Quorra Bakehouse", "possible", "possible match"], ["Cryptic Llc 0042", "guess", "a guess"]]) && mine.every((x) => x.category.length > 0), JSON.stringify(mine));
    record("model suggestions", "Apply all takes only the sure ones, and says so", r.applyAll === "Apply the 1 sure", r.applyAll ?? "no button");
    record("model suggestions", "the picker leads with the model's likeliest categories", r.groups[0]?.label === "Most likely" && JSON.stringify(r.groups[0].first) === JSON.stringify(r.likely) && r.groups[1]?.label === "All categories", JSON.stringify(r.groups.map((g) => g.label)));
    await sleep(600);
    record("model suggestions", "having asked, it does not ask again", state.asks === 1, `asks=${state.asks}`);
    // The count line is a sentence, and agrees with its count ("1 vendor need" was the bug).
    const lines = [];
    for (const mode of ["one", "two"]) { state.mode = mode; await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" }); await page.waitForSelector("[data-needs-model]"); lines.push(await page.$eval("[data-needs-model]", (n) => n.textContent.trim())); }
    record("model suggestions", "the count line agrees with its count", /^1 vendor needs the model/.test(lines[0]) && /^2 vendors need the model/.test(lines[1]), lines.map((l) => l.slice(0, 28)).join(" | "));
  });
}

// The login screen asks the server for nothing. It used to request categories,
// vendors and a bank sync before anyone had signed in: three 401s, the error
// reply stored as if it were the category list, and the launch sync's 15-minute
// throttle spent on a request that could not succeed. The pages behind it still
// load their lists and still sync on launch.
async function quietLogin(browser) {
  await withPage(browser, async (page) => {
    const calls = [];
    page.on("request", (q) => { const u = new URL(q.url()); if (u.pathname.startsWith("/api/")) calls.push(`${q.method()} ${u.pathname}`); });
    // Earlier checks share this browser's storage and have already launched:
    // start each document here as a device that never has.
    await page.evaluateOnNewDocument(() => { try { localStorage.removeItem("copilot:lastAutoSync"); } catch {} });
    await page.goto(BASE + "/login", { waitUntil: "networkidle2" }); await sleep(800);
    const onLogin = [...calls];
    const stamped = await page.evaluate(() => localStorage.getItem("copilot:lastAutoSync"));
    record("quiet login", "the login screen makes no API request and does not spend the launch-sync throttle", onLogin.length === 0 && stamped === null, onLogin.length ? onLogin.join(", ") : `no requests; throttle ${stamped === null ? "unspent" : "SPENT"}`);
    calls.length = 0;
    await page.goto(BASE + "/", { waitUntil: "networkidle2" }); await sleep(800);
    record("quiet login", "the app behind it still loads its lists and syncs on launch", calls.includes("GET /api/categories") && calls.includes("GET /api/vendors") && calls.includes("POST /api/plaid/sync"), [...new Set(calls)].filter((c) => /categories|vendors|sync/.test(c)).join(", "));
  });
}

// A transaction row opens the charge. The vendor's shelf (its years, its plan,
// rename, Combine) is one step up, and the step has to be findable: the name in
// the header opens it, and the link under the list says what it opens whatever
// the vendor's charge count (it read "All 62 charges →" and opened the vendor).
async function openVendorFromCharge(browser) {
  await withPage(browser, async (page) => {
    // A monthly bill in the seed's first month (Dec 2025), so the vendor spans
    // two calendar years and has a by-year block to show.
    await page.goto(BASE + "/transactions?month=2025-12&vendor=Netflix", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    await page.click("[data-drawer-row]"); await shelfIs(page, true); await shelfSettled(page);
    await page.waitForSelector(`${shelfSel} [data-open-vendor]`);
    const c = await page.evaluate((sel) => { const a = document.querySelector(sel); const links = [...a.querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => /→$/.test(t) && /vendor|charges/i.test(t)); return { name: a.querySelector("[data-open-vendor]").textContent.trim(), links, title: a.querySelector("[data-charge-recent]").previousElementSibling.textContent.trim() }; }, shelfSel);
    record("open vendor", "the link under a charge's recent list says what it opens, whatever the count", c.links.length === 1 && c.links[0] === "Open vendor →", `${c.links.join(" | ") || "none"}; title "${c.title}"`);
    // The charge's shelf answers "what does this vendor cost a year" without the
    // step up, and with the vendor's own figures.
    const years = (sel) => page.evaluate((sel) => { const b = document.querySelector(`${sel} [data-by-year]`); return b ? { title: b.firstElementChild.textContent.trim(), rows: [...b.lastElementChild.children].map((r) => r.textContent.replace(/\s+/g, " ").trim()) } : null; }, sel);
    const onCharge = await years(shelfSel);
    await page.click(`${shelfSel} [data-open-vendor]`);
    let vendor = false; try { await page.waitForSelector(`${shelfSel} button::-p-text(Combine)`, { timeout: 8000 }); vendor = true; } catch {}
    const back = await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)].some((b) => /Back/.test(b.textContent)), shelfSel);
    const onVendor = vendor ? await years(shelfSel) : null;
    // From the vendor's shelf, "View all N transactions →" is a link to this same page with
    // ?vendor=. The page read its filters once, on load, so the URL changed and
    // nothing else did: the shelf stayed open over an unfiltered list.
    if (vendor) {
      await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const shown = await page.$eval("header", (h) => h.innerText.match(/(\d+) shown/)?.[1] ?? "");
      await page.evaluate(() => [...document.querySelectorAll("[data-drawer-row]")].find((r) => /Netflix/.test(r.textContent)).click());
      await shelfIs(page, true); await shelfSettled(page);
      await page.click(`${shelfSel} [data-open-vendor]`);
      await page.waitForSelector(`${shelfSel} button::-p-text(Combine)`, { timeout: 8000 });
      const label = await page.evaluate((sel) => { const a = [...document.querySelectorAll(`${sel} a`)].find((a) => /^View all \d+ transactions/.test(a.textContent)); a?.click(); return a?.textContent.trim() ?? null; }, shelfSel);
      // Key on the URL, not the count: the unfiltered list may already show N rows.
      await page.waitForFunction((n) => /vendor=Netflix/.test(location.search) && !document.querySelector("[data-shelf]") && new RegExp(`\\b${n} shown`).test(document.querySelector("header")?.innerText ?? ""), { timeout: 8000 }, label?.match(/\d+/)?.[0] ?? "-").catch(() => {});
      const after = await page.evaluate(() => ({ url: location.search, shelf: !!document.querySelector("[data-shelf]"), shown: document.querySelector("header")?.innerText.match(/(\d+) shown/)?.[1] ?? "" }));
      record("open vendor", "\"View all N transactions\" from a charge on the Transactions page shows that vendor's statement, shelf closed", !!label && after.url === "?vendor=Netflix" && !after.shelf && after.shown === label.match(/\d+/)?.[0] && after.shown !== shown, `clicked "${label}": ${after.url}, shelf=${after.shelf}, ${shown} shown → ${after.shown}`);
    }
    record("open vendor", "a charge's shelf shows its vendor's spend by year, the same figures as the vendor's shelf", !!onCharge && onCharge.rows.length >= 2 && /vendor/i.test(onCharge.title) && !!onVendor && onCharge.rows.join("|") === onVendor.rows.join("|"), onCharge ? `charge: ${onCharge.rows.join(", ")}; vendor: ${onVendor ? onVendor.rows.join(", ") : "none"}` : "no by-year block on the charge");
    record("open vendor", "the vendor's name in a charge's header opens the vendor's shelf, with Back", c.name.length > 0 && vendor && back, `"${c.name}" → vendor shelf=${vendor}, back=${back}`);
  });
}

// Chrome on iOS tags every form field with an attribute of its own
// (__gcruniqueid) for autofill, before React starts. React then finds an
// attribute the server never sent and reports a hydration error on every page
// that server-renders a field — a red "1 Issue" pill over the phone's nav in
// dev. No iOS here, so the fields are tagged the same way as they are parsed.
async function iosAutofillTag(browser) {
  await withPage(browser, async (page) => {
    const seen = [];
    page.on("console", (m) => { if (/hydrat/i.test(m.text())) seen.push(m.text().split("\n")[0].slice(0, 80)); });
    // Tag each field the moment the parser adds it, before React starts.
    await page.evaluateOnNewDocument(() => {
      let n = 0;
      const sel = "form, form button, input, select, textarea"; // forms and fields were seen tagged on the phone; a form's own button is the likely next
      new MutationObserver((recs) => { for (const r of recs) for (const el of r.addedNodes) if (el.nodeType === 1) for (const e of [el, ...el.querySelectorAll(sel)]) if (e.matches(sel) && !e.hasAttribute("__gcruniqueid")) e.setAttribute("__gcruniqueid", String(++n)); }).observe(document, { childList: true, subtree: true });
    });
    let tagged = 0;
    for (const path of ["/transactions", "/", "/login"]) { await page.goto(BASE + path, { waitUntil: "networkidle2" }); await sleep(600); tagged += await page.evaluate(() => document.querySelectorAll("[__gcruniqueid]").length); }
    record("ios autofill tag", "a browser's own attribute on a server-rendered field is not a hydration error", tagged >= 3 && seen.length === 0, `${tagged} fields tagged across 3 pages; ${seen.length ? seen[0] : "no hydration error"}`);
  });
}

// The app is Daybook. Its first name borrowed a competitor's, so the places a
// person sees the name (the tab, the sidebar, the sign-in page, the name a
// phone gives the home-screen icon) are held to the new one.
async function appName(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle2" });
    const seen = await page.evaluate(async () => { const m = await (await fetch("/manifest.webmanifest")).json(); return { title: document.title, wordmark: document.querySelector("aside")?.innerText.split("\n").map((t) => t.trim()).filter(Boolean).slice(0, 2).join(" ") ?? "", manifest: `${m.name} / ${m.short_name}` }; });
    await page.goto(BASE + "/login", { waitUntil: "networkidle2" });
    const login = await page.$eval("form[action='/api/login']", (f) => f.innerText.split("\n").map((t) => t.trim()).filter(Boolean).slice(0, 2).join(" "));
    const all = [seen.title, seen.wordmark, seen.manifest, login];
    record("app name", "the tab, the sidebar, the sign-in page and the home-screen name all say Daybook", all.every((t) => /Daybook/.test(t) && !/copilot/i.test(t)) && seen.wordmark.startsWith("D") && login.startsWith("D"), `title "${seen.title}"; sidebar "${seen.wordmark}"; manifest "${seen.manifest}"; sign-in "${login}"`);
  });
}

// A charge the detector left out of any plan can start one: "Start a plan →"
// on the charge's shelf makes a plan from its amount, and the shelf then shows
// the charge in it. (Zylo Widget Works: one charge, no plan.)
async function startAPlan(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/transactions?vendor=Zylo%20Widget%20Works", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    await page.$eval("[data-drawer-row]", (r) => r.click()); await shelfIs(page, true); await shelfSettled(page);
    const before = await page.evaluate((sel) => document.querySelector(sel).innerText.replace(/\s+/g, " "), shelfSel);
    await page.click(`${shelfSel} [data-start-plan]`);
    await page.waitForFunction((sel) => /In plan/.test(document.querySelector(sel)?.innerText ?? ""), { timeout: 8000 }, shelfSel).catch(() => {});
    await shelfSettled(page);
    const after = await page.evaluate((sel) => document.querySelector(sel).innerText.replace(/\s+/g, " "), shelfSel);
    record("start a plan", "a charge outside any plan can start one, and then reads as in it", /Not recurring/.test(before) && /In plan/.test(after) && /Zylo Widget Works · \$31/.test(after), `before: ${/Not recurring/.test(before)}; after: ${after.match(/In plan.{0,40}/)?.[0]}`);
  });
}

// A vendor with several plans is not a plan: its shelf lists them with what
// they add up to, and each opens its own shelf. It used to borrow the most
// recently charged plan's cards, so Apple's six subscriptions read "$128 per
// year" on a vendor that costs $790.
async function multiPlanVendor(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const n = await page.evaluate(() => [...document.querySelectorAll("[data-drawer-row]")].filter((r) => /Streamly/.test(r.textContent)).length);
    await page.evaluate(() => [...document.querySelectorAll("[data-drawer-row]")].find((r) => /Streamly/.test(r.textContent)).click());
    await shelfIs(page, true); await shelfSettled(page);
    // The Recurrings row opens the PLAN; "Open vendor"-style drill is the vendor.
    const planShelf = await page.$eval(shelfSel, (a) => a.innerText.replace(/\s+/g, " "));
    await page.goto(BASE + "/transactions?vendor=Streamly", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    await page.$eval("[data-drawer-row]", (r) => r.click()); await shelfIs(page, true); await shelfSettled(page);
    await page.click(`${shelfSel} [data-open-vendor]`); await page.waitForSelector(`${shelfSel} [data-plan-list]`, { timeout: 8000 }).catch(() => {});
    const v = await page.evaluate((sel) => { const a = document.querySelector(sel); const list = a.querySelector("[data-plan-list]"); return { plans: list ? list.querySelectorAll("li").length : 0, head: a.querySelector("[data-plan-list]")?.previousElementSibling?.innerText.replace(/\s+/g, " ") ?? "", perYear: /per year expected/.test(a.innerText) }; }, shelfSel);
    record("vendor shelf", "a two-plan vendor's shelf lists both plans with their monthly total, not one plan's cards", n === 2 && v.plans === 2 && /2 plans\s*\$25 per month/i.test(v.head) && !v.perYear, `${n} rows on Recurrings; shelf: "${v.head}", ${v.plans} listed, per-year card=${v.perYear}`);
    await page.evaluate(() => document.querySelector("[data-plan-list] [role=button]").click()); await shelfSettled(page);
    const opened = await page.$eval(`${shelfSel} header`, (h) => h.innerText.replace(/\s+/g, " "));
    record("vendor shelf", "tapping a listed plan opens that plan's shelf, with Back", /Back/.test(opened) && /One of 2 plans/.test(opened) && /per year expected|Per charge/i.test(planShelf), opened.slice(0, 80));
  });
}

// One summary-card height on every page at desktop width: the cards differ
// in content (a note line, sub-lines), and three heights read as three designs.
async function cardHeights(browser) {
  await withPage(browser, async (page) => {
    await page.setViewport({ width: 1280, height: 900 });
    const heights = [];
    for (const path of ["/", "/categories", "/recurrings"]) {
      await page.goto(BASE + path, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-summary]");
      heights.push(Math.round(await page.$eval("[data-summary]", (e) => e.getBoundingClientRect().height)));
    }
    record("card heights", "the dashboard, Categories and Recurrings summary cards are one height at desktop width", new Set(heights).size === 1, heights.join(" / ") + "px");
  });
}

// A phone is a narrow column, not a small desktop: what shares a row there is
// chosen, not whatever wrapping leaves behind.
async function phoneLayout(browser) {
  await withPage(browser, async (page) => {
    await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(BASE + "/", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-figure-pair]");
    const d = await page.evaluate(() => { const card = document.querySelector("[data-summary]"); const pair = card.querySelector("[data-figure-pair]"); const [a, b] = [...pair.children].map((e) => e.getBoundingClientRect()); const primary = pair.parentElement.firstElementChild.getBoundingClientRect(); const cr = card.getBoundingClientRect(); return { tops: Math.abs(Math.round(a.top - b.top)), left: Math.abs(Math.round(a.left - primary.left)), inside: b.right <= cr.right + 0.5, scroll: document.documentElement.scrollWidth - innerWidth }; });
    record("phone layout", "the dashboard's income and expenses share one line on the net figure's left edge (they stair-stepped, right-aligned)", d.tops <= 1 && d.left <= 1 && d.inside && d.scroll <= 0, `tops Δ${d.tops}px, left Δ${d.left}px, inside=${d.inside}, page overflow ${d.scroll}px`);
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const t = await page.evaluate(() => { const head = document.querySelector("header"); const h1 = head.querySelector("h1").getBoundingClientRect(); const pick = head.querySelector("select").getBoundingClientRect(); const sub = head.querySelector("p")?.getBoundingClientRect(); const row = document.querySelector("[data-drawer-row]"); const name = row.querySelector("span.truncate").getBoundingClientRect(); const cat = [...row.querySelectorAll('[class*="group/cat"]')].find((e) => e.offsetParent !== null); const icon = cat?.firstElementChild?.getBoundingClientRect(); return { sameRow: Math.abs((h1.top + h1.bottom) / 2 - (pick.top + pick.bottom) / 2) <= 12, pickRight: pick.left > h1.right, subBelow: sub ? sub.top >= Math.max(h1.bottom, pick.bottom) - 1 : null, catDelta: icon ? Math.abs(Math.round(icon.left - name.left)) : null }; });
    record("phone layout", "the month picker stays on the title's row, right of it, with the subtitle beneath both", t.sameRow && t.pickRight && t.subBelow !== false, `same row=${t.sameRow}, right of title=${t.pickRight}, subtitle below=${t.subBelow}`);
    // The row's glyph is the category's icon, so the category line beside it
    // is the name alone; on desktop, a column away, it keeps the icon.
    const labels = await page.evaluate(() => { const row = [...document.querySelectorAll("[data-drawer-row]")].find((r) => [...r.querySelectorAll("[data-category-property]")].length === 2 && !/Uncategorized/.test(r.innerText)); if (!row) return null; const [a, b] = [...row.querySelectorAll("[data-category-property]")]; const shown = a.offsetParent !== null ? a : b, hidden = shown === a ? b : a; const text = (e) => e.firstElementChild.textContent.trim(); return { phone: text(shown), desktop: text(hidden) }; });
    record("phone layout", "a charge's category line drops the icon its glyph already shows (the desktop column keeps it)", !!labels && /^[\p{L}]/u.test(labels.phone) && labels.desktop.endsWith(labels.phone) && labels.desktop !== labels.phone, labels ? `phone "${labels.phone}", desktop "${labels.desktop}"` : "no categorized row");
    record("phone layout", "a charge's category starts on the vendor name's left edge", t.catDelta !== null && t.catDelta <= 1, t.catDelta === null ? "no category in the row" : `Δ ${t.catDelta}px`);
    // Categories on a phone: the header's controls are one height, the two
    // summary figures share a line (a long label wraps under its own figure),
    // and the sort sits on the section title's line, not in a row of its own.
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-summary]");
    const c = await page.evaluate(() => { const hs = [...document.querySelectorAll("header select, header button")].map((e) => e.getBoundingClientRect().height).filter((h) => h > 0); const figs = document.querySelector("[data-summary]").querySelectorAll(".text-2xl"); const [a, b] = [figs[0].getBoundingClientRect(), figs[1].getBoundingClientRect()]; const sort = document.querySelector('select[aria-label="Sort categories"]').getBoundingClientRect(); const title = [...document.querySelectorAll("h3")].find((h) => /expenses/i.test(h.textContent)).getBoundingClientRect(); const mid = (r) => (r.top + r.bottom) / 2; return { heights: [...new Set(hs.map((h) => Math.round(h * 2) / 2))], figTops: Math.abs(Math.round(a.top - b.top)), sortLine: Math.abs(Math.round(mid(sort) - mid(title))), overflow: document.documentElement.scrollWidth - innerWidth }; });
    record("phone layout", "the Categories header's controls are one height (the primary button was 2px shorter than the picker)", c.heights.length === 1, `heights ${c.heights.join(", ")}px`);
    record("phone layout", "Categories: spent and left share a line, and the sort sits on the section title's line", c.figTops <= 1 && c.sortLine <= 2 && c.overflow <= 0, `figure tops Δ${c.figTops}px, sort vs title Δ${c.sortLine}px, page overflow ${c.overflow}px`);
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const mh = await page.evaluate(() => [...new Set([...document.querySelectorAll("header select, header button")].map((e) => e.getBoundingClientRect().height).filter((h) => h > 0).map((h) => Math.round(h * 2) / 2))]);
    record("phone layout", "the ⋯ menu button is as tall as the month picker beside it", mh.length === 1, `heights ${mh.join(", ")}px`);
    // A paid bill that differed shows the difference under its amount on a
    // phone — without making that row taller than its neighbours.
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const rh = await page.evaluate(() => { const rows = [...document.querySelectorAll("[data-drawer-row]")].filter((r) => !r.querySelector("[data-cadence]")); const has = (r) => r.querySelector("[data-amount-state]").children.length > 1; const h = (r) => Math.round(r.getBoundingClientRect().height * 2) / 2; const d = rows.find(has), p = rows.find((r) => !has(r)); return { delta: d ? h(d) : null, plain: p ? h(p) : null, comcast: rows.filter((r) => /Comcast B/.test(r.innerText)).map((r) => r.innerText.replace(/\s+/g, " ")).join(" | ") }; });
    record("phone layout", "a recurrings row with a difference under its amount is as tall as a plain row", rh.delta !== null && rh.plain !== null && rh.delta === rh.plain && rh.plain >= 43, `(and a full 44px touch target) with difference ${rh.delta}px, plain ${rh.plain}px${rh.delta === null ? `; fixture row: ${rh.comcast || "absent"}` : ""}`);
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    // Moving between shelf types empties the sheet until the read answers. It
    // must hold its height meanwhile: it used to drop ~310px to its placeholder
    // and rise again, flashing the page (and its title) behind it. The vendor's
    // answer is held 500ms here so the gap is long enough to see.
    {
      await page.$eval("[data-drawer-row]", (r) => r.click()); await shelfIs(page, true); await shelfSettled(page);
      await page.waitForSelector(`${shelfSel} [data-open-vendor]`);
      await page.setRequestInterception(true);
      const slow = (req) => { if (/\/api\/(merchant|transactions\/\d+)(\?|$)/.test(req.url()) && req.method() === "GET") setTimeout(() => req.continue(), 500); else req.continue(); };
      page.on("request", slow);
      const rest1 = await page.$eval(shelfSel, (e) => Math.round(e.getBoundingClientRect().top));
      await page.evaluate((sel) => { window.__tops = []; window.__sampling = true; const tick = () => { const a = document.querySelector(sel); if (a) window.__tops.push(Math.round(a.getBoundingClientRect().top)); if (window.__sampling) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }, shelfSel);
      await page.$eval(`${shelfSel} [data-open-vendor]`, (e) => e.click());
      await page.waitForSelector(`${shelfSel} button::-p-text(Combine)`, { timeout: 8000 });
      const rest2 = await page.$eval(shelfSel, (e) => Math.round(e.getBoundingClientRect().top));
      await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)].find((x) => /Back/.test(x.textContent))?.click(), shelfSel);
      await page.waitForSelector(`${shelfSel} [data-open-vendor]`, { timeout: 8000 }); await sleep(300);
      const tops = await page.evaluate(() => { window.__sampling = false; return window.__tops; });
      page.off("request", slow); await page.setRequestInterception(false);
      const lowest = Math.max(...tops), resting = Math.max(rest1, rest2);
      record("phone layout", "the sheet holds its height while it moves between a charge and its vendor (it dropped to its placeholder and rose again)", tops.length > 20 && lowest <= resting + 2, `resting tops ${rest1}px and ${rest2}px; lowest top seen ${lowest}px over ${tops.length} frames`);
      await page.keyboard.press("Escape"); await shelfIs(page, false);
    }
    // The sheet's handle says "pull me down". A short, slow pull springs back;
    // a long one closes the sheet.
    const swipe = async (dist) => { const b = await page.$eval("[data-sheet-drag]", (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 6 }; }); await page.touchscreen.touchStart(b.x, b.y); for (let i = 1; i <= 8; i++) { await page.touchscreen.touchMove(b.x, b.y + (dist * i) / 8); await sleep(40); } await page.touchscreen.touchEnd(); await sleep(400); };
    await page.$eval("[data-drawer-row]", (r) => r.click()); await shelfIs(page, true); await shelfSettled(page);
    await swipe(40);
    const stayed = await page.$eval(shelfSel, (e) => Math.round(new DOMMatrix(getComputedStyle(e).transform).m42)).catch(() => null);
    await swipe(220);
    const gone = (await page.$(shelfSel)) === null;
    record("phone layout", "pulling the sheet's handle down closes it; a short pull springs back", stayed === 0 && gone, `after 40px: ${stayed === null ? "closed" : `open, offset ${stayed}px`}; after 220px: ${gone ? "closed" : "still open"}`);
  });
}

async function statementMode(browser) {
  for (const [mode, url] of [["statement", "/transactions?vendor=Chipotle"], ["normal", "/transactions"]]) {
    await withPage(browser, async (page, errs) => {
      await page.goto(BASE + url, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const header = await page.evaluate(() => /\d+ transactions? ·/.test(document.body.innerText));
      await page.click("[data-drawer-row]"); await shelfIs(page, true); await shelfSettled(page);
      let editor = false; try { await page.waitForSelector(`${shelfSel} input[placeholder='What was this for?']`, { timeout: 3000 }); editor = true; } catch {}
      await page.keyboard.press("Escape"); await shelfIs(page, false);
      // The day header's total sits on the amounts column: same right edge as
      // the rows' amount cells (it once reserved a column for a row menu).
      const dayTotal = await page.evaluate(() => { const t = document.querySelector("[data-day-total]"); const a = t && t.closest("ul")?.querySelector("[data-drawer-row] [data-amount-state]"); if (!t || !a) return null; return Math.abs(Math.round(t.getBoundingClientRect().right - a.getBoundingClientRect().right)); });
      if (mode === "normal") record("statement mode", "day header total sits on the amounts column", dayTotal !== null && dayTotal <= 1, dayTotal === null ? "no day header" : `Δ ${dayTotal}px`);
      // A day header is a band in the page grey, sticky while its rows scroll.
      const band = await page.evaluate(() => { const h = document.querySelector("[data-day-header]"); if (!h) return null; const cs = getComputedStyle(h); const bg = getComputedStyle(document.documentElement).getPropertyValue("--background").trim().toLowerCase(); const hex = (rgb) => { const m = rgb.match(/\d+/g); return m ? "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("") : rgb; }; return { washed: hex(cs.backgroundColor) === bg, sticky: cs.position === "sticky", label: h.querySelector(".stat-label") !== null }; });
      if (mode === "normal") record("statement mode", "day header is a page-grey band, sticky, in the label style", !!band && band.washed && band.sticky && band.label, band ? `washed=${band.washed}, sticky=${band.sticky}, label=${band.label}` : "no day header");
      // The row size is the row's, not the page's: the amount is the same size
      // as the name (it inherited 16px from the body before).
      if (mode === "normal") {
        const fs = await page.evaluate(() => { const li = document.querySelector("[data-drawer-row]"); const a = li.querySelector("[data-amount-state]"); const leaf = [...a.querySelectorAll("span")].pop() ?? a; const n = li.querySelector("span.truncate"); return { amount: getComputedStyle(leaf).fontSize, name: n ? getComputedStyle(n).fontSize : null }; });
        record("statement mode", "a row's amount is the row size, same as its name", fs.amount === fs.name && fs.amount === "13px", `amount ${fs.amount}, name ${fs.name}`);
      }
      // Under an Uncategorized filter, categorizing a row makes it leave the
      // list (the page re-reads and reconciles), and the count follows.
      if (mode === "normal") {
        const link = await page.$("[data-show-uncategorized]");
        if (link) { await link.click(); await page.waitForNetworkIdle({ idleTime: 400, timeout: 8000 }).catch(() => {}); }
        const applied = !!link;
        const before = await page.$$eval("[data-drawer-row]", (r) => r.length);
        if (applied && before > 0) {
          // The row's option list mounts when the control is taken up (mousedown
          // or focus — long lists stay light at rest); a headless page may not
          // deliver focus, so press it.
          await page.evaluate(() => document.querySelector("[data-drawer-row] [data-category-property] select").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
          await page.waitForFunction(() => document.querySelector("[data-drawer-row] [data-category-property] select").options.length > 2, { timeout: 5000 });
          const who = await page.evaluate(() => { const s = document.querySelector("[data-drawer-row] [data-category-property] select"); const opt = [...s.options].find((o) => o.value && o.value !== "none"); s.value = opt.value; s.dispatchEvent(new Event("change", { bubbles: true })); return s.closest("[data-drawer-row]").innerText.split("\n").find((t) => /[a-z]/i.test(t) && !/^\w{3} \d/.test(t)) ?? ""; });
          await page.waitForFunction((n) => document.querySelectorAll("[data-drawer-row]").length < n, { timeout: 10000 }, before).then(() => record("statement mode", "categorizing under the Uncategorized filter makes the row leave", true, `${before} → ${before - 1} rows (${who})`)).catch(() => record("statement mode", "categorizing under the Uncategorized filter makes the row leave", false, `still ${before} rows`));
        } else record("statement mode", "categorizing under the Uncategorized filter makes the row leave", false, applied ? "no uncategorized rows in the fixture" : "no queue link");
        await page.goto(BASE + url, { waitUntil: "networkidle2" });
      }
      // A proposal's category can be changed in place before it is applied.
      if (mode === "normal") {
        const prop = await page.$("[data-suggestion] [data-category-property] select");
        if (prop) {
          const r = await page.evaluate(() => { const li = document.querySelector("[data-suggestion]"); const s = li.querySelector("[data-category-property] select"); const before = s.value; const other = [...s.options].find((o) => o.value && o.value !== before); s.value = other.value; s.dispatchEvent(new Event("change", { bubbles: true })); return { before, chosen: other.value }; });
          await sleep(300);
          const after = await page.evaluate(() => { const li = document.querySelector("[data-suggestion]"); return { value: li.querySelector("[data-category-property] select").value, edited: /edited/.test(li.textContent) }; });
          record("statement mode", "a suggested category can be redirected before Apply, and says so", after.value === r.chosen && after.edited, `${r.before} → ${after.value}, edited=${after.edited}`);
        } else record("statement mode", "a suggested category can be redirected before Apply, and says so", true, "no suggestions in the fixture");
      }
      // The queue's "Show the uncategorized" filters the list to category = none.
      if (mode === "normal") {
        const link = await page.$("[data-show-uncategorized]");
        if (link) {
          await link.click(); await sleep(600);
          const v = await page.evaluate(() => { const s = [...document.querySelectorAll("select")].find((x) => [...x.options].some((o) => o.value === "none")); const m = [...document.querySelectorAll("header select")].find((x) => [...x.options].some((o) => /^\d{4}-\d{2}$/.test(o.value))); return { cat: s ? s.value : null, month: m ? m.value : null }; });
          record("statement mode", "queue's 'Show all uncategorized' filters the list across all months", v.cat === "none" && v.month === "", `category=${v.cat}, month=${JSON.stringify(v.month)}`);
        } else record("statement mode", "queue's 'Show the uncategorized' filters the list", true, "no queue in the fixture");
      }
      await page.setViewport({ width: 400, height: 800 }); await sleep(400);
      const chip = await page.evaluate(() => { const s = document.querySelector("[data-drawer-row] select"); return !!s && s.offsetParent !== null; });
      record("statement mode", mode, editor && chip && (mode !== "statement" || header) && errs.length === 0, `note editor: ${editor}, mobile chip: ${chip}`);
    });
  }
}

async function splitUndo(browser) {
  await withPage(browser, async (page, errs) => {
    const api = await (await fetch(BASE + "/api/transactions?limit=60")).json();
    const cand = (api.rows ?? api).find((r) => r.amount < 0 && !r.excluded && !r.pending && !r.splitParts && !r.merchant.includes(" — "));
    const amtText = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(cand.amount));
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const found = await page.evaluate((name, amt) => {
      for (const li of document.querySelectorAll("[data-drawer-row]"))
        if (li.innerText.includes(name) && li.innerText.includes(amt)) { li.setAttribute("data-ui-target", "1"); return true; }
      return false;
    }, cand.displayName, amtText);
    if (!found) { record("split → undo", "target row", false, `no row for ${cand.displayName} ${amtText}`); return; }
    const row = "[data-drawer-row][data-ui-target]";
    // Re-clicking the row whose shelf is open toggles it shut, so close first.
    const openShelf = async () => {
      if (await page.$(shelfSel)) { await page.keyboard.press("Escape"); try { await shelfIs(page, false); } catch {} }
      await page.evaluate((sel) => { const el = document.querySelector(sel); el.scrollIntoView({ block: "center" }); el.click(); }, row);
      await shelfIs(page, true); await shelfSettled(page);
    };
    await openShelf();
    await page.click(`${shelfSel} button::-p-text(Split…)`);
    await page.waitForFunction(() => document.body.innerText.includes("Split transaction"));
    const labels = await page.$$eval("input[aria-label='Part label']", (els) => els.length);
    const total = Math.abs(cand.amount);
    const a1 = Math.round((total - 1) * 100) / 100, a2 = Math.round((total - a1) * 100) / 100;
    await page.evaluate((a1, a2) => {
      const dlg = [...document.querySelectorAll("div")].find((d) => d.innerText.startsWith("Split transaction"));
      const sels = dlg.querySelectorAll("select"); const amts = [...dlg.querySelectorAll("input[inputmode='decimal']")]; const lbls = [...dlg.querySelectorAll("input[aria-label='Part label']")];
      const setV = (el, v) => { const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); };
      setV(sels[0], sels[0].options[1].value); setV(sels[1], sels[1].options[2].value);
      setV(amts[0], String(a1)); setV(amts[1], String(a2)); setV(lbls[1], "UI test part");
    }, a1, a2);
    await sleep(300);
    const balanced = (await lowerText(page)).includes("balanced");
    await page.evaluate(() => { const dlg = [...document.querySelectorAll("div")].find((d) => d.innerText.startsWith("Split transaction")); const b = dlg.querySelectorAll("button"); b[b.length - 1].click(); });
    await page.waitForFunction(() => document.body.innerText.includes("split · 2 parts"), { timeout: 10000 });
    await sleep(500);
    const child = await page.evaluate(() => [...document.querySelectorAll("[data-drawer-row]")].some((li) => li.innerText.includes("— UI test part")));
    await page.evaluate(() => { for (const li of document.querySelectorAll("[data-drawer-row]")) if (li.innerText.includes("split · 2 parts")) { li.setAttribute("data-ui-target", "1"); break; } });
    await openShelf();
    const verbs = await page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll("button")].map((b) => b.textContent.trim()), shelfSel);
    const hasUndo = verbs.some((v) => v.includes("Undo split (2 parts)")), hidesToggle = !verbs.some((v) => /totals/.test(v));
    await page.click(`${shelfSel} button::-p-text(Undo split)`);
    await page.waitForFunction(() => ![...document.querySelectorAll("[data-drawer-row]")].some((li) => /split · 2 parts|— UI test part/.test(li.innerText)), { timeout: 10000 });
    record("split → undo", "dialog has a label per part", labels === 2, `${labels}`);
    record("split → undo", "parts balanced", balanced);
    record("split → undo", "pill + labelled child after save", child);
    record("split → undo", "shelf: Undo split, no totals toggle on a split parent", hasUndo && hidesToggle);
    record("split → undo", "pill + children gone after undo", true);
    if (errs.length) record("split → undo", "page errors", false, errs[0]);
  });
}

async function shelfSettings(browser) {
  await withPage(browser, async (page, errs) => {
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    // the inline editor is gone; the row itself opens the shelf
    await page.waitForSelector("[data-drawer-row]");
    await page.click("[data-drawer-row]"); await shelfIs(page, true); await shelfSettled(page);
    const shelf = () => page.evaluate((sel) => document.querySelector(sel).innerText.toLowerCase(), shelfSel);
    let t = await shelf();
    record("shelf settings", "row opens the shelf with Next due + Match", t.includes("next due") && t.includes("match"));
    record("shelf settings", "no Reset all before any override", !t.includes("reset all overrides"));
    const posts = [];
    page.on("response", async (r) => { if (r.url().includes("/api/recurrings/settings")) posts.push({ status: r.status(), body: await r.text().catch(() => "?") }); });
    await page.select(`${shelfSel} select[aria-label='Match rule']`, "contains");
    // a contains rule is complete only with text — type it and commit with Enter
    const txt = await page.waitForSelector(`${shelfSel} input[aria-label='Match text']`, { timeout: 8000 });
    await txt.type("netflix"); await page.keyboard.press("Enter");
    try {
      await page.waitForFunction((sel) => document.querySelector(sel).innerText.toLowerCase().includes("reset all overrides"), { timeout: 8000 }, shelfSel);
    } catch {
      const diag = await page.evaluate((sel) => { const a = document.querySelector(sel); const s = a.querySelector("select[aria-label='Match rule']"); return { selectValue: s && s.value, shelfTail: a.innerText.slice(-400).replace(/\n/g, " | ") }; }, shelfSel);
      record("shelf settings", "DIAG", false, JSON.stringify({ posts, ...diag }).slice(0, 700));
      throw new Error("no Reset all after selecting a match rule");
    }
    t = await shelf();
    const editedTags = await page.$$eval(`${shelfSel} span`, (els) => els.filter((e) => e.textContent === "edited").length);
    record("shelf settings", "setting a match rule → edited tag + Reset all", editedTags >= 1 && t.includes("reset all overrides"), `edited tags: ${editedTags}`);
    await page.click(`${shelfSel} button::-p-text(Reset all overrides)`);
    await page.waitForFunction((sel) => !document.querySelector(sel).innerText.toLowerCase().includes("reset all overrides"), { timeout: 8000 }, shelfSel);
    record("shelf settings", "Reset all → back to auto", true);
    const inline = await page.evaluate(() => document.body.innerText.includes("expected (go-forward; history unchanged)"));
    record("shelf settings", "no inline editor on the page", !inline);
    if (errs.length) record("shelf settings", "page errors", false, errs[0]);
  });
}

// A budget row carries one colour signal: red, on its bar and its verdict,
// when it is over. The bar was the category's colour on one row and amber or
// red on the next, and a flat "90% spent" amber fired late in every month,
// when 90% is on pace. The category's colour is on its badge.
async function budgetBarColour(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    const month = day(0, 1).slice(0, 7);
    const set = await page.evaluate(async (month) => {
      const cats = await (await fetch(`/api/categories?month=${month}`)).json();
      const spent = cats.filter((c) => c.kind === "expense" && c.budget == null && !c.excludeFromTotals && c.total > 0).sort((a, b) => b.total - a.total);
      if (spent.length < 2) return { error: `need two unbudgeted expense categories with spend this month, have ${spent.length}` };
      const [over, near] = spent;
      const patch = (id, budget) => fetch(`/api/categories/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ budget, period: "monthly" }) });
      await patch(over.id, Math.max(1, Math.floor(over.total / 2))); // over
      await patch(near.id, Math.ceil(near.total / 0.95)); // 95% spent: the old amber
      return { over: over.name, near: near.name, ids: [over.id, near.id] };
    }, month);
    if (set.error) { record("budget colour", "fixture", false, set.error); return; }
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-budget-fill]");
    const rows = await page.evaluate(() => {
      const probe = (v) => { const e = document.createElement("span"); e.style.color = `var(${v})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
      const bad = probe("--bad"), fg = probe("--foreground");
      const probeBg = (v) => { const e = document.createElement("span"); e.style.background = v; document.body.append(e); const c = getComputedStyle(e).backgroundColor; e.remove(); return c; };
      const [mutedBg, badBg] = [probeBg("var(--muted)"), probeBg("var(--bad)")];
      return [...document.querySelectorAll("[data-drawer-row]")].filter((r) => r.querySelector("[data-budget-fill]")).map((r) => {
        const fill = getComputedStyle(r.querySelector("[data-budget-fill]")).backgroundColor;
        const spentEl = [...r.querySelectorAll("span.tabular-nums")].find((e) => /^\$[\d,]+$/.test(e.textContent.trim()));
        return {
          text: r.innerText,
          fill: fill === mutedBg ? "muted" : fill === badBg ? "bad" : fill,
          spent: spentEl ? (getComputedStyle(spentEl).color === fg ? "foreground" : getComputedStyle(spentEl).color === bad ? "bad" : getComputedStyle(spentEl).color) : "none",
        };
      });
    });
    await page.evaluate(async (ids) => {
      for (const id of ids) await fetch(`/api/categories/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ budget: null }) });
    }, set.ids);
    const find = (n) => rows.find((r) => r.text.includes(n));
    const over = find(set.over), near = find(set.near);
    const wrong = rows.filter((r) => r.fill !== (/ over\b/.test(r.text) ? "bad" : "muted"));
    record("budget colour", "every budget bar is neutral, and red exactly when its row says over",
      rows.length >= 2 && wrong.length === 0,
      `${rows.length} bars: ${rows.map((r) => `${r.text.split("\n")[0]}=${r.fill}`).join(", ")}`);
    record("budget colour", "a category at 95% of its budget is not flagged: neutral bar, spent figure in the text colour",
      !!near && near.fill === "muted" && near.spent === "foreground",
      near ? `${set.near}: bar ${near.fill}, spent ${near.spent}` : `${set.near} not listed`);
    record("budget colour", "an over-budget category is red on its bar and its verdict, not on its spent figure",
      !!over && over.fill === "bad" && / over\b/.test(over.text) && over.spent === "foreground",
      over ? `${set.over}: bar ${over.fill}, spent ${over.spent}` : `${set.over} not listed`);
  });
}

// The dashboard's category bars share one scale, so length compares
// categories. They were filled with each category's colour, seven hues for
// seven rows, and the budget wasn't drawn, so a category at 93% of its budget
// looked a third used. Spend is neutral, the budget left is a lighter track,
// and only the dollars over are red.
async function dashboardBars(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle2" });
    const month = day(0, 1).slice(0, 7);
    const set = await page.evaluate(async (month) => {
      const cats = await (await fetch(`/api/categories?month=${month}`)).json();
      const spent = cats.filter((c) => c.kind === "expense" && c.budget == null && !c.excludeFromTotals && c.total > 0).sort((a, b) => b.total - a.total);
      if (spent.length < 2) return { error: `need two unbudgeted expense categories with spend this month, have ${spent.length}` };
      const [over, under] = spent;
      const patch = (id, budget) => fetch(`/api/categories/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ budget, period: "monthly" }) });
      await patch(over.id, Math.max(1, Math.floor(over.total / 2)));
      await patch(under.id, Math.ceil(under.total * 2));
      return { over: over.name, under: under.name, ids: [over.id, under.id], colours: cats.map((c) => c.color) };
    }, month);
    if (set.error) { record("dashboard bars", "fixture", false, set.error); return; }
    await page.goto(BASE + "/", { waitUntil: "networkidle2" });
    await page.waitForFunction(() => [...document.querySelectorAll("h3")].some((h) => /Spending by category/.test(h.textContent)));
    // Found by the card's structure and read by colour, so the check means
    // the same on any version of the bar.
    const rows = await page.evaluate((colours) => {
      const probe = (v) => { const e = document.createElement("span"); e.style.background = v; document.body.append(e); const c = getComputedStyle(e).backgroundColor; e.remove(); return c; };
      const catBg = new Set(colours.map(probe));
      const bad = probe("var(--bad)");
      const card = [...document.querySelectorAll(".card")].find((c) => [...c.querySelectorAll("h3")].some((h) => /Spending by category/.test(h.textContent)));
      return [...card.querySelectorAll("[data-drawer-row]")].map((row) => {
        const bar = row.querySelector(".h-2.overflow-hidden.rounded-full");
        const segs = [...bar.children].map((c) => ({ bg: getComputedStyle(c).backgroundColor, w: c.getBoundingClientRect().width }));
        const fill = segs[0]?.bg;
        return {
          text: row.innerText,
          catColour: segs.some((g) => catBg.has(g.bg) && g.bg !== bad),
          over: segs.some((g) => g.bg === bad && g.w > 0),
          left: segs.slice(1).filter((g) => g.bg !== bad && g.bg !== fill).reduce((a, g) => a + g.w, 0),
          badFigure: !!row.querySelector(".text-\\[var\\(--bad\\)\\]"),
        };
      });
    }, set.colours);
    await page.evaluate(async (ids) => {
      for (const id of ids) await fetch(`/api/categories/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ budget: null }) });
    }, set.ids);
    const find = (n) => rows.find((r) => r.text.includes(n));
    const over = find(set.over), under = find(set.under);
    record("dashboard bars", "no category bar is filled with a category's colour", rows.length >= 2 && rows.every((r) => !r.catColour), `${rows.length} bars; coloured: ${rows.filter((r) => r.catColour).map((r) => r.text).join(", ") || "none"}`);
    record("dashboard bars", "red only for the dollars over, on the row whose figure says over", !!over && over.over && rows.every((r) => r.over === r.badFigure), over ? `${set.over}: over segment=${over.over}; ${rows.filter((r) => r.over).length} rows with red` : `${set.over} not shown`);
    record("dashboard bars", "an under-budget category shows the budget it has left", !!under && !under.over && under.left > 0, under ? `${set.under}: left ${Math.round(under.left)}px` : `${set.under} not shown`);
  });
}

// Durable plans: naming a plan confirms it, so it keeps its charges when
// the bill moves. Streamly's $15.49 plan bills the 19th; named, a charge that
// posts on the 23rd is still that plan's after a re-scan, under its name.
// Unnamed, the detector's day parts leave a lone 23rd out.
async function namedPlanStays(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    const key = "Streamly · 19th";
    const r = await page.evaluate(async (key, date) => {
      const read = async () => (await (await fetch(`/api/merchant?name=Streamly&series=${encodeURIComponent(key)}`)).json());
      const before = await read();
      await fetch("/api/recurrings/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ merchant: key, alias: "Streamly Premium" }) });
      await fetch("/api/import", { method: "POST", body: `Date,Name,Amount,Account\n${date},Streamly,-15.49,Credit` });
      await fetch("/api/recompute", { method: "POST" });
      const after = await read();
      await fetch("/api/recurrings/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ merchant: key, clear: true }) });
      return { series: after.series, name: after.displayName, before: before.count, after: after.count };
    }, key, day(-1, 23));
    record("named plan", "a named plan keeps its name and takes a charge that posts days late, after a re-scan",
      r.series === key && r.name === "Streamly Premium" && r.after === r.before + 1,
      `${r.series}: "${r.name}", ${r.before} → ${r.after} charges`);
  });
}

async function moneyColour(browser) {
  // The colour of the amount in the row that names `who`, on the current page.
  const colourOf = (page, who) => page.evaluate((who) => {
    const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes(who));
    if (!li) return null;
    const amt = [...li.querySelectorAll("span, div")].find((el) => /^[+−]\$[\d,]+/.test(el.textContent.trim()) && el.children.length === 0);
    return amt ? getComputedStyle(amt).color : null;
  }, who);
  await withPage(browser, async (page) => {
    for (const route of ["/transactions", "/"]) {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const income = await colourOf(page, "Acme Corp Paycheck");
      const transfer = await colourOf(page, "Card Payment Received");
      // Tailwind v4 emits emerald as lab(); older builds as rgb(). Green = negative a* (lab) or g-dominant (rgb).
      const green = (c) => {
        if (!c) return false;
        const n = c.match(/-?\d+(\.\d+)?/g).map(Number);
        if (c.startsWith("lab(")) return n[1] < -10;
        if (c.startsWith("rgb(")) return n[1] > n[0] && n[1] > n[2];
        return false;
      };
      record("money colour", `${route} · income is green`, green(income), income);
      record("money colour", `${route} · excluded-category inflow is not`, transfer !== null && !green(transfer), transfer);
    }
  });
}

async function categoryBadge(browser) {
  // One chip, one shape: every badge on every list page is a full circle of the
  // same size (recurrings used rounded-xl before), and none shows the recurring
  // glyph as a stand-in for a missing icon.
  await withPage(browser, async (page) => {
    for (const route of ["/", "/transactions", "/categories"]) {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-category-badge]");
      const r = await page.$$eval("[data-category-badge]", (els) => {
        const radii = new Set(els.map((e) => getComputedStyle(e).borderRadius));
        const sizes = new Set(els.map((e) => Math.round(e.getBoundingClientRect().width)));
        const glyphFallback = els.filter((e) => e.textContent.trim() === "↻").length;
        return { n: els.length, radii: [...radii], sizes: [...sizes], glyphFallback };
      });
      const round = r.radii.every((x) => parseFloat(x) >= 999);
      record("category badge", `${route} · ${r.n} badges, one shape`, round && r.sizes.length <= 2 && r.glyphFallback === 0, `radii ${r.radii.join("/")}, widths ${r.sizes.join("/")}px, ↻ fallbacks ${r.glyphFallback}`);
    }
  });
}

async function recurringGlyph(browser) {
  // Take one Netflix charge out of its plan from the shelf; the row's glyph must
  // go — on the transactions row AND on the dashboard's recent list. (It used to
  // stay, struck through, which read as a broken subscription beside a
  // never-in-a-plan purchase that showed nothing.) Then restore.
  await withPage(browser, async (page, errs) => {
    const glyphOn = (page, who) => page.evaluate((who) => {
      const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes(who));
      const g = li && li.querySelector("[data-recurring]"); return g ? g.getAttribute("data-recurring") : null;
    }, who);
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    record("recurring glyph", "transactions · Netflix charge is in its series", (await glyphOn(page, "Netflix")) === "in");
    await page.evaluate(() => { const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes("Netflix")); li.setAttribute("data-ui-target", "1"); li.scrollIntoView({ block: "center" }); });
    await sleep(300);
    await page.click("[data-drawer-row][data-ui-target]"); await shelfIs(page, true); await shelfSettled(page);
    await page.click(`${shelfSel} button[data-membership='in']`);
    await page.waitForFunction(() => { const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes("Netflix")); return li && !li.querySelector("[data-recurring]"); }, { timeout: 8000 }).catch(() => {});
    record("recurring glyph", "transactions · a charge taken out of its plan shows no glyph (not a struck one)", (await glyphOn(page, "Netflix")) === null, `glyph=${await glyphOn(page, "Netflix")}`);
    await page.keyboard.press("Escape"); await shelfIs(page, false);
    await page.goto(BASE + "/", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    record("recurring glyph", "dashboard · same charge shows no glyph", (await glyphOn(page, "Netflix")) === null);
    // restore
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    await page.evaluate(() => { const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes("Netflix")); li.setAttribute("data-ui-target", "1"); li.scrollIntoView({ block: "center" }); });
    await sleep(300);
    await page.click("[data-drawer-row][data-ui-target]"); await shelfIs(page, true); await shelfSettled(page);
    await page.click(`${shelfSel} button[data-membership='out']`);
    await page.waitForFunction(() => { const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes("Netflix")); const g = li && li.querySelector("[data-recurring]"); return g && g.getAttribute("data-recurring") === "in"; }, { timeout: 10000 });
    await page.keyboard.press("Escape");
    record("recurring glyph", "transactions · restored to in", true);
    if (errs.length) record("recurring glyph", "page errors", false, errs[0]);
  });
}

async function inlineEdit(browser) {
  // The click-to-edit name is the row button that wraps a truncated span (the
  // editable category badge also carries a ✎ cue, so target by structure).
  const clickName = (page) => page.evaluate(() => {
    const btn = [...document.querySelectorAll("[data-drawer-row] button")].find((b) => b.querySelector("span.truncate"));
    if (!btn) return null; const name = btn.querySelector("span.truncate").textContent; btn.click(); return name;
  });
  const typeIntoFocused = async (page, text) => {
    await page.waitForFunction(() => document.activeElement && document.activeElement.tagName === "INPUT", { timeout: 5000 });
    await page.evaluate(() => document.activeElement.select());
    await page.keyboard.type(text);
  };
  const rowsText = (page) => page.evaluate(() => [...document.querySelectorAll("[data-drawer-row]")].map((r) => r.innerText).join("\n"));
  await withPage(browser, async (page, errs) => {
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const original = await clickName(page);
    await typeIntoFocused(page, "Dining Out"); await page.keyboard.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll("[data-drawer-row]")].some((r) => r.innerText.includes("Dining Out")), { timeout: 8000 });
    record("inline edit", "categories · Enter commits a rename", true, `${original} → Dining Out`);
    await clickName(page);
    await typeIntoFocused(page, "Garbage"); await page.keyboard.press("Escape");
    await sleep(600);
    const t = await rowsText(page);
    record("inline edit", "categories · Escape reverts a rename", t.includes("Dining Out") && !t.includes("Garbage"));
    const budget = await page.$("input[aria-label='Monthly budget']");
    const before = await budget.evaluate((el) => el.value);
    await budget.click({ clickCount: 3 }); await budget.type("999999"); await page.keyboard.press("Escape");
    await sleep(600);
    const afterB = await page.evaluate(() => document.querySelector("input[aria-label='Monthly budget']").value);
    record("inline edit", "categories · Escape reverts the budget input", afterB === before, `${before} → ${afterB}`);
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const rec = await clickName(page);
    await typeIntoFocused(page, "Netflix HD"); await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.body.innerText.includes("Netflix HD"), { timeout: 8000 });
    record("inline edit", "recurrings · Enter commits a rename", true, `${rec} → Netflix HD`);
    // The shelf closes on a mousedown outside it, which unmounts the name input
    // before its blur lands. The edit must still be saved (flush on unmount),
    // or a rename typed in the shelf is silently lost.
    await page.click("[data-drawer-row]");
    await page.waitForSelector("aside.fixed button[aria-label^='Rename ']", { timeout: 8000 });
    await page.click("aside.fixed button[aria-label^='Rename ']");
    await typeIntoFocused(page, "Streaming Plan");
    const outside = await page.evaluate(() => {
      const h = [...document.querySelectorAll("h1, h2")].find((e) => !e.closest("aside"));
      const r = h?.getBoundingClientRect();
      return r ? { x: r.left + 4, y: r.top + r.height / 2 } : null;
    });
    if (outside) await page.mouse.click(outside.x, outside.y);
    const closed = await page.waitForFunction(() => !document.querySelector("aside.fixed"), { timeout: 5000 }).then(() => true).catch(() => false);
    const saved = await page.waitForFunction(() => [...document.querySelectorAll("[data-drawer-row]")].some((r) => r.innerText.includes("Streaming Plan")), { timeout: 8000 }).then(() => true).catch(() => false);
    record("inline edit", "shelf · clicking outside closes the shelf and still saves the rename", !!outside && closed && saved, `outside target=${!!outside} closed=${closed} saved=${saved}`);
    if (errs.length) record("inline edit", "page errors", false, errs[0]);
  });
}

async function recurringsRow(browser) {
  // Controls sit in fixed columns (same x on every row), read as buttons (a
  // border), use the §2 vocabulary, and the amount is full-weight foreground.
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row] select");
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-drawer-row]")].filter((li) => li.querySelector("select"));
      const x = (el) => Math.round(el.getBoundingClientRect().left);
      const rowMenus = rows.filter((li) => li.querySelector("button[aria-haspopup]")).length;
      const selects = rows.map((li) => x(li.querySelector("[data-category-caret]") || li.querySelector("select")));
      const caretGaps = rows.map((li) => { const c = li.querySelector("[data-category-caret]"); const t = c && c.previousElementSibling; return c && t ? Math.round(c.getBoundingClientRect().left - t.getBoundingClientRect().right) : null; });
      const amounts = rows.map((li) => { const els = [...li.querySelectorAll("div")]; return els.find((d) => /^\$[\d,]+\.\d\d$/.test(d.textContent.trim())); });
      const fg = getComputedStyle(document.body).color;
      const nameXs = [...new Set(rows.map((li) => x(li.children[1])))]; // date, name…
      const cadenceTags = rows.map((li) => { const t = li.querySelector("[data-cadence]"); return t ? { text: t.textContent.trim(), afterName: t.previousElementSibling != null && t.previousElementSibling.textContent.trim().length > 0 } : null; });
      const dateXs = [...new Set(rows.map((li) => x(li.children[0])))];
      const names = rows.map((li) => li.querySelector("span.truncate")).filter(Boolean);
      const truncated = names.filter((n) => n.scrollWidth > n.clientWidth).length;
      return {
        rows: rows.length,
        rowMenus, selectXs: [...new Set(selects)],
        amountColours: [...new Set(amounts.map((a) => a && getComputedStyle(a).color))], foreground: fg,
        amountStates: rows.map((li) => { const a = li.lastElementChild; return { state: a.getAttribute("data-amount-state"), color: getComputedStyle(a).color, weight: getComputedStyle(a).fontWeight }; }),
        mutedColour: getComputedStyle(document.body).getPropertyValue("--muted").trim(),
        truncated, names: names.length, nameXs, dateXs, cadenceTags,
        dateColours: [...new Set(rows.map((li) => getComputedStyle(li.children[0]).color))],
        marked: document.querySelectorAll("[data-drawer-row] button[aria-haspopup][data-marked], [data-drawer-row] button[aria-haspopup] span[aria-hidden]").length,
        caretGaps: [...new Set(caretGaps)],
        monthlyLabels: rows.filter((li) => /\bMonthly\b/.test(li.textContent)).length,
        leadingGlyphs: rows.filter((li) => li.querySelector("[data-category-badge]")).length,
        gutterSameEdge: (() => { const t = document.querySelector("h1"); const d = rows[0] && rows[0].children[0]; return t && d ? Math.abs(x(t) - x(d)) : null; })(),
        cardInset: (() => { const li = rows[0]; const card = li && li.closest(".card"); return li && card ? Math.round(li.children[0].getBoundingClientRect().left - card.getBoundingClientRect().left) : null; })(),
        // One list in date order with a Today divider: nothing overdue below
        // it, nothing upcoming above it.
        order: (() => { const list = document.querySelector("[data-bill-list]"); if (!list) return null; const items = [...list.querySelectorAll("[data-drawer-row], [data-bill-anchor='up']")]; const dues = items.filter((e) => e.hasAttribute("data-due")).map((e) => e.getAttribute("data-due")); const div = items.findIndex((e) => e.hasAttribute("data-bill-anchor")); const st = (e) => e.getAttribute("data-bill-status"); return { sorted: dues.every((d, i) => i === 0 || dues[i - 1] <= d), divider: div >= 0, odBelow: div >= 0 && items.slice(div + 1).some((e) => st(e) === "od"), upAbove: div >= 0 && items.slice(0, div).some((e) => st(e) === "up"), lists: document.querySelectorAll("[data-bill-list]").length, sections: document.querySelectorAll("[data-bill-section]").length }; })(),
        bar: (() => { const b = document.querySelector("[data-summary] [role='progressbar']"); return !!b && /%/.test(b.getAttribute("aria-label") || "") && b.getAttribute("aria-valuenow") !== null; })(),
        summary: !!document.querySelector("[data-summary] .stat-label") && [...document.querySelectorAll("[data-summary] .stat-label")].some((l) => /paid/i.test(l.textContent)) && /overdue/i.test(document.querySelector("[data-summary]").textContent),
      };
    });
    record("recurrings row", `${r.rows} rows · no row menu (the verbs live in the shelf)`, r.rows >= 2 && r.rowMenus === 0, `row menus: ${r.rowMenus}`);
    record("recurrings row", "category chevrons in one column", r.selectXs.length === 1, `x=${r.selectXs.join("/")}`);
    record("recurrings row", "category chevron sits beside its label", r.caretGaps.every((g) => g !== null && g <= 8), `gaps ${r.caretGaps.join("/")}px`);
    record("recurrings row", "cadence shows only when not monthly, as a tag after the name", r.monthlyLabels === 0 && r.cadenceTags.every((t) => t === null || t.afterName), `"Monthly" rows: ${r.monthlyLabels}; tags: ${r.cadenceTags.filter(Boolean).map((t) => t.text).join("/") || "none"}`);
    record("recurrings row", "one category icon per row (none before the name)", r.leadingGlyphs === 0, `leading glyphs: ${r.leadingGlyphs}`);
    {
      // Paid amounts are settled (foreground, semibold); expected ones are
      // provisional (muted, medium). The fixture has both.
      const hex = (rgb) => { const m = rgb.match(/\d+/g); return m ? "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("") : rgb; };
      const paid = r.amountStates.filter((a) => a.state === "settled");
      const expected = r.amountStates.filter((a) => a.state === "provisional");
      const paidOk = paid.length > 0 && paid.every((a) => a.color === r.foreground && Number(a.weight) >= 600);
      const expectedOk = expected.length > 0 && expected.every((a) => hex(a.color) === r.mutedColour.toLowerCase() && Number(a.weight) === 500);
      record("recurrings row", "paid amounts read settled, expected amounts read provisional", paidOk && expectedOk, `paid ${paid.length} (fg, ≥600), expected ${expected.length} (muted, 500)`);
    }
    record("recurrings row", "no name truncated at 1280px", r.truncated === 0, `${r.truncated} of ${r.names}`);
    record("recurrings row", "date and name columns share one x each", r.dateXs.length === 1 && r.nameXs.length === 1, `date x=${r.dateXs.join("/")}, name x=${r.nameXs.join("/")}`);
    record("recurrings row", "rows sit in section cards, text inset by the card's border + 16px padding", r.cardInset === 17, `inset ${r.cardInset}px`);
    record("recurrings row", "one list in date order; the Today divider has nothing overdue below it or upcoming above it", !!r.order && r.order.sorted && r.order.sections === 0 && !r.order.odBelow && !r.order.upAbove, r.order ? `sorted=${r.order.sorted}, divider=${r.order.divider}, sections=${r.order.sections}` : "no list");
    record("recurrings row", "summary card shows paid, left to pay, and the status line", r.summary, r.summary ? "present" : "missing");
    record("recurrings row", "summary bar is a labelled progressbar", r.bar, r.bar ? "role + label + value" : "missing");
    // Escape in steps: the first closes the shelf and leaves the row focused
    // (a keyboard user still knows where they are); the second drops focus.
    {
      await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      await page.click("[data-drawer-row]"); await page.waitForSelector("[data-shelf]");
      await page.keyboard.press("Escape"); await new Promise((r) => setTimeout(r, 300));
      const afterOne = await page.evaluate(() => ({ shelf: !!document.querySelector("[data-shelf]"), rowFocused: document.activeElement?.hasAttribute("data-drawer-row") }));
      await page.keyboard.press("Escape"); await new Promise((r) => setTimeout(r, 200));
      const afterTwo = await page.evaluate(() => ({ rowFocused: document.activeElement?.hasAttribute("data-drawer-row"), tag: document.activeElement?.tagName }));
      record("keyboard rows", "Escape closes the shelf, then Escape drops the row's focus", !afterOne.shelf && afterOne.rowFocused && !afterTwo.rowFocused, `after 1: shelf=${afterOne.shelf} row=${afterOne.rowFocused}; after 2: row=${afterTwo.rowFocused} (${afterTwo.tag})`);
    }
    // ↓ with the shelf open moves the shelf to the next row; ↑ moves it back.
    {
      await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const names = await page.$$eval("[data-drawer-row]", (rows) => rows.map((r) => r.children[1].textContent.replace("✎", "").trim()));
      await page.click("[data-drawer-row]"); await page.waitForSelector("[data-shelf]");
      await shelfSettled(page); // the header shows the row's name, then its alias once the shelf has read
      const title = () => page.$eval("[data-shelf] header", (h) => h.innerText.split("\n")[0].replace("✎", "").trim());
      const t0 = await title();
      await page.keyboard.press("ArrowDown"); await new Promise((r) => setTimeout(r, 700));
      const t1 = await title();
      await page.keyboard.press("ArrowUp"); await new Promise((r) => setTimeout(r, 700));
      const t2 = await title();
      record("keyboard rows", "↓ / ↑ move the open shelf to the adjacent row", names.length >= 2 && t0 !== t1 && t1.startsWith(names[1].slice(0, 6)) && t2 === t0, `${t0} → ${t1} → ${t2}`);
      await page.keyboard.press("Escape");
    }
    // The vendor shelf's Recent rows carry one two-state pill: "In plan"
    // flips to "Not in plan" (with an edited tag: the user decided) and back
    // — no menu.
    {
      await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      await page.evaluate(() => { const row = [...document.querySelectorAll("[data-drawer-row]")].find((r) => /Netflix/.test(r.textContent)); row?.click(); });
      await page.waitForSelector("[data-shelf] button[data-membership]");
      const pillText = () => page.$eval("[data-shelf] button[data-membership]", (b) => b.textContent.trim());
      const menus = await page.$$eval("[data-shelf] button[aria-label='Edit transaction']", (bs) => bs.length);
      const pillEdited = () => page.$eval("[data-shelf] button[data-membership]", (b) => b.getAttribute("data-edited") === "1");
      const t1 = await pillText();
      const e1 = await pillEdited();
      // The toggle must not blank the shelf (no skeleton) while it re-reads.
      const flashed = await page.evaluate(async () => { let seen = false; const b = document.querySelector("[data-shelf] button[data-membership]"); b.click(); const t0 = Date.now(); while (Date.now() - t0 < 1200) { if (document.querySelector("[data-shelf] .animate-pulse")) seen = true; await new Promise((r) => setTimeout(r, 30)); } return seen; });
      await page.waitForSelector("[data-shelf] button[data-membership]");
      const t2 = await pillText();
      const e2 = await pillEdited();
      await page.click("[data-shelf] button[data-membership]"); await new Promise((r) => setTimeout(r, 1200));
      await page.waitForSelector("[data-shelf] button[data-membership]");
      const t3 = await pillText();
      record("shelf", "Recent rows: one two-state pill flips a charge out (edited) and back (auto); no row menu", menus === 0 && t1 === "In plan" && !e1 && t2 === "Not in plan" && e2 && t3 === "In plan", `menus ${menus}; ${t1}${e1 ? " (edited)" : ""} → ${t2}${e2 ? " (edited)" : ""} → ${t3}`);
      record("shelf", "toggling a pill re-reads without blanking the shelf", !flashed, flashed ? "skeleton flashed" : "no skeleton");
      await page.keyboard.press("Escape");
    }
    // The inline editor raises no tooltip: hovering a name, or its ✎ cue, shows
    // nothing (the button's aria-label carries "Rename"). Hover media only.
    {
      const canHover = await page.evaluate(() => matchMedia("(hover: hover)").matches);
      if (canHover) {
        const nameText = await page.$("[data-drawer-row] button[aria-label^='Rename'] > span:first-child");
        await nameText.hover(); await new Promise((r) => setTimeout(r, 200));
        const cue = await page.$("[data-drawer-row] button[aria-label^='Rename'] > span:last-child");
        await cue.hover(); await new Promise((r) => setTimeout(r, 200));
        const tip = await page.$("[role='tooltip']");
        const label = await page.$eval("[data-drawer-row] button[aria-label^='Rename']", (b) => b.getAttribute("aria-label"));
        record("inline edit", "no rename bubble; the button is labelled for assistive tech", !tip && /^Rename /.test(label || ""), `tooltip: ${!!tip}; aria-label: ${label}`);
        await page.mouse.move(5, 5);
      }
    }
    // Narrow layouts: with the sidebar up and a ~330px content column, the row
    // must still show its name and keep its amount inside the card.
    for (const w of [700, 900]) {
      await page.setViewport({ width: w, height: 700 });
      await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const n = await page.evaluate(() => { const row = document.querySelector("[data-drawer-row]"); const kids = [...row.children]; const name = kids[1].getBoundingClientRect(); const amount = kids[kids.length - 1].getBoundingClientRect(); const rb = row.getBoundingClientRect(); return { name: Math.round(name.width), amountInside: amount.right <= rb.right + 1, overflow: row.scrollWidth - row.clientWidth }; });
      record("recurrings row", `at ${w}px the name has room and the amount stays inside the card`, n.name >= 60 && n.amountInside && n.overflow <= 0, `name ${n.name}px, amount inside=${n.amountInside}, overflow ${n.overflow}px`);
    }
    // On a phone the name has the row: the cell is at least 150px wide, and a
    // cadence tag that doesn't fit beside the name sits below it.
    {
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const p = await page.evaluate(() => { const rows = [...document.querySelectorAll("[data-drawer-row]")]; const cell = rows[0].children[1].getBoundingClientRect(); const tagged = rows.find((r) => r.querySelector("[data-cadence]")); let below = null; if (tagged) { const n = tagged.querySelector(".truncate").getBoundingClientRect(); const t = tagged.querySelector("[data-cadence]").getBoundingClientRect(); below = t.right <= n.right + 8 + t.width + 1 && (t.top >= n.bottom - 2 || t.right <= cell.right + 1); } return { cellW: Math.round(cell.width), below }; });
      record("recurrings row", "at 390px the name cell is at least 150px wide and a cadence tag never overflows it", p.cellW >= 150 && p.below !== false, `cell ${p.cellW}px${p.below === null ? ", no tagged row in the fixture" : ""}`);
    }
    await page.setViewport({ width: 1280, height: 860 });
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" }); // back from the phone emulation
    await page.waitForSelector("[data-drawer-row]");
    // A hovered row takes the hover token — a wash of the card surface, not the
    // page grey behind it. Hover media is not available in headless Linux CI.
    {
      const canHover = await page.evaluate(() => matchMedia("(hover: hover)").matches);
      if (canHover) {
        const row = await page.$("[data-drawer-row]");
        await row.hover(); await new Promise((r) => setTimeout(r, 150));
        const c = await page.evaluate(() => { const el = document.querySelector("[data-drawer-row]"); const cs = getComputedStyle(el).backgroundColor; const root = getComputedStyle(document.documentElement); return { row: cs, page: root.getPropertyValue("--background").trim(), card: root.getPropertyValue("--card").trim() }; });
        const hex = (rgb) => { const m = rgb.match(/\d+/g); return m ? "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("") : rgb; };
        const rowHex = hex(c.row);
        record("recurrings row", "hovered row is a wash of the card, not the page grey", rowHex !== c.page.toLowerCase() && rowHex !== c.card.toLowerCase() && rowHex !== "#000000", `row ${rowHex}, page ${c.page}, card ${c.card}`);
      }
    }
    // A count in the status line jumps to its section.
    {
      const target = "[data-bill-anchor='up'], [data-bill-status='up']";
      const before = await page.evaluate((q) => document.querySelector(q)?.getBoundingClientRect().top ?? null, target);
      await page.evaluate(() => window.scrollTo(0, 0));
      const clicked = await page.$("[data-section-link='up']");
      if (clicked) { await clicked.click(); await new Promise((r) => setTimeout(r, 700)); }
      // On a page shorter than the viewport nothing can scroll; the section must
      // simply be in view. On a taller page it must land near the top.
      const after = await page.evaluate((q) => { const el = document.querySelector(q); const top = el ? el.getBoundingClientRect().top : null; return { top, scrollable: document.documentElement.scrollHeight > window.innerHeight + 10, vh: window.innerHeight }; }, target);
      const ok = !!clicked && after.top !== null && after.top >= -2 && (after.scrollable ? after.top <= 120 : after.top <= after.vh);
      record("recurrings row", "'N upcoming' in the summary scrolls to the Today divider (or the first upcoming row)", ok, clicked ? `target top ${before}px → ${after.top}px${after.scrollable ? "" : " (page fits the viewport)"}` : "no link");
    }
    const strayDot = await page.evaluate(() => [...document.querySelectorAll("[data-drawer-row] span[aria-label='Has custom settings']")].length);
    record("recurrings row", "no settings dot anywhere in the row", strayDot === 0 && r.marked === 0, `on ⋯: ${r.marked}, after name: ${strayDot}`);
    // the verbs live in the shelf, in §2 vocabulary, reached from the row
    await page.click("[data-drawer-row]"); await page.waitForSelector("[data-shelf]"); await shelfSettled(page); // the verbs arrive with the data, not the skeleton
    const shelfText = await page.evaluate(() => document.querySelector("[data-shelf]").innerText);
    record("recurrings row", "the row opens the shelf, which holds Not recurring + Mark ended", shelfText.includes("Not recurring") && shelfText.includes("Mark ended"), "both present");
    await page.keyboard.press("Escape");

    // "+ New category…" in a row's dropdown creates the category in place and
    // applies it to that row (DESIGN: correct on the object, not in a panel).
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row] select[aria-label='Category']");
    await page.select("[data-drawer-row] select[aria-label='Category']", "__new__");
    const popover = await page.waitForSelector("[role='dialog'][aria-label='New category'] [data-new-category-form]", { timeout: 5000 }).catch(() => null);
    record("recurrings row", "+ New category… opens the create form under the dropdown", !!popover, popover ? "form shown" : "no form");
    if (popover) {
      await page.type("[data-new-category-form] input[aria-label='New category name']", "Lake Utilities");
      await page.click("[data-new-category-form] button.btn-primary");
      const applied = await page
        .waitForFunction(
          () => document.querySelector("[data-drawer-row] [data-category-caret]")?.previousElementSibling?.textContent?.includes("Lake Utilities"),
          { timeout: 8000 }
        )
        .then(() => true)
        .catch(() => false);
      const gone = await page.$("[role='dialog'][aria-label='New category']");
      record("recurrings row", "created category is applied to that row and the form closes", applied && !gone, `applied=${applied} form open=${!!gone}`);
      const inFilter = await page.$$eval("select[aria-label='Filter by category'] option, select option", (os) => os.some((o) => o.textContent.includes("Lake Utilities")));
      record("recurrings row", "new category appears in the pickers without a reload", inFilter, inFilter ? "listed" : "missing");
    }

    // The same option in the shelf's Category field: the popover is portaled
    // outside the shelf panel, so clicking into it must not close the shelf.
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    await page.click("[data-drawer-row]");
    await page.waitForSelector("aside.fixed select[aria-label='Category']", { timeout: 8000 });
    await page.select("aside.fixed select[aria-label='Category']", "__new__");
    const shelfForm = await page.waitForSelector("[role='dialog'][aria-label='New category'] input[aria-label='New category name']", { timeout: 5000 }).catch(() => null);
    record("shelf", "+ New category… in the shelf's Category field opens the form", !!shelfForm, shelfForm ? "form shown" : "no form");
    if (shelfForm) {
      await shelfForm.click();
      await page.type("[data-new-category-form] input[aria-label='New category name']", "Lake Taxes");
      await page.click("[data-new-category-form] button.btn-primary");
      const applied = await page
        .waitForFunction(() => {
          const sel = document.querySelector("aside.fixed select[aria-label='Category']");
          return !!sel && sel.options[sel.selectedIndex]?.textContent.includes("Lake Taxes");
        }, { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      const shelfOpen = !!(await page.$("aside.fixed"));
      record("shelf", "created category is applied to the vendor and the shelf stays open", applied && shelfOpen, `applied=${applied} shelf open=${shelfOpen}`);
    }
    await page.screenshot({ path: "/tmp/copilot-recurrings-row.png" });
  });
}

// The dashboard's "need a category" rows carry the queue's proposal: the
// category the app would file the vendor under sits in the picker with an
// Apply beside it, and a vendor with no proposal keeps the plain picker. Apply
// is the queue's Apply, so the vendor's rule is learned: the next charge from
// that vendor arrives categorized. Before, the dashboard showed the work and
// the help sat on Transactions; and its own picker filed one charge with no
// rule, so the same vendor came back uncategorized next month.
async function dashboardProposal(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle2" });
    await pickMonth(page, day(-1, 1).slice(0, 7)); // Pinewood's third charge and Zylo's are last month
    await page.waitForSelector("[data-uncategorized] [data-drawer-row]");
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-uncategorized] [data-drawer-row]")];
      const read = (name) => { const li = rows.find((x) => x.innerText.includes(name)); if (!li) return null; const sel = li.querySelector("[data-category-property] select"); return { proposed: li.getAttribute("data-proposed"), picked: sel?.options[sel.selectedIndex]?.textContent.trim() ?? "", apply: [...li.querySelectorAll("[data-queue-accept]")].filter((b) => b.getBoundingClientRect().width > 0).length }; };
      return { pinewood: read("Pinewood Hardware"), zylo: read("Zylo Widget Works") };
    });
    record("dashboard proposal", "a vendor with history shows its proposed category in the picker, with Apply; one without keeps the plain picker", r.pinewood?.proposed === "Groceries" && /Groceries/.test(r.pinewood.picked) && r.pinewood.apply === 1 && r.zylo && r.zylo.proposed == null && /Uncategorized/.test(r.zylo.picked) && r.zylo.apply === 0, JSON.stringify(r));
    if (!r.pinewood) return;
    await page.evaluate(() => [...document.querySelectorAll("[data-uncategorized] [data-drawer-row]")].find((x) => x.innerText.includes("Pinewood Hardware")).querySelector("[data-queue-accept]").click());
    const left = await page.waitForFunction(() => ![...document.querySelectorAll("[data-uncategorized] [data-drawer-row]")].some((x) => x.innerText.includes("Pinewood Hardware")), { timeout: 8000 }).then(() => true).catch(() => false);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 });
    // The rule: a fourth Pinewood charge, imported after Apply, is already Groceries.
    const csv = [["Date", "Name", "Amount", "Account"], [day(0, 8), "Pinewood Hardware", "-27.50", "Credit"]].map((x) => x.join(",")).join("\n");
    await fetch(BASE + "/api/import", { method: "POST", body: csv });
    const rows = (await (await fetch(BASE + "/api/transactions?q=Pinewood&limit=10")).json()).rows ?? [];
    const cats = rows.map((x) => x.categoryName ?? null);
    record("dashboard proposal", "Apply files the charge and teaches the rule: the vendor's next charge arrives categorized", left && rows.length === 4 && cats.every((c) => c === "Groceries"), `row left=${left}; ${rows.length} Pinewood charges: ${cats.join(", ")}`);
  });
}

// One decision per vendor: an uncategorized duplicate candidate gets no category
// proposal (and no model call) while its merge is pending — the category queue
// and the dashboard row point at the merge card, whose Combine sets the category.
// Before, the queue guessed at the same vendor the merge queue had already
// decoded, and Apply-then-Combine left the guess in place and learned as a rule.
async function deferToMerge(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-deferred]", { timeout: 8000 }).catch(() => {});
    const q = await page.evaluate(() => ({
      deferred: [...document.querySelectorAll("[data-deferred]")].map((el) => [el.getAttribute("data-deferred"), el.textContent.replace(/\s+/g, " ").trim().slice(0, 60)]),
      proposed: [...document.querySelectorAll("[data-suggestion]")].some((li) => /Marlows Deli/.test(li.textContent)),
      mergeNote: [...document.querySelectorAll("body *")].map((el) => el.textContent).find((t) => /Marlows Deli/.test(t) && /Combine/.test(t)) ? true : false,
    }));
    const line = q.deferred.find(([to]) => to === "Marlow's Deli");
    record("defer to merge", "the category queue defers a duplicate candidate to its merge card instead of proposing", !!line && /^Marlows Deli \(1\) · possibly Marlow's Deli/.test(line[1]) && !q.proposed, JSON.stringify(q.deferred) + ` proposed=${q.proposed}`);
    await page.goto(BASE + "/", { waitUntil: "networkidle2" });
    await pickMonth(page, day(-2, 1).slice(0, 7));
    await page.waitForSelector("[data-uncategorized] [data-drawer-row]");
    const d = await page.evaluate(() => {
      const li = [...document.querySelectorAll("[data-uncategorized] [data-drawer-row]")].find((x) => x.innerText.includes("Marlows Deli"));
      if (!li) return null;
      const link = [...li.querySelectorAll("a[data-deferred]")].find((a) => a.getBoundingClientRect().width > 0);
      const sel = li.querySelector("[data-category-property] select");
      return { link: link?.textContent.trim() ?? null, href: link?.getAttribute("href"), picked: sel?.options[sel.selectedIndex]?.textContent.trim(), apply: [...li.querySelectorAll("[data-queue-accept]")].filter((b) => b.getBoundingClientRect().width > 0).length };
    });
    record("defer to merge", "the dashboard row points at the merge and keeps the plain picker, with no Apply", d?.link === "possibly Marlow's Deli →" && d.href === "/transactions" && /Uncategorized/.test(d.picked) && d.apply === 0, JSON.stringify(d));
    // Dismiss the merge: the vendor is a category question again.
    const merges = await (await fetch(BASE + "/api/merges")).json();
    const g = merges.find((x) => x.variants?.some((v) => v.merchant === "Marlows Deli"));
    if (g) await fetch(BASE + "/api/merges", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss", keys: g.dismissKeys?.length ? g.dismissKeys : [g.key] }) });
    const after = await (await fetch(BASE + "/api/category-suggestions")).json();
    record("defer to merge", "dismissing the merge brings the vendor back to the category queue", !!g && !after.deferred.some((x) => x.merchant === "Marlows Deli") && after.needsModelCount >= 1, `merge card=${!!g}; deferred after: ${after.deferred.map((x) => x.merchant).join(",") || "none"}; needs model: ${after.needsModelCount}`);
  });
}

// ---------- main ----------
const t0 = Date.now();
let browser;
try {
  await waitForServer();
  await loadFixture();
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  for (const [name, fn] of [
    ["load states", honestLoadStates], ["keyboard rows", keyboardRows], ["page header", pageHeader], ["dashboard", dashboardAnatomy], ["dashboard bars", dashboardBars], ["resting actions", restingActions],
    ["qualifiers", partialMonthQualifiers], ["statement mode", statementMode], ["vendor header", vendorHeaderCounts], ["vendor header category", vendorHeaderCategory], ["split drift", splitDrift], ["split rules", splitRulesInShelf], ["queue buttons", queueButtons], ["model suggestions", modelSuggestionTiers], ["quiet login", quietLogin], ["phone layout", phoneLayout], ["open vendor", openVendorFromCharge], ["ios autofill tag", iosAutofillTag], ["app name", appName], ["start a plan", startAPlan], ["vendor shelf", multiPlanVendor], ["card heights", cardHeights], ["split → undo", splitUndo],
    ["shelf settings", shelfSettings], ["money colour", moneyColour], ["budget colour", budgetBarColour], ["category badge", categoryBadge], ["recurring glyph", recurringGlyph], ["inline edit", inlineEdit], ["recurrings row", recurringsRow], ["tap targets", tapTargets], ["stale shelf read", staleShelfRead], ["dashboard proposal", dashboardProposal], ["defer to merge", deferToMerge], ["not counted", notCountedPlans], ["named plan", namedPlanStays],
  ]) {
    try { await fn(browser); } catch (e) { record(name, "threw", false, String(e.message).split("\n")[0]); }
  }
} finally {
  if (browser) await browser.close();
  stopServer();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "✖" : "✔"} test:ui — ${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - t0) / 1000)}s`);
if (failed.length) { console.table(failed); process.exit(1); }
