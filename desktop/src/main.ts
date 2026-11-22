import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Status = { signedIn: boolean; user: { email: string } | null; server: string | null; paused: boolean; observing: boolean; task: { focus: string; keywords: string[] } | null; hotkey: string };
type Item = { id: string; title: string; originalUrl: string | null; sourcePlatform: string; createdAt: string };
type Source = { n: number; item: Item; reason: string };
type Turn = { role: "user" | "assistant"; content: string };
type ApiErr = { code: string; message: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // text only, never HTML
  return e;
};
const errMsg = (e: unknown) => (typeof e === "object" && e && "message" in e ? String((e as ApiErr).message) : "Something went wrong.");
const hotkeyLabel = (h: string) => h.replace("CommandOrControl", navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl").replaceAll("+", " + ");

const LABELS: Record<string, string> = { manual: "Note", browser: "Desktop", web: "Web", reddit: "Reddit", github: "GitHub", youtube: "YouTube", linkedin: "LinkedIn", x: "X", substack: "Substack", instagram: "Instagram", medium: "Medium" };
const label = (p: string) => LABELS[p] ?? p;

const win = getCurrentWindow();
let history: Turn[] = [];
let busy = false;

async function render() {
  const s = await invoke<Status>("status");
  $("signin").hidden = s.signedIn;
  $("chat").hidden = !s.signedIn;
  $("bar-actions").hidden = !s.signedIn;
  $("hotkey-hint").textContent = s.paused ? "Hotkey paused" : `${hotkeyLabel(s.hotkey)} to summon`;
  if (!s.signedIn) {
    if (s.server) $<HTMLInputElement>("server").value = s.server;
    ($<HTMLInputElement>(s.server ? "email" : "server")).focus();
  } else {
    showWorking(s);
    $<HTMLTextAreaElement>("q").focus();
  }
}

function notice(text: string, error = false) {
  const n = $("notice");
  n.textContent = text;
  n.classList.toggle("err", error);
  n.hidden = false;
  window.setTimeout(() => (n.hidden = true), 5000);
}

// ---------- sign in ----------

$("signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $<HTMLButtonElement>("signin-btn");
  const errEl = $("signin-error");
  errEl.hidden = true;
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    await invoke("sign_in", { server: $<HTMLInputElement>("server").value, email: $<HTMLInputElement>("email").value, password: $<HTMLInputElement>("password").value });
    $<HTMLInputElement>("password").value = "";
    await render();
  } catch (err) {
    errEl.textContent = errMsg(err);
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

$("sign-out").addEventListener("click", async () => {
  await invoke("sign_out");
  resetThread();
  await render();
});
$("open-web").addEventListener("click", () => invoke("open_web_app", { itemId: null }).catch((e) => notice(errMsg(e), true)));
$("new-chat").addEventListener("click", () => {
  resetThread();
  $<HTMLTextAreaElement>("q").focus();
});
$("hide").addEventListener("click", () => win.hide());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") void win.hide();
});

function resetThread() {
  history = [];
  const t = $("thread");
  t.replaceChildren($("empty") ?? el("div"));
  $("empty").hidden = false;
}

// ---------- observe ----------

const observeBox = $<HTMLInputElement>("observe");
observeBox.addEventListener("change", async () => {
  const st = await invoke<Status>("set_observe", { on: observeBox.checked });
  showWorking(st);
});

function showWorking(s: Status) {
  observeBox.checked = s.observing;
  const w = $("working");
  if (s.observing && s.task?.focus) {
    w.textContent = `Working on: ${s.task.focus}`;
    w.hidden = false;
  } else if (s.observing) {
    w.textContent = "Watching the window in front";
    w.hidden = false;
  } else {
    w.hidden = true;
  }
}

void listen<{ state: string; task: { focus: string } | null }>("context", async () => showWorking(await invoke<Status>("status")));

// ---------- asking ----------

const q = $<HTMLTextAreaElement>("q");
q.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $<HTMLFormElement>("composer").requestSubmit();
  }
});

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = q.value.trim();
  if (!text || busy) return;
  if (text.startsWith("/save ")) {
    q.value = "";
    try {
      const r = await invoke<{ item?: Item; duplicate?: boolean; queued?: number }>("save_text", { text: text.slice(6) });
      if (r.queued !== undefined) notice(`Importing ${r.queued} link${r.queued === 1 ? "" : "s"}. They appear in your library as they finish.`);
      else notice(r.duplicate ? "Already in your library." : `Saved "${r.item?.title || "your note"}".`);
    } catch (err) {
      notice(errMsg(err), true);
    }
    return;
  }
  q.value = "";
  await askQuestion(text);
});

