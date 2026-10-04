// Smoke test: load every page in a real browser and assert no console errors /
// uncaught exceptions (catches client-side crashes a status check would miss),
// and hit every API route for a 200 + valid JSON. Requires the dev server up.
//   BASE_URL (default http://localhost:3000)
//   PUPPETEER_EXECUTABLE_PATH (default: system Chrome on macOS)
//   APP_PASSWORD (only when the login gate is on; read from .env.local by the
//     --env-file-if-exists flag in package.json, same file `next dev` reads)
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const month = new Date().toISOString().slice(0, 7);
const PAGES = ["/", "/transactions", "/categories", "/recurrings", "/accounts"];
const APIS = [
  "/api/dashboard",
  "/api/transactions?limit=5",
  `/api/recurrings?month=${month}`,
  "/api/recurrings/suggested",
  "/api/categories",
  "/api/accounts",
  "/api/months",
  "/api/merchants",
  "/api/merchant?name=Starbucks",
];
const IGNORE = [/favicon/i, /Download the React DevTools/i];

const failures = [];

// Fail fast if the server isn't up. A 401 is NOT "down" — it's the login gate
// (APP_PASSWORD set), which this script used to misread as an unreachable
// server, so the whole browser check silently stopped running once auth landed.
let gated = false;
try {
  const r = await fetch(BASE + "/api/months");
  if (r.status === 401) gated = true;
  else if (!r.ok) throw new Error(`status ${r.status}`);
} catch (e) {
  console.error(`✖ dev server not reachable at ${BASE} (${e.message}). Start it first.`);
  process.exit(1);
}

// Log in the same way a browser does: a native form POST, then carry the session
// cookie on every later request. The cookie NAME is read off the response rather
// than hard-coded, so it can't drift from src/lib/auth.ts.
let cookie = null;
if (gated) {
  if (!process.env.APP_PASSWORD) {
    console.error(
      `✖ ${BASE} requires a login (APP_PASSWORD is set for the server) but this ` +
        `process has no APP_PASSWORD to log in with. Put it in .env.local, or ` +
        `unset it on the server to run without auth.`
    );
    process.exit(1);
  }
  const r = await fetch(BASE + "/api/login", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: process.env.APP_PASSWORD, from: "/" }),
  });
  cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0])[0] ?? null;
  if (!cookie) {
    console.error(`✖ login rejected at ${BASE} — check APP_PASSWORD.`);
    process.exit(1);
  }
}
const headers = cookie ? { Cookie: cookie } : undefined;

for (const route of APIS) {
  try {
    const r = await fetch(BASE + route, { headers });
    if (!r.ok) failures.push(`API ${route} → HTTP ${r.status}`);
    else await r.json();
  } catch (e) {
    failures.push(`API ${route} → ${e.message}`);
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  if (cookie) {
    const [name, ...rest] = cookie.split("=");
    await browser.setCookie({
      name,
      value: rest.join("="),
      domain: new URL(BASE).hostname,
      path: "/",
    });
  }
  for (const route of PAGES) {
    const page = await browser.newPage();
    const errs = [];
    page.on("console", (m) => {
      if (m.type() === "error" && !IGNORE.some((re) => re.test(m.text()))) errs.push(m.text());
    });
    page.on("pageerror", (e) => errs.push(`uncaught: ${e.message}`));
    const resp = await page.goto(BASE + route, { waitUntil: "networkidle2", timeout: 20000 });
    if (!resp || !resp.ok()) failures.push(`PAGE ${route} → HTTP ${resp ? resp.status() : "no response"}`);
    await new Promise((r) => setTimeout(r, 400)); // let late errors surface
    for (const e of errs) failures.push(`PAGE ${route} console: ${e}`);
    await page.close();
  }
  // Sign out is only rendered when the gate is on. Click it, land on /login,
  // and confirm the API now refuses the session.
  if (gated) {
    const page = await browser.newPage();
    await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 20000 });
    const btn = await page.$("form[action='/api/logout'] button");
    if (!btn) failures.push("SIGN OUT: button not rendered while the gate is on");
    else {
      await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }), btn.click()]);
      if (!page.url().includes("/login")) failures.push(`SIGN OUT: landed on ${page.url()}, expected /login`);
      const status = await page.evaluate(() => fetch("/api/months").then((r) => r.status));
      if (status !== 401) failures.push(`SIGN OUT: /api/months still answers ${status} after sign-out`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`✖ smoke failed (${failures.length}):`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(
  `✔ smoke passed — ${PAGES.length} pages, ${APIS.length} APIs, no console errors` +
    (gated ? " (logged in; sign-out works)" : "")
);
