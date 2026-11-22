//! WorkContext -> TaskContext -> intervention decision. Pure and deterministic, so it is fully unit-tested.
//!
//! Input is what the desktop companion observes when the user has Observe turned on: the app name and
//! the window title of the app in front. Nothing else. The server never stores either value.

use serde::Serialize;

use crate::retrieval::rank::query_terms;

/// Words that appear in window titles but say nothing about the task.
const GENERIC: &[&str] = &[
    "untitled", "new", "tab", "home", "inbox", "dashboard", "google", "docs", "sheets", "slides", "chrome", "firefox", "safari", "edge",
    "brave", "arc", "opera", "mozilla", "microsoft", "word", "excel", "powerpoint", "visual", "studio", "code", "vscode", "cursor", "notion",
    "slack", "discord", "teams", "zoom", "figma", "terminal", "iterm", "iterm2", "bash", "zsh", "powershell", "explorer", "finder", "settings",
    "preferences", "window", "document", "file", "edit", "view", "page", "loading", "welcome", "start", "search", "results", "draft", "copy",
    "app", "desktop", "online", "free", "login", "sign", "signin", "pdf", "txt", "md", "rs", "ts", "js", "py", "html", "json", "com", "www",
    "https", "http", "gmail", "outlook", "mail", "unread", "notifications", "chat", "message", "messages", "meeting", "call", "youtube",
    "reddit", "linkedin", "twitter", "instagram", "facebook", "tiktok", "github", "pull", "request", "issue", "issues", "commit",
];

/// Apps and title patterns that are never analyzed, even with Observe on.
const PRIVATE_APPS: &[&str] = &["1password", "bitwarden", "keepass", "keepassxc", "lastpass", "dashlane", "keychain access", "enpass", "proton pass", "cognis"];
const PRIVATE_TITLES: &[&str] = &["private browsing", "incognito", "inprivate", "private window", "password", "lock screen", "screen lock"];

#[derive(Debug, Serialize, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskContext {
    /// Best human-readable phrase for the current work, e.g. "Startup social media marketing plan".
    pub focus: String,
    pub keywords: Vec<String>,
    /// 0.0 to 1.0. How much the title says about the task. Not a probability.
    pub confidence: f32,
}

pub fn is_private(app: &str, title: &str) -> bool {
    let a = app.to_lowercase();
    let t = title.to_lowercase();
    PRIVATE_APPS.iter().any(|p| a.contains(p)) || PRIVATE_TITLES.iter().any(|p| t.contains(p))
}

/// Split a window title into segments and keep the ones about the work, not the app.
pub fn extract_task(app: &str, title: &str) -> Option<TaskContext> {
    if is_private(app, title) {
        return None;
    }
    let app_l = app.to_lowercase();
    // Remove unread counters like "(3)" and "[12]" at the start.
    let mut t = title.trim();
    while let Some(rest) = t.strip_prefix('(').or_else(|| t.strip_prefix('[')) {
        match rest.find([')', ']']) {
            Some(i) if rest[..i].chars().all(|c| c.is_ascii_digit() || c == '+') => t = rest[i + 1..].trim_start(),
            _ => break,
        }
    }
    let mut parts: Vec<String> = vec![];
    for seg in title_segments(t) {
        let sl = seg.to_lowercase();
        if sl.is_empty() || (!app_l.is_empty() && (sl == app_l || app_l.contains(&sl))) {
            continue;
        }
        let informative = query_terms(&seg).into_iter().filter(|w| !GENERIC.contains(&w.as_str()) && w.chars().count() > 2 && !w.chars().all(|c| c.is_ascii_digit())).count();
        if informative > 0 {
            parts.push(seg);
        }
    }
    let focus = parts.first()?.clone();
    let mut keywords: Vec<String> = vec![];
    for p in &parts {
        for w in query_terms(p) {
            if !GENERIC.contains(&w.as_str()) && w.chars().count() > 2 && !w.chars().all(|c| c.is_ascii_digit()) && !keywords.contains(&w) {
                keywords.push(w);
            }
        }
    }
    keywords.truncate(8);
    if keywords.is_empty() {
        return None;
    }
    let confidence = match keywords.len() {
        1 => 0.3,
        2 => 0.5,
        3 => 0.65,
        _ => 0.8,
    };
    Some(TaskContext { focus: focus.chars().take(120).collect(), keywords, confidence })
}

fn title_segments(t: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let chars: Vec<char> = t.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let sep = matches!(c, '|' | '\u{2014}' | '\u{2013}' | '\u{00B7}' | '\u{2022}') || (c == '-' && i > 0 && i + 1 < chars.len() && chars[i - 1] == ' ' && chars[i + 1] == ' ');
        if sep {
            out.push(String::new());
        } else {
            out.last_mut().unwrap().push(c);
        }
        i += 1;
    }
    out.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