let current: { answer: HTMLElement; steps: HTMLElement; sources: Source[]; text: string; wrap: HTMLElement } | null = null;

function step(label: string, live: boolean) {
  if (!current) return;
  current.steps.querySelectorAll(".step.live").forEach((s) => s.classList.replace("live", "done"));
  const s = el("span", `step ${live ? "live" : "done"}`, label);
  current.steps.append(s);
}

/** Render answer text, turning [n] into buttons that open source n. Text nodes only. */
function renderAnswer() {
  if (!current) return;
  const parts = current.text.split(/(\[\d{1,2}\])/g);
  current.answer.replaceChildren(
    ...parts.map((p) => {
      const m = p.match(/^\[(\d{1,2})\]$/);
      const src = m ? current!.sources.find((s) => s.n === Number(m[1])) : undefined;
      if (!src) return document.createTextNode(p);
      const b = el("button", "cite", String(src.n));
      b.type = "button";
      b.title = src.item.title;
      b.addEventListener("click", () => openSource(src));
      return b;
    }),
  );
}

function openSource(s: Source) {
  if (s.item.originalUrl) void invoke("open_link", { url: s.item.originalUrl }).catch((e) => notice(errMsg(e), true));
  else void invoke("open_web_app", { itemId: s.item.id }).catch(() => undefined);
}

function renderSources(list: Source[]) {
  if (!current || list.length === 0) return;
  const ul = el("ul", "sources");
  ul.setAttribute("aria-label", "Sources from your library");
  for (const s of list) {
    const li = el("li", "source");
    li.append(el("span", "cite n", String(s.n)));
    const b = el("button", "link t", s.item.title || "Untitled");
    b.type = "button";
    b.title = s.reason;
    b.addEventListener("click", () => openSource(s));
    li.append(b, el("span", "meta", label(s.item.sourcePlatform)));
    ul.append(li);
  }
  current.wrap.append(ul);
}

async function askQuestion(question: string) {
  busy = true;
  $<HTMLButtonElement>("ask-btn").disabled = true;
  $("empty").hidden = true;
  const thread = $("thread");
  thread.append(el("div", "msg-user", question));
  const wrap = el("div", "msg-ai");
  const steps = el("div", "steps");
  const answer = el("div", "answer");
  wrap.append(steps, answer);
  thread.append(wrap);
  current = { answer, steps, sources: [], text: "", wrap };
  step("Searching your library", true);
  thread.scrollTop = thread.scrollHeight;

  try {
    await invoke("ask", { args: { question, history, useContext: true } });
  } catch (e) {
    step("Stopped", false);
    answer.textContent = errMsg(e);
    answer.classList.add("error");
  } finally {
    history.push({ role: "user", content: question });
    if (current?.text) history.push({ role: "assistant", content: current.text });
    current = null;
    busy = false;
    $<HTMLButtonElement>("ask-btn").disabled = false;
    q.focus();
  }
}

void listen<{ event: string; data: Record<string, unknown> }>("ask-event", ({ payload }) => {
  if (!current) return;
  const { event, data } = payload;
  if (event === "sources") {
    current.sources = (data.sources as Source[]) ?? [];
    step(current.sources.length ? `Read ${current.sources.length} saved item${current.sources.length === 1 ? "" : "s"}` : "Nothing saved matches", false);
  } else if (event === "status" && data.step === "writing") {
    step("Writing", true);
  } else if (event === "delta") {
    current.text += String(data.text ?? "");
    renderAnswer();
  } else if (event === "done") {
    step("Done", false);
    if (!current.text && data.note) current.answer.append(el("p", "note", String(data.note)));
    renderSources(current.sources);
  }
  const t = $("thread");
  t.scrollTop = t.scrollHeight;
});

void listen("summoned", () => void render());
void listen<boolean>("paused", () => void render());
void listen<string>("notice", ({ payload }) => notice(payload, true));

void render();
