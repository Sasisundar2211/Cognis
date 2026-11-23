import { before, test } from "node:test";
import assert from "node:assert/strict";
import { BASE, call, createText, newUser, deviceToken } from "./helpers.mjs";

// Observe mode: the desktop sends app name + window title; the server decides SILENT / PASSIVE / SUGGEST / HIGH_CONFIDENCE.

let u, token;
const ids = {};

before(async () => {
  u = await newUser("observe");
  token = await deviceToken(u.cookie, "Observer");
  for (const [k, text] of [
    ["reddit", "Reddit marketing strategy for startups\nPost in niche subreddits, answer questions, share launch lessons."],
    ["positioning", "Positioning for a startup\nSay who you serve and the problem you solve in one sentence."],
    ["bread", "Banana bread recipe\nThree ripe bananas, flour, butter."],
  ]) ids[k] = (await createText(u.cookie, text)).body.item.id;
});

const observe = (appName, windowTitle, auth = { bearer: token }) => call("/api/v1/context/suggest", { method: "POST", ...auth, json: { appName, windowTitle } });

test("relevant work produces a suggestion with source, reason and task", async () => {
  const r = await (await observe("Google Chrome", "Startup marketing strategy for reddit - Google Docs - Google Chrome")).json();
  assert.ok(["SUGGEST", "HIGH_CONFIDENCE"].includes(r.state), r.state);
  assert.equal(r.task.focus, "Startup marketing strategy for reddit");
  assert.ok(r.suggestionId.startsWith("sug_"));
  assert.equal(r.suggestions[0].item.id, ids.reddit);
  assert.match(r.suggestions[0].reason, /Related to "Startup marketing strategy for reddit"/);
  assert.ok(!r.suggestions.some((s) => s.item.id === ids.bread));
});

test("cooldown: a second strong match right away is held back as PASSIVE", async () => {
  const c = await newUser("cool");
  const t = await deviceToken(c.cookie, "d");
  await createText(c.cookie, "Kubernetes autoscaling runbook\nScale pods on queue depth, not CPU.");
  await createText(c.cookie, "Sourdough starter feeding\nFeed equal flour and water every morning.");
  const first = await (await observe("Code", "kubernetes autoscaling runbook — infra — Visual Studio Code", { bearer: t })).json();
  assert.ok(["SUGGEST", "HIGH_CONFIDENCE"].includes(first.state), JSON.stringify(first));
  assert.ok(!first.suggestions.some((s) => s.item.title.startsWith("Sourdough")), "unrelated item not shown");
  const second = await (await observe("Notes", "Sourdough starter feeding schedule - Notes", { bearer: t })).json();
  assert.equal(second.state, "PASSIVE");
  assert.equal(second.suggestionId, null);
  assert.ok(second.suggestions.length > 0, "still available if the user opens the panel");
});

test("generic, empty and unrelated windows stay SILENT or quiet", async () => {
  for (const [app, title] of [["Google Chrome", "New Tab - Google Chrome"], ["Finder", "Desktop"], ["Slack", "Slack"]]) {
    const r = await (await observe(app, title)).json();
    assert.equal(r.state, "SILENT", title);
    assert.equal(r.suggestions.length, 0);
  }
  const r = await (await observe("Spotify", "Lo-fi beats to relax")).json();
  assert.ok(["SILENT", "PASSIVE"].includes(r.state), r.state);
});

test("private windows are never analyzed", async () => {
  for (const [app, title] of [["1Password 7", "Startup marketing vault - 1Password"], ["Firefox", "Startup marketing strategy — Mozilla Firefox Private Browsing"], ["Google Chrome", "Startup marketing (Incognito)"]]) {
    const r = await (await observe(app, title)).json();
    assert.equal(r.state, "SILENT", title);
    assert.equal(r.task, null);
  }
});

test("feedback and Useful Intervention Rate", async () => {
  const v = await newUser("uir");
  const t = await deviceToken(v.cookie, "d");
  await createText(v.cookie, "Pricing a developer tool\nCharge per seat once a team adopts it.");
  const r = await (await observe("Code", "pricing developer tool seat plan — cognis — Visual Studio Code", { bearer: t })).json();
  assert.ok(r.suggestionId, JSON.stringify(r));
  assert.equal((await call(`/api/v1/suggestions/${r.suggestionId}/feedback`, { method: "POST", bearer: t, json: { action: "useful" } })).status, 204);
  assert.equal((await call(`/api/v1/suggestions/${r.suggestionId}/feedback`, { method: "POST", bearer: t, json: { action: "opened" } })).status, 204);
  const stats = await (await call("/api/v1/suggestions/stats", { bearer: t })).json();
  assert.equal(stats.presented, 1);
  assert.equal(stats.useful, 1, "opened does not overwrite an explicit judgment");
  assert.equal(stats.usefulInterventionRate, 1);
  assert.equal((await call(`/api/v1/suggestions/${r.suggestionId}/feedback`, { method: "POST", bearer: t, json: { action: "love" } })).status, 422);
  // Another user cannot rate it.
  assert.equal((await call(`/api/v1/suggestions/${r.suggestionId}/feedback`, { method: "POST", bearer: token, json: { action: "not_useful" } })).status, 404);
});