#[derive(Debug, Serialize, PartialEq, Clone, Copy, PartialOrd)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum State {
    Silent,
    Passive,
    Suggest,
    HighConfidence,
}

/// Evidence about the best candidate, from retrieval.
pub struct Evidence {
    pub lexical: bool,
    pub matched_terms: usize,
    pub similarity: Option<f32>,
    pub min_similarity: f32,
}

/// The relevance gate. A suggestion interrupts the user, so it must be earned:
/// - SILENT: nothing usable (no task, or no candidate).
/// - PASSIVE: weak signal; shown only if the user opens the panel.
/// - SUGGEST: two independent signals agree, or one signal is strong.
/// - HIGH_CONFIDENCE: both retrievers agree and the match is strong.
pub fn gate(task: Option<&TaskContext>, best: Option<&Evidence>) -> State {
    let (Some(task), Some(e)) = (task, best) else { return State::Silent };
    let sem = e.similarity.unwrap_or(0.0);
    let strong_sem = e.similarity.is_some() && sem >= e.min_similarity + 0.2;
    let good_sem = e.similarity.is_some() && sem >= e.min_similarity + 0.1;
    let strong_lex = e.lexical && e.matched_terms >= 2;
    let both = e.lexical && e.similarity.is_some();
    let state = if both && (strong_lex || strong_sem) {
        State::HighConfidence
    } else if both || strong_lex || good_sem {
        State::Suggest
    } else {
        State::Passive
    };
    // A vague task cannot justify more than a quiet hint.
    if task.confidence < 0.5 && state > State::Passive {
        return if state == State::HighConfidence { State::Suggest } else { State::Passive };
    }
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_task_from_common_titles() {
        let t = extract_task("Google Chrome", "Startup social media marketing plan - Google Docs - Google Chrome").unwrap();
        assert_eq!(t.focus, "Startup social media marketing plan");
        assert_eq!(t.keywords, ["startup", "social", "media", "marketing", "plan"]);
        assert!(t.confidence >= 0.8);

        let t = extract_task("Code", "pricing.rs — cognis — Visual Studio Code").unwrap();
        assert!(t.keywords.contains(&"pricing".to_string()), "{t:?}");

        let t = extract_task("Slack", "(3) #growth | Acme - Slack").unwrap();
        assert_eq!(t.keywords, ["growth", "acme"]);

        let t = extract_task("Firefox", "How to price a developer tool | Substack — Mozilla Firefox").unwrap();
        assert_eq!(t.focus, "How to price a developer tool");
    }

    #[test]
    fn nothing_to_say_is_none() {
        assert!(extract_task("Google Chrome", "New Tab - Google Chrome").is_none());
        assert!(extract_task("Finder", "Desktop").is_none());
        assert!(extract_task("Slack", "Slack").is_none());
        assert!(extract_task("", "").is_none());
    }

    #[test]
    fn private_contexts_are_never_analyzed() {
        assert!(extract_task("1Password 8", "Bank login - 1Password").is_none());
        assert!(extract_task("Firefox", "Marketing plan — Mozilla Firefox Private Browsing").is_none());
        assert!(extract_task("Google Chrome", "Pricing strategy - Google Chrome (Incognito)").is_none());
        assert!(extract_task("Cognis", "Cognis").is_none());
    }

    fn ev(lexical: bool, matched: usize, sim: Option<f32>) -> Evidence {
        Evidence { lexical, matched_terms: matched, similarity: sim, min_similarity: 0.45 }
    }
    fn task(c: f32) -> TaskContext {
        TaskContext { focus: "x".into(), keywords: vec!["x".into()], confidence: c }
    }

    #[test]
    fn gate_states() {
        let t = task(0.8);
        assert_eq!(gate(None, Some(&ev(true, 3, Some(0.9)))), State::Silent);
        assert_eq!(gate(Some(&t), None), State::Silent);
        assert_eq!(gate(Some(&t), Some(&ev(true, 1, None))), State::Passive);
        assert_eq!(gate(Some(&t), Some(&ev(false, 0, Some(0.5)))), State::Passive);
        assert_eq!(gate(Some(&t), Some(&ev(true, 2, None))), State::Suggest);
        assert_eq!(gate(Some(&t), Some(&ev(false, 0, Some(0.56)))), State::Suggest);
        assert_eq!(gate(Some(&t), Some(&ev(true, 1, Some(0.5)))), State::Suggest);
        assert_eq!(gate(Some(&t), Some(&ev(true, 2, Some(0.5)))), State::HighConfidence);
        assert_eq!(gate(Some(&t), Some(&ev(true, 1, Some(0.7)))), State::HighConfidence);
    }

    #[test]
    fn vague_tasks_are_damped() {
        let vague = task(0.3);
        assert_eq!(gate(Some(&vague), Some(&ev(true, 2, None))), State::Passive);
        assert_eq!(gate(Some(&vague), Some(&ev(true, 2, Some(0.7)))), State::Suggest);
    }
}
