import puppeteer from "puppeteer-core";
import fs from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE ?? "http://localhost:3939";
const MONTH = process.env.MONTH ?? "2026-05"; // representative full month
const OUT = "screenshots";
fs.mkdirSync(OUT, { recursive: true });

const PAGES = [
  ["/", "dashboard", true],
  ["/transactions", "transactions", true],
  ["/categories", "categories", true],
  ["/recurrings", "recurrings", false],
  ["/accounts", "accounts", false],
];

// Set any month-picker <select> (options look like YYYY-MM) to MONTH and fire change.
async function pickMonth(page, month) {
  const changed = await page.evaluate((m) => {
    const sels = [...document.querySelectorAll("select")];
    const target = sels.find((s) =>
      [...s.options].some((o) => /^\d{4}-\d{2}$/.test(o.value) && o.value === m)
    );
    if (!target) return false;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value"
    ).set;
    setter.call(target, m);
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, month);
  return changed;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--force-color-profile=srgb"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });

for (const [route, name, hasMonth] of PAGES) {
  await page.goto(BASE + route, { waitUntil: "networkidle0", timeout: 30000 });
  if (hasMonth) {
    const ok = await pickMonth(page, MONTH);
    if (ok) {
      await new Promise((r) => setTimeout(r, 900)); // let the refetch render
    }
  }
  await new Promise((r) => setTimeout(r, 600));
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log("saved", file, hasMonth ? `(month ${MONTH})` : "");
}

await browser.close();