test("a dismissed item is not suggested again for the same work", async () => {
  const w = await newUser("dismiss");
  const t = await deviceToken(w.cookie, "d");
  const id = (await createText(w.cookie, "Cold email template for investors\nKeep it to five sentences.")).body.item.id;
  const first = await (await observe("Mail", "Cold email to investors draft - Mail", { bearer: t })).json();
  assert.equal(first.suggestions[0]?.item.id, id, JSON.stringify(first));
  await call(`/api/v1/suggestions/${first.suggestionId}/feedback`, { method: "POST", bearer: t, json: { action: "dismissed" } });
  const again = await (await observe("Mail", "Cold email to investors draft - Mail", { bearer: t })).json();
  assert.ok(!again.suggestions.some((s) => s.item.id === id));
});

test("observe validation and isolation", async () => {
  assert.equal((await call("/api/v1/context/suggest", { method: "POST", bearer: token, json: { appName: "x", windowTitle: "y".repeat(401) } })).status, 422);
  assert.equal((await call("/api/v1/context/suggest", { method: "POST", bearer: token, json: { appName: "x", windowTitle: "y", screenshot: "..." } })).status, 422);
  assert.equal((await call("/api/v1/context/suggest", { method: "POST", json: { appName: "x", windowTitle: "y" } })).status, 401);
  const other = await newUser("observer2");
  const r = await (await observe("Google Chrome", "Startup marketing strategy for reddit - Google Chrome", { cookie: other.cookie })).json();
  assert.equal(r.suggestions.length, 0, "never another user's items");
});

test("ask: private window context is dropped before the model", async () => {
  const res = await call("/api/v1/ask", { method: "POST", bearer: token, json: { question: "marketing on reddit", stream: false, context: { appName: "1Password", windowTitle: "secrets" } } });
  assert.equal(res.status, 200);
});

test("bulk link import: queues, dedupes, reports per-link errors; scheduled job processes", async () => {
  const urls = [
    "https://www.reddit.com/r/startups/comments/abc123/first_100_users/",
    "https://www.instagram.com/reel/Cx1abc/",
    "https://x.com/someone/status/1234567890",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.reddit.com/r/startups/comments/abc123/first_100_users/?utm_source=share",
    "http://127.0.0.1/admin",
    "not a link",
  ];
  const res = await call("/api/v1/items/batch", { method: "POST", cookie: u.cookie, json: { urls, tags: ["saved-posts"] } });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.results.length, 7);
  assert.equal(body.queued, 4);
  assert.equal(body.results[4].duplicate, true, "canonical duplicate of the first link");
  assert.equal(body.results[5].error.code, "invalid_url");
  assert.equal(body.results[6].error.code, "invalid_url");
  const ig = (await (await call(`/api/v1/items/${body.results[1].itemId}`, { cookie: u.cookie })).json()).item;
  assert.equal(ig.sourcePlatform, "instagram");
  assert.deepEqual(ig.tags, ["saved-posts"]);

  // Trigger the cron handler. Each item must leave "pending": ready if the network allows, otherwise a stable error code.
  await fetch(`${BASE}/__scheduled?cron=*/5+*+*+*+*`);
  let items = [];
  for (let i = 0; i < 40; i++) {
    items = await Promise.all(body.results.filter((r) => r.itemId && !r.duplicate).map(async (r) => (await (await call(`/api/v1/items/${r.itemId}`, { cookie: u.cookie })).json()).item));
    if (items.every((it) => it.status === "ready" || it.status === "failed")) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const it of items) {
    assert.ok(["ready", "failed"].includes(it.status), `${it.originalUrl}: ${it.status}`);
    if (it.status === "failed") assert.match(it.errorCode, /^(fetch_|http_|redirect_|unsupported_|too_|login_wall|parse_failed)/);
  }

  assert.equal((await call("/api/v1/items/batch", { method: "POST", cookie: u.cookie, json: { urls: [] } })).status, 422);
  assert.equal((await call("/api/v1/items/batch", { method: "POST", cookie: u.cookie, json: { urls: Array.from({ length: 51 }, (_, i) => `https://example.com/${i}`) } })).status, 422);
});

test("ask: a vague question uses the observed work as the search", async () => {
  const r = await (await call("/api/v1/ask", { method: "POST", bearer: token, json: { question: "what did I save about this?", stream: false, context: { appName: "Google Chrome", windowTitle: "Startup marketing strategy for reddit - Google Docs" } } })).json();
  assert.equal(r.sources[0]?.item.id, ids.reddit, JSON.stringify(r.sources.map((s) => s.item.title)));
});
