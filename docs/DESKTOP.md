# Desktop companion

The Cognis desktop companion stays with you on your desktop, the way Grok's desktop app does. It runs in the system tray. Press the hotkey from any app and a small always-on-top window appears. Ask a question and Cognis answers from what you saved, with numbered sources. Press Esc or the hotkey again and it goes away.

Built with Tauri 2 (Rust core, system web view). Windows, macOS and Linux.

## Workflow

| You do | Cognis does |
|---|---|
| Press Ctrl + Shift + Space (macOS: Cmd + Shift + Space) | Shows the window over your current app and focuses the input |
| Type a question, press Enter | Searches your library, then streams an answer with [n] citations |
| Click a citation or source | Opens the original link in your browser |
| Turn on "Include clipboard" | Shows the clipboard text it will send, then sends it with that one question |
| Click "Save clipboard" | Shows the text, saves it after you confirm |
| Type `/save some text` or `/save https://...` | Saves a note or a link |
| Ask a follow-up | Keeps the last 6 turns as conversation context |
| Press New | Clears the conversation |
| Press Esc | Hides the window. The app keeps running in the tray |
| Tray menu, Pause hotkey | Unregisters the hotkey until you resume |

## What it never does

- No background capture: no screenshots, keylogging, window watching, microphone or camera.
- No clipboard reads unless you click one of the two clipboard controls, and you see the text first.
- No direct network access from the web view. The Rust core makes every request.
- No password storage. Signing in exchanges your password once for a device token.

## Sign-in and the device token

1. Enter your server address (for example `https://cognis.<you>.workers.dev`), email and password.
2. The server returns a device token. The companion stores it in the operating system keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service).
3. The token appears in the web app under Account, Devices, as "Desktop companion on <computer name>". Sign it out there to revoke it immediately.
4. Signing out in the companion revokes the token on the server and deletes it from the keychain.

Only `https://` servers are accepted, except `http://localhost` for development.

## Build

Requirements: Rust 1.80+, Node 22+, and the Tauri system dependencies for your OS (https://v2.tauri.app/start/prerequisites/). On Debian or Ubuntu:

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev
```

Then:

```sh
npm install                       # from the repo root
cd desktop
npm run dev                       # development, with the local API on http://localhost:8787
npm run build                     # installers in src-tauri/target/release/bundle/
```

Installers are unsigned. macOS Gatekeeper and Windows SmartScreen will warn on first launch until code signing is set up (Apple Developer Program: $99/year; Windows code signing certificates vary).

## Known limitations

- The companion does not read the active app's name or selected text automatically. Copy the text and use "Include clipboard". Reading selections from other apps needs OS accessibility permissions; it is planned as an opt-in setting.
- On Linux Wayland sessions, global hotkeys depend on the compositor and may not register. X11 works.
- If the system keychain is unavailable (some minimal Linux setups), you stay signed in only until the app quits.
- Answers need Workers AI. On local development servers, the companion shows matching sources without a written answer.
