//! Cognis desktop companion.
//!
//! Two ways it works beside you, both Grok-style:
//! - Ask: press the global hotkey from any app; a floating window appears; ask and get an answer
//!   from your saved knowledge, with sources. Esc hides it.
//! - Observe (opt-in): Cognis watches which app and window title is in front. When your work changes
//!   and a saved item is clearly relevant, a slim panel slides in at the edge of the screen.
//!
//! What Observe reads: the active window's app name and title. Nothing else. No screenshots, no
//! keystrokes, no clipboard, no window contents. Private windows (password managers, incognito)
//! are skipped on the device before anything is sent, and the server skips them again.

mod api;
mod observe;

use api::{parse_server, Api, ApiError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const KEYRING_SERVICE: &str = "app.cognis.desktop";
pub const HOTKEY: &str = "CommandOrControl+Shift+Space";

#[derive(Default)]
pub struct Inner {
    pub server: Option<String>,
    pub token: Option<String>,
    pub user: Option<Value>,
    pub paused: bool,
    pub observing: bool,
    /// Last non-private window in front, as (app, title). Kept in memory only.
    pub current: Option<(String, String)>,
    pub last_task: Option<Value>,
}

#[derive(Default)]
pub struct AppState(pub Mutex<Inner>);

#[derive(Serialize, Deserialize, Default)]
struct Config {
    server: Option<String>,
    #[serde(default)]
    observing: bool,
}

fn config_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

fn load_config(app: &AppHandle) -> Config {
    config_path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_config(app: &AppHandle) {
    let (server, observing) = {
        let s = app.state::<AppState>();
        let g = s.0.lock().unwrap();
        (g.server.clone(), g.observing)
    };
    if let Some(p) = config_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, serde_json::to_string_pretty(&Config { server, observing }).unwrap_or_default());
    }
}

fn keyring_entry(server: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, server).ok()
}

fn err(code: &str, message: &str) -> ApiError {
    ApiError { code: code.into(), message: message.into() }
}

pub fn creds(state: &AppState) -> Result<(Api, String), ApiError> {
    let s = state.0.lock().unwrap();
    match (&s.server, &s.token) {
        (Some(server), Some(token)) => Ok((Api::new(parse_server(server)?), token.clone())),
        _ => Err(err("signed_out", "Sign in to Cognis first.")),
    }
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ---------- commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    signed_in: bool,
    user: Option<Value>,
    server: Option<String>,
    paused: bool,
    observing: bool,
    /// What Cognis thinks you are working on, when observing. Shown so you can see and correct it.
    task: Option<Value>,
    hotkey: &'static str,
}

#[tauri::command]
fn status(state: State<AppState>) -> Status {
    let s = state.0.lock().unwrap();
    Status { signed_in: s.token.is_some(), user: s.user.clone(), server: s.server.clone(), paused: s.paused, observing: s.observing, task: if s.observing { s.last_task.clone() } else { None }, hotkey: HOTKEY }
}

#[tauri::command]
async fn sign_in(app: AppHandle, state: State<'_, AppState>, server: String, email: String, password: String) -> Result<Status, ApiError> {
    let base = parse_server(&server)?;
    let api = Api::new(base.clone());
    let host = std::env::var("HOSTNAME").or_else(|_| std::env::var("COMPUTERNAME")).unwrap_or_default();
    let device = if host.is_empty() { "Desktop companion".to_string() } else { format!("Desktop companion on {}", truncate(&host, 40)) };
    let (user, token) = api.sign_in(email.trim(), &password, &device).await?;
    let server_s = base.to_string();
    let stored = keyring_entry(&server_s).map(|e| e.set_password(&token).is_ok()).unwrap_or(false);
    {
        let mut s = state.0.lock().unwrap();
        s.server = Some(server_s);
        s.token = Some(token);
        s.user = Some(user);
    }
    save_config(&app);
    if !stored {
        let _ = app.emit("notice", "Your system keychain is unavailable, so you will need to sign in again next time.");
    }
    Ok(status(state))
}

