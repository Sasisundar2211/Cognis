//! Observe mode: read the active window's app name and title, and ask Cognis whether a saved item
//! is relevant to it. Opt-in, visible in the tray, and limited to those two strings.
//!
//! Debounce: a window must stay in front for two consecutive ticks (about 4 seconds) before it
//! counts, and the same window is never sent twice in a row. At most one request per 6 seconds.

use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::AppState;

const TICK: Duration = Duration::from_secs(2);
const MIN_GAP: Duration = Duration::from_secs(6);
const PANEL_W: f64 = 340.0;
const PANEL_H: f64 = 440.0;

/// Mirrors the server's list. Checked here first so private titles never leave the device.
const PRIVATE_APPS: &[&str] = &["1password", "bitwarden", "keepass", "keepassxc", "lastpass", "dashlane", "keychain access", "enpass", "proton pass", "cognis"];
const PRIVATE_TITLES: &[&str] = &["private browsing", "incognito", "inprivate", "private window", "password", "lock screen", "screen lock"];

pub fn is_private(app: &str, title: &str) -> bool {
    let a = app.to_lowercase();
    let t = title.to_lowercase();
    PRIVATE_APPS.iter().any(|p| a.contains(p)) || PRIVATE_TITLES.iter().any(|p| t.contains(p))
}

/// Debounce state machine, separated so it can be unit-tested.
#[derive(Default)]
pub struct Debounce {
    candidate: Option<(String, String)>,
    seen: u8,
    last_sent: Option<(String, String)>,
    last_sent_at: Option<Instant>,
}

impl Debounce {
    /// Feed the window in front; returns Some(window) when it should be sent now.
    pub fn feed(&mut self, w: Option<(String, String)>, now: Instant) -> Option<(String, String)> {
        let Some(w) = w else {
            self.candidate = None;
            self.seen = 0;
            return None;
        };
        if self.candidate.as_ref() != Some(&w) {
            self.candidate = Some(w);
            self.seen = 1;
            return None;
        }
        self.seen = self.seen.saturating_add(1);
        if self.seen < 2 || self.last_sent.as_ref() == Some(&w) {
            return None;
        }
        if self.last_sent_at.map(|t| now.duration_since(t) < MIN_GAP).unwrap_or(false) {
            return None;
        }
        self.last_sent = Some(w.clone());
        self.last_sent_at = Some(now);
        Some(w)
    }
}

enum Front {
    /// One of Cognis's own windows (companion or panel). Keeps the previous work context.
    Own,
    Other(Option<(String, String)>),
}

fn front() -> Front {
    match active_win_pos_rs::get_active_window() {
        Ok(w) if w.process_id == std::process::id() as u64 => Front::Own,
        _ => Front::Other(active_window()),
    }
}

fn active_window() -> Option<(String, String)> {
    let w = active_win_pos_rs::get_active_window().ok()?;
    let app: String = w.app_name.chars().take(120).collect();
    let mut title: String = w.title.chars().take(400).collect();
    #[cfg(target_os = "linux")]
    if title.trim().is_empty() {
        title = legacy_wm_name(&w.window_id).unwrap_or_default().chars().take(400).collect();
    }
    if title.trim().is_empty() {
        return None;
    }
    Some((app, title))
}

/// Some X11 apps set only the legacy Latin-1 WM_NAME, which the active-window crate does not read.
#[cfg(target_os = "linux")]
fn legacy_wm_name(window_id: &str) -> Option<String> {
    use x11rb::connection::Connection as _;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _};
    let win: u32 = window_id.parse().ok()?;
    let (conn, _) = x11rb::connect(None).ok()?;
    let reply = conn.get_property(false, win, AtomEnum::WM_NAME, AtomEnum::ANY, 0, 256).ok()?.reply().ok()?;
    let _ = conn.flush();
    if reply.value.is_empty() {
        return None;
    }
    // STRING is Latin-1; every byte maps to the same Unicode code point.
    Some(reply.value.iter().map(|&b| b as char).collect())
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut d = Debounce::default();
        loop {
            tokio::time::sleep(TICK).await;
            let observing = {
                let s = app.state::<AppState>();
                let g = s.0.lock().unwrap();
                g.observing && g.token.is_some()
            };
            if !observing {
                d = Debounce::default();
                continue;
            }
            let w = match front() {
                // Summoning Cognis must not erase what you were working on.
                Front::Own => continue,
                Front::Other(w) => w.filter(|(a, t)| !is_private(a, t)),
            };
            {
                let s = app.state::<AppState>();
                s.0.lock().unwrap().current = w.clone();
            }
            let Some((app_name, title)) = d.feed(w, Instant::now()) else { continue };
            let Ok((api, token)) = crate::creds(&app.state::<AppState>()) else { continue };
            let res = api.post(&token, "/api/v1/context/suggest", &json!({ "appName": app_name, "windowTitle": title })).await;
            let Ok(v) = res else { continue };
            {
                let s = app.state::<AppState>();
                s.0.lock().unwrap().last_task = v.get("task").cloned().filter(|t| !t.is_null());
            }
            let _ = app.emit("context", &v);
            let state = v.get("state").and_then(Value::as_str).unwrap_or("SILENT");
            if state == "SUGGEST" || state == "HIGH_CONFIDENCE" {
                show_panel(&app, v);
            }
        }
    });
}

