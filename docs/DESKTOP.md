# Desktop companion

The Cognis desktop companion works beside you, the way Grok's desktop app does. It runs in the system tray.

- Ask: press Ctrl + Shift + Space (macOS: Cmd + Shift + Space) from any app. A floating window appears over your work. Ask, and Cognis answers from what you saved, with numbered sources. Esc hides it.
- Observe: turn on "Observe my work". Cognis watches which app and window title is in front of you. When your work changes and a saved item clearly fits it, a slim panel slides in at the right edge of the screen. It does not take focus, and it hides itself after 25 seconds unless you hover it.

Built with Tauri 2 (Rust core, system web view). Windows, macOS and Linux.

## Workflow

| You do | Cognis does |
|---|---|
| Turn on Observe (window checkbox or tray menu) | Shows "Working on: ..." so you can see what it understood |
| Work in another app for a few seconds | Reads that window's app name and title, finds related saved items, and decides: stay silent, keep a quiet hint, or show the panel |
| Click a card in the panel | Opens the original post or page |
| Click Useful / Not useful / ✕ | Records feedback; dismissed items are not suggested again for 7 days |
| Click "Ask about this", or press the hotkey | Opens the companion with your current work as context. "What did I save about this?" searches the work itself |
| Type `/save` with text | Saves a note |
| Type `/save` with one or many links | Imports the posts, reels or pages |
| Esc | Hides the window; the app keeps running in the tray |

## When the panel appears

The server's relevance gate decides, from evidence only:

- SILENT: the window says nothing about a task (new tab, desktop, a chat app's home), or nothing matches.
- PASSIVE: a weak match. Not shown; available if you open the companion.
- SUGGEST: words and meaning agree, or one signal is strong.
- HIGH_CONFIDENCE: both agree strongly.

Limits so it never becomes a notification machine: at most one panel per 90 seconds, 40 per day, the same item never twice in 30 minutes, and a window must stay in front for about 4 seconds before it counts.

## What Observe reads, and what it never reads

Reads: the app name and title of the window in front of you. That is all.

Never reads: screen pixels, window contents, keystrokes, the clipboard, the microphone or the camera.

Skipped on your device before anything is sent: password managers (1Password, Bitwarden, KeePass, LastPass, Dashlane, Keychain Access, Enpass, Proton Pass), private and incognito browser windows, lock screens, and Cognis itself. The server skips the same list again.

Stored on the server: which saved items were suggested, when, and your feedback. Window titles and app names are never stored or logged.

Off by default. Your choice is remembered. Turn it off any time from the window or the tray; the tray tooltip says "observing" while it is on.

## Sign-in and the device token

1. In the web app, open Account, Desktop companion, and press Create pairing code. Enter the server address (https://cognis.sasisundhar2211.workers.dev) and the 8-character code in the companion. The code works once and expires after 10 minutes.
2. The server returns a device token, kept in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service).
3. It shows in the web app under Account, Devices. Sign it out there to revoke it immediately.

Only `https://` servers are accepted, except `http://localhost` for development.

## Platform notes

- macOS: reading other apps' window titles requires the Screen Recording permission (System Settings, Privacy and Security). Without it, titles come back empty and Observe stays silent. Cognis does not capture the screen; macOS uses that permission for titles too.
- Linux X11: works. Apps that set only the legacy `WM_NAME` title are supported through a fallback.
- Linux Wayland: window titles are only available on some compositors. Observe may stay silent.
- Windows: works without extra permissions.

## Build

Requirements: Rust 1.80+, Node 22+, and the Tauri system dependencies (https://v2.tauri.app/start/prerequisites/). On Debian or Ubuntu:

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev
```

```sh
npm install            # repo root
cd desktop
npm run dev            # development against http://localhost:8787
npm run build          # installers in src-tauri/target/release/bundle/
```

Diagnostic: `cargo run --example active` in `desktop/src-tauri` prints what Observe would read for the window in front.

Installers are unsigned until code signing is set up.