#[tauri::command]
async fn sign_out(app: AppHandle, state: State<'_, AppState>) -> Result<Status, ApiError> {
    let (server, token) = {
        let mut s = state.0.lock().unwrap();
        s.user = None;
        s.observing = false;
        s.current = None;
        s.last_task = None;
        (s.server.clone(), s.token.take())
    };
    if let (Some(server), Some(token)) = (server, token) {
        if let Ok(base) = parse_server(&server) {
            Api::new(base).sign_out(&token).await;
        }
        if let Some(e) = keyring_entry(&server) {
            let _ = e.delete_credential();
        }
    }
    save_config(&app);
    observe::hide_panel(&app);
    Ok(status(state))
}

/// Turn Observe on or off. Off by default; the choice is remembered.
#[tauri::command]
fn set_observe(app: AppHandle, state: State<AppState>, on: bool) -> Status {
    {
        let mut s = state.0.lock().unwrap();
        s.observing = on && s.token.is_some();
        if !s.observing {
            s.current = None;
            s.last_task = None;
        }
    }
    save_config(&app);
    if !on {
        observe::hide_panel(&app);
    }
    let _ = app.emit("observing", on);
    refresh_tray(&app);
    status(state)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskArgs {
    question: String,
    history: Vec<Value>,
    /// Use what is in front of you (app and window title) as context for this question.
    #[serde(default = "yes")]
    use_context: bool,
}
fn yes() -> bool {
    true
}

#[tauri::command]
async fn ask(window: WebviewWindow, state: State<'_, AppState>, args: AskArgs) -> Result<(), ApiError> {
    let (api, token) = creds(&state)?;
    let current = {
        let s = state.0.lock().unwrap();
        if s.observing && args.use_context { s.current.clone() } else { None }
    };
    let mut body = json!({ "question": truncate(&args.question, 2000), "history": args.history.into_iter().rev().take(6).rev().collect::<Vec<_>>(), "stream": true });
    if let Some((app_name, title)) = current {
        body["context"] = json!({ "appName": app_name, "windowTitle": title });
    }
    api.ask(&token, &body, |ev, data| {
        let _ = window.emit("ask-event", json!({ "event": ev, "data": data }));
    })
    .await
}

/// Save typed text or a link (from "/save ..."). Never reads the clipboard.
#[tauri::command]
async fn save_text(state: State<'_, AppState>, text: String) -> Result<Value, ApiError> {
    let (api, token) = creds(&state)?;
    let t = text.trim();
    if t.is_empty() {
        return Err(err("empty", "Nothing to save."));
    }
    let links: Vec<&str> = t.split_whitespace().filter(|w| w.starts_with("https://") || w.starts_with("http://")).collect();
    if !links.is_empty() && links.len() == t.split_whitespace().count() {
        if links.len() == 1 {
            return api.post(&token, "/api/v1/items", &json!({ "kind": "url", "url": links[0] })).await;
        }
        return api.post(&token, "/api/v1/items/batch", &json!({ "urls": links.into_iter().take(50).collect::<Vec<_>>() })).await;
    }
    api.post(&token, "/api/v1/items", &json!({ "kind": "capture", "content": truncate(t, 100_000) })).await
}

#[tauri::command]
async fn feedback(state: State<'_, AppState>, suggestion_id: String, action: String) -> Result<(), ApiError> {
    let (api, token) = creds(&state)?;
    if !suggestion_id.starts_with("sug_") || suggestion_id.len() > 40 {
        return Err(err("invalid", "Unknown suggestion."));
    }
    api.post_empty(&token, &format!("/api/v1/suggestions/{suggestion_id}/feedback"), &json!({ "action": action })).await
}

/// Opens only http(s) links, in the default browser.
#[tauri::command]
fn open_link(app: AppHandle, url: String) -> Result<(), ApiError> {
    let u = url::Url::parse(&url).map_err(|_| err("invalid_url", "That link is not valid."))?;
    if u.scheme() != "https" && u.scheme() != "http" {
        return Err(err("invalid_url", "Only web links can be opened."));
    }
    app.opener().open_url(u.as_str(), None::<&str>).map_err(|_| err("open_failed", "Could not open the browser."))
}

#[tauri::command]
fn open_web_app(app: AppHandle, state: State<AppState>, item_id: Option<String>) -> Result<(), ApiError> {
    let server = state.0.lock().unwrap().server.clone().ok_or_else(|| err("signed_out", "Sign in first."))?;
    let path = match item_id.filter(|i| i.starts_with("ki_") && i.len() == 35 && i[3..].bytes().all(|b| b.is_ascii_hexdigit())) {
        Some(id) => format!("app/items/{id}"),
        None => "app".into(),
    };
    let u = parse_server(&server)?.join(&path).map_err(|_| err("invalid_server", "Bad server address."))?;
    app.opener().open_url(u.as_str(), None::<&str>).map_err(|_| err("open_failed", "Could not open the browser."))
}

/// From the beside panel: open the companion to ask about the current work.
#[tauri::command]
fn summon(app: AppHandle) {
    show_companion(&app);
}

// ---------- window, hotkey, tray ----------

pub fn show_companion(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("companion") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = w.emit("summoned", ());
    }
}