#[tauri::command]
pub fn pending_suggestion(app: AppHandle) -> Option<Value> {
    app.try_state::<Pending>().and_then(|p| p.0.lock().unwrap().clone())
}

pub struct Pending(pub std::sync::Mutex<Option<Value>>);

/// Show the slim suggestion panel at the right edge of the primary screen, without taking focus.
pub fn show_panel(app: &AppHandle, suggestion: Value) {
    if app.try_state::<Pending>().is_none() {
        app.manage(Pending(std::sync::Mutex::new(None)));
    }
    *app.state::<Pending>().0.lock().unwrap() = Some(suggestion.clone());

    let win = match app.get_webview_window("beside") {
        Some(w) => w,
        None => match WebviewWindowBuilder::new(app, "beside", WebviewUrl::App("beside.html".into()))
            .title("Cognis suggestion")
            .inner_size(PANEL_W, PANEL_H)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .visible(false)
            .build()
        {
            Ok(w) => w,
            Err(_) => return,
        },
    };
    if let Ok(Some(m)) = win.primary_monitor() {
        let scale = m.scale_factor();
        let size = m.size();
        let pos = m.position();
        let x = pos.x as f64 + size.width as f64 - (PANEL_W + 16.0) * scale;
        let y = pos.y as f64 + 72.0 * scale;
        let _ = win.set_position(tauri::PhysicalPosition::new(x.max(0.0) as i32, y as i32));
    }
    let _ = win.show();
    let _ = win.emit("suggestion", &suggestion);
}

pub fn hide_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("beside") {
        let _ = w.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(a: &str, t: &str) -> Option<(String, String)> {
        Some((a.into(), t.into()))
    }

    #[test]
    fn debounce_requires_stability_and_no_repeats() {
        let mut d = Debounce::default();
        let t0 = Instant::now();
        assert_eq!(d.feed(w("Docs", "Plan"), t0), None, "first sighting");
        assert_eq!(d.feed(w("Docs", "Plan"), t0 + TICK), w("Docs", "Plan"), "stable: send");
        assert_eq!(d.feed(w("Docs", "Plan"), t0 + TICK * 2), None, "same window not resent");
        assert_eq!(d.feed(w("Mail", "Inbox"), t0 + TICK * 3), None);
        assert_eq!(d.feed(w("Mail", "Inbox"), t0 + TICK * 3 + Duration::from_secs(1)), None, "too soon after last send");
        assert_eq!(d.feed(w("Mail", "Inbox"), t0 + TICK * 6), w("Mail", "Inbox"));
        assert_eq!(d.feed(None, t0 + TICK * 7), None);
        assert_eq!(d.feed(w("Docs", "Plan"), t0 + TICK * 8), None);
        assert_eq!(d.feed(w("Docs", "Plan"), t0 + TICK * 9), w("Docs", "Plan"), "back to an earlier window counts again");
    }

    #[test]
    fn quick_switching_sends_nothing() {
        let mut d = Debounce::default();
        let t0 = Instant::now();
        for i in 0..10u32 {
            assert_eq!(d.feed(w("App", &format!("T{i}")), t0 + TICK * i), None);
        }
    }

    #[test]
    fn private_windows_are_skipped_on_device() {
        assert!(is_private("1Password 8", "Vault"));
        assert!(is_private("firefox", "Plan — Mozilla Firefox Private Browsing"));
        assert!(is_private("Google Chrome", "Docs (Incognito)"));
        assert!(!is_private("Google Chrome", "Marketing plan - Google Docs"));
    }
}
