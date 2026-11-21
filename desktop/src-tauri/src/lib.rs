//! Cognis desktop companion.
//!
//! The Grok-style workflow: press a global hotkey from any app, a small always-on-top window
//! appears, you ask a question or save something, it answers from your saved knowledge with
//! sources, then gets out of the way (Esc or the hotkey again).
//!
//! Privacy rules enforced here:
//! - Nothing is captured in the background. No screenshots, keylogging, or window watching.
//! - The clipboard is read only when the user turns on "Include clipboard" or clicks "Save clipboard",
//!   and the UI shows exactly what will be sent before it is sent.
//! - The device token lives in the OS keychain and never enters the web view.

mod api;

use api::{parse_server, Api, ApiError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const KEYRING_SERVICE: &str = "app.cognis.desktop";
pub const HOTKEY: &str = "CommandOrControl+Shift+Space";
const CLIPBOARD_MAX: usize = 1500;

#[derive(Default)]
struct Inner {
    server: Option<String>,
    token: Option<String>,
    user: Option<Value>,
    paused: bool,
}

#[derive(Default)]
struct AppState(Mutex<Inner>);

#[derive(Serialize, Deserialize, Default)]
struct Config {
    server: Option<String>,
}

fn config_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

fn load_config(app: &AppHandle) -> Config {
    config_path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_config(app: &AppHandle, cfg: &Config) {
    if let Some(p) = config_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, serde_json::to_string_pretty(cfg).unwrap_or_default());
    }
}

fn keyring_entry(server: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, server).ok()
}

fn err(code: &str, message: &str) -> ApiError {
    ApiError { code: code.into(), message: message.into() }
}

fn creds(state: &State<AppState>) -> Result<(Api, String), ApiError> {
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
    hotkey: &'static str,
}

#[tauri::command]
fn status(state: State<AppState>) -> Status {
    let s = state.0.lock().unwrap();
    Status { signed_in: s.token.is_some(), user: s.user.clone(), server: s.server.clone(), paused: s.paused, hotkey: HOTKEY }
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
    save_config(&app, &Config { server: Some(server_s.clone()) });
    {
        let mut s = state.0.lock().unwrap();
        s.server = Some(server_s);
        s.token = Some(token);
        s.user = Some(user);
    }
    if !stored {
        // Still signed in for this run; the user will need to sign in again after restart.
        let _ = app.emit("notice", "Your system keychain is unavailable, so you will need to sign in again next time.");
    }
    Ok(status(state))
}

#[tauri::command]
async fn sign_out(state: State<'_, AppState>) -> Result<Status, ApiError> {
    let (server, token) = {
        let mut s = state.0.lock().unwrap();
        s.user = None;
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
    Ok(status(state))
}

/// Explicit, user-initiated read. The UI calls this only when the user turns on "Include clipboard"
/// or presses "Save clipboard", and shows the returned text before anything is sent.
#[tauri::command]
fn clipboard_preview(app: AppHandle) -> Option<String> {
    app.clipboard().read_text().ok().map(|t| truncate(t.trim(), CLIPBOARD_MAX)).filter(|t| !t.is_empty())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskArgs {
    question: String,
    /// The exact text the user saw in the preview and chose to share. Never read implicitly.
    shared_text: Option<String>,
    history: Vec<Value>,
}

#[tauri::command]
async fn ask(window: WebviewWindow, state: State<'_, AppState>, args: AskArgs) -> Result<(), ApiError> {
    let (api, token) = creds(&state)?;
    let mut body = json!({ "question": truncate(&args.question, 2000), "history": args.history.into_iter().rev().take(6).rev().collect::<Vec<_>>(), "stream": true });
    if let Some(t) = args.shared_text.filter(|t| !t.trim().is_empty()) {
        body["context"] = json!({ "selectedText": truncate(&t, CLIPBOARD_MAX), "appName": "Desktop companion" });
    }
    api.ask(&token, &body, |ev, data| {
        let _ = window.emit("ask-event", json!({ "event": ev, "data": data }));
    })
    .await
}

#[tauri::command]
async fn save_text(state: State<'_, AppState>, text: String, title: Option<String>) -> Result<Value, ApiError> {
    let (api, token) = creds(&state)?;
    let t = text.trim();
    if t.is_empty() {
        return Err(err("empty", "Nothing to save."));
    }
    let is_url = (t.starts_with("https://") || t.starts_with("http://")) && !t.contains(char::is_whitespace);
    let body = if is_url { json!({ "kind": "url", "url": t }) } else { json!({ "kind": "capture", "content": truncate(t, 100_000), "title": title }) };
    api.post(&token, "/api/v1/items", &body).await
}

#[tauri::command]
async fn search(state: State<'_, AppState>, q: String) -> Result<Value, ApiError> {
    let (api, token) = creds(&state)?;
    let q: String = url::form_urlencoded::byte_serialize(truncate(&q, 500).as_bytes()).collect();
    api.get(&token, &format!("/api/v1/search?q={q}&limit=8")).await
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
fn open_web_app(app: AppHandle, state: State<AppState>) -> Result<(), ApiError> {
    let server = state.0.lock().unwrap().server.clone().ok_or_else(|| err("signed_out", "Sign in first."))?;
    let u = parse_server(&server)?.join("app").map_err(|_| err("invalid_server", "Bad server address."))?;
    app.opener().open_url(u.as_str(), None::<&str>).map_err(|_| err("open_failed", "Could not open the browser."))
}

// ---------- window, hotkey, tray ----------

fn toggle(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("companion") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            let _ = w.emit("summoned", ());
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

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_clipboard_manager::init())
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
            // Restore server and device token from the last session.
            let cfg = load_config(&handle);
            if let Some(server) = cfg.server {
                let token = keyring_entry(&server).and_then(|e| e.get_password().ok());
                let mut s = app.state::<AppState>().inner().0.lock().unwrap();
                s.server = Some(server);
                s.token = token;
            }
            if let Ok(sc) = HOTKEY.parse::<Shortcut>() {
                let _ = app.global_shortcut().register(sc);
            }

            let show = MenuItem::with_id(app, "show", "Open Cognis", true, Some(HOTKEY))?;
            let pause = MenuItem::with_id(app, "pause", "Pause hotkey", true, None::<&str>)?;
            let resume = MenuItem::with_id(app, "resume", "Resume hotkey", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Cognis", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &pause, &resume, &PredefinedMenuItem::separator(app)?, &quit])?;
            let mut tray = TrayIconBuilder::with_id("cognis").tooltip("Cognis").menu(&menu).show_menu_on_left_click(true).on_menu_event(|app, e| match e.id.as_ref() {
                "show" => toggle(app),
                "pause" => set_paused(app, true),
                "resume" => set_paused(app, false),
                "quit" => app.exit(0),
                _ => {}
            });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Show the window on first launch so the user can sign in.
            if app.state::<AppState>().0.lock().unwrap().token.is_none() {
                toggle(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it; the companion keeps running in the tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![status, sign_in, sign_out, clipboard_preview, ask, save_text, search, open_link, open_web_app])
        .run(tauri::generate_context!())
        .expect("error while running Cognis desktop");
}