fn toggle(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("companion") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_companion(app);
        }
    }
}

fn set_paused(app: &AppHandle, paused: bool) {
    let state = app.state::<AppState>();
    state.0.lock().unwrap().paused = paused;
    if let Ok(sc) = HOTKEY.parse::<Shortcut>() {
        let gs = app.global_shortcut();
        let _ = if paused { gs.unregister(sc) } else { gs.register(sc) };
    }
    let _ = app.emit("paused", paused);
}

fn refresh_tray(app: &AppHandle) {
    let observing = app.state::<AppState>().0.lock().unwrap().observing;
    if let Some(tray) = app.tray_by_id("cognis") {
        let _ = tray.set_tooltip(Some(if observing { "Cognis: observing the window in front" } else { "Cognis" }));
    }
    if let Some(item) = app.try_state::<CheckMenuItem<tauri::Wry>>() {
        let _ = item.set_checked(observing);
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let cfg = load_config(&handle);
            if let Some(server) = cfg.server {
                let token = keyring_entry(&server).and_then(|e| e.get_password().ok());
                let mut s = app.state::<AppState>().inner().0.lock().unwrap();
                s.observing = cfg.observing && token.is_some();
                s.server = Some(server);
                s.token = token;
            }
            if let Ok(sc) = HOTKEY.parse::<Shortcut>() {
                let _ = app.global_shortcut().register(sc);
            }

            let show = MenuItem::with_id(app, "show", "Open Cognis", true, Some(HOTKEY))?;
            let observe_item = CheckMenuItem::with_id(app, "observe", "Observe what I'm working on", true, app.state::<AppState>().0.lock().unwrap().observing, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause hotkey", true, None::<&str>)?;
            let resume = MenuItem::with_id(app, "resume", "Resume hotkey", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Cognis", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show, &observe_item, &sep1, &pause, &resume, &sep2, &quit])?;
            app.manage(observe_item);
            let mut tray = TrayIconBuilder::with_id("cognis").tooltip("Cognis").menu(&menu).show_menu_on_left_click(true).on_menu_event(|app, e| match e.id.as_ref() {
                "show" => toggle(app),
                "observe" => {
                    let on = !app.state::<AppState>().0.lock().unwrap().observing;
                    let st = app.state::<AppState>();
                    let _ = set_observe(app.clone(), st, on);
                }
                "pause" => set_paused(app, true),
                "resume" => set_paused(app, false),
                "quit" => app.exit(0),
                _ => {}
            });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            refresh_tray(&handle);

            observe::start(handle.clone());

            if app.state::<AppState>().0.lock().unwrap().token.is_none() {
                show_companion(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![status, sign_in, sign_out, set_observe, ask, save_text, feedback, open_link, open_web_app, summon, observe::pending_suggestion])
        .run(tauri::generate_context!())
        .expect("error while running Cognis desktop");
}
