const { chromium, devices } = require("playwright");
const B = process.env.COGNIS_URL || "http://localhost:8787";
const SP = process.argv[2] || ".";
require("fs").mkdirSync(`${SP}/shots`, { recursive: true });
const log = (...a) => console.log("STEP", ...a);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  const email = `e2e-${Date.now()}@example.com`;

  await page.goto(B + "/");
  await page.screenshot({ path: `${SP}/shots/01-landing.png` });
  log("landing ok");

  await page.goto(B + "/sign-up");
  await page.fill("#email", email);
  await page.fill("#password", "short");
  await page.click("button[type=submit]");
  await page.getByText("Use at least 10 characters.").first().waitFor();
  log("client validation ok");
  await page.fill("#password", "e2e-password-long-1");
  await page.click("button[type=submit]");
  await page.waitForURL("**/app/welcome");
  await page.screenshot({ path: `${SP}/shots/02-welcome.png` });
  log("registered -> welcome");

  await page.fill("textarea", "Reddit marketing strategy\nPost in niche subreddits, answer questions, and share launch lessons instead of ads.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText(/^Saved "/).waitFor();
  log("first item saved via onboarding");

  await page.getByRole("button", { name: "Go to my library" }).click();
  await page.waitForURL(B + "/app");
  await page.fill("textarea", "LinkedIn positioning: say who you serve and the problem you solve in one sentence.");
  await page.getByRole("button", { name: "Title and tags" }).click();
  await page.fill("input[placeholder^='Tags']", "positioning, marketing");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved.").waitFor();
  await page.getByRole("list", { name: "Saved items" }).locator("li").nth(1).waitFor();
  await page.screenshot({ path: `${SP}/shots/03-library.png` });
  log("library shows 2 items");

  // duplicate detection
  await page.fill("textarea", "LinkedIn positioning: say who you serve and the problem you solve in one sentence.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("You already saved this").waitFor();
  log("duplicate detected in UI");

  // filter by tag
  await page.selectOption("#f-tag", "marketing");
  await page.waitForURL(/tag=marketing/);
  await page.waitForTimeout(400);
  const n = await page.getByRole("list", { name: "Saved items" }).locator("li").count();
  if (n !== 1) throw new Error("tag filter count " + n);
  log("tag filter ok");
  await page.getByRole("button", { name: "Clear filters" }).click();

  // search with keyboard shortcut
  await page.keyboard.press("/");
  await page.keyboard.type("subreddits launch");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/app\/search\?q=/);
  await page.getByRole("list", { name: "Search results" }).locator("li").first().waitFor();
  await page.getByText("Meaning-based search is unavailable").waitFor(); // local dev has no Workers AI
  await page.screenshot({ path: `${SP}/shots/04-search.png` });
  const firstTitle = await page.getByRole("list", { name: "Search results" }).locator("h3").first().innerText();
  if (!/Reddit/.test(firstTitle)) throw new Error("wrong top result " + firstTitle);
  log("search ok, degraded notice shown honestly");

  // detail + edit
  await page.getByRole("list", { name: "Search results" }).locator("a").first().click();
  await page.waitForURL(/\/app\/items\//);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.fill("#title", "Reddit launch playbook");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("heading", { name: "Reddit launch playbook" }).waitFor();
  await page.screenshot({ path: `${SP}/shots/05-item.png` });
  log("edit ok");

  // collections
  await page.goto(B + "/app/collections");
  await page.fill("#new-col", "Launch marketing");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("link", { name: /Launch marketing/ }).waitFor();
  await page.goto(B + "/app");
  await page.getByRole("list", { name: "Saved items" }).locator("a").first().click();
  await page.getByRole("button", { name: /Launch marketing/ }).click();
  await page.getByRole("button", { name: /✓ Launch marketing/ }).waitFor();
  log("added to collection");

  // delete item
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("group", { name: "Confirm delete" }).getByRole("button", { name: "Delete" }).click();
  await page.waitForURL(B + "/app");
  await page.waitForTimeout(400);
  const left = await page.getByRole("list", { name: "Saved items" }).locator("li").count();
  if (left !== 1) throw new Error("expected 1 item after delete, got " + left);
  log("delete ok");

  // account + export
  await page.goto(B + "/app/account");
  await page.getByText("Saved items").waitFor();
  await page.screenshot({ path: `${SP}/shots/06-account.png`, fullPage: true });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download my data" }).click()]);
  const fs = require("fs");
  const p = await dl.path();
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  if (data.items.length !== 1 || data.user.email !== email) throw new Error("bad export");
  log("export ok", data.items.length, "item");

  // mobile layout
  const m = await browser.newContext({ ...devices["iPhone 13"] });
  await m.addCookies(await ctx.cookies());
  const mp = await m.newPage();
  await mp.goto(B + "/app");
  await mp.getByRole("list", { name: "Saved items" }).waitFor();
  await mp.screenshot({ path: `${SP}/shots/07-mobile-library.png` });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error("horizontal overflow on mobile");
  await mp.goto(B + "/");
  await mp.screenshot({ path: `${SP}/shots/08-mobile-landing.png` });
  log("mobile ok, no horizontal overflow");

  // delete account
  await page.getByRole("button", { name: "Delete account…" }).click();
  await page.fill("#delpw", "e2e-password-long-1");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await page.waitForURL(/deleted=1/);
  const after = await page.request.get(B + "/api/v1/me");
  if (after.status() !== 401) throw new Error("session still valid after delete");
  await page.goto(B + "/sign-in");
  await page.fill("#email", email);
  await page.fill("#password", "e2e-password-long-1");
  await page.click("button[type=submit]");
  await page.getByText("That email and password do not match.").waitFor();
  log("account deleted, login rejected");

  // dark mode
  const d = await browser.newContext({ colorScheme: "dark", viewport: { width: 1280, height: 860 } });
  const dp = await d.newPage();
  await dp.goto(B + "/sign-in");
  await dp.screenshot({ path: `${SP}/shots/09-dark-signin.png` });
  log("console errors:", errors.length ? errors.join(" | ") : "none");
  await browser.close();
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
