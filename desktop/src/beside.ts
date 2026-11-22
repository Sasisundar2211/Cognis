import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Item = { id: string; title: string; originalUrl: string | null; sourcePlatform: string; description: string; content: string; extractedText: string; createdAt: string };
type Suggestion = { state: string; suggestionId: string | null; task: { focus: string } | null; suggestions: { item: Item; reason: string }[] };

const $ = (id: string) => document.getElementById(id)!;
const win = getCurrentWindow();
const LABELS: Record<string, string> = { manual: "Note", browser: "Desktop", web: "Web", reddit: "Reddit", github: "GitHub", youtube: "YouTube", linkedin: "LinkedIn", x: "X", substack: "Substack", instagram: "Instagram", medium: "Medium" };
const AUTO_HIDE_MS = 25_000;

let current: Suggestion | null = null;
let timer: number | undefined;
let hovering = false;

function ago(iso: string) {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 31) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months} month${months === 1 ? "" : "s"} ago` : `${Math.round(months / 12)} year${months >= 24 ? "s" : ""} ago`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text; // text only, never HTML
  return e;
}

async function feedback(action: string) {
  if (!current?.suggestionId) return;
  try {
    await invoke("feedback", { suggestionId: current.suggestionId, action });
  } catch {
    /* feedback is best effort */
  }
}

function render(s: Suggestion) {
  current = s;
  $("why").textContent = s.task ? `For what you are working on: ${s.task.focus}` : "Related to what you are working on";
  const cards = $("cards");
  cards.replaceChildren(
    ...s.suggestions.map(({ item, reason }) => {
      const li = el("li", "card");
      const open = el("button", "card-open");
      open.type = "button";
      open.append(el("span", "card-meta", `${LABELS[item.sourcePlatform] ?? item.sourcePlatform} · saved ${ago(item.createdAt)}`), el("span", "card-title", item.title || "Untitled"));
      const preview = (item.description || item.content || item.extractedText).slice(0, 160);
      if (preview) open.append(el("span", "card-preview", preview));
      open.append(el("span", "card-why", reason));
      open.addEventListener("click", async () => {
        await feedback("opened");
        if (item.originalUrl) await invoke("open_link", { url: item.originalUrl }).catch(() => undefined);
        else await invoke("open_web_app", { itemId: item.id }).catch(() => undefined);
      });
      li.append(open);
      return li;
    }),
  );
  ($("useful") as HTMLButtonElement).disabled = false;
  ($("not-useful") as HTMLButtonElement).disabled = false;
  armTimer();
}

function armTimer() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (!hovering) void win.hide();
  }, AUTO_HIDE_MS);
}

document.body.addEventListener("mouseenter", () => (hovering = true));
document.body.addEventListener("mouseleave", () => {
  hovering = false;
  armTimer();
});

$("dismiss").addEventListener("click", async () => {
  await feedback("dismissed");
  await win.hide();
});
$("useful").addEventListener("click", async () => {
  await feedback("useful");
  ($("useful") as HTMLButtonElement).disabled = true;
  ($("not-useful") as HTMLButtonElement).disabled = true;
  window.setTimeout(() => void win.hide(), 600);
});
$("not-useful").addEventListener("click", async () => {
  await feedback("not_useful");
  await win.hide();
});
$("ask").addEventListener("click", async () => {
  await invoke("summon");
  await win.hide();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") void win.hide();
});

void listen<Suggestion>("suggestion", ({ payload }) => render(payload));
void invoke<Suggestion | null>("pending_suggestion").then((s) => s && render(s));
