# Known limitations

1. Not deployed. No production URL exists yet.
2. Workers Paid is required for sign-in: scrypt in WebAssembly costs about 250 ms CPU; the Free plan allows 10 ms.
3. No email in production until a domain is set up. No verification and no password reset until then.
4. The written-answer path of `/ask` has not run against the real model. Answer quality and citation accuracy are unmeasured.
5. Semantic search scans the newest 2,000 items per user. Older items are still found by words.
6. The semantic similarity floor (0.45) is not calibrated.
7. No retrieval evaluation harness yet.
8. Link import fetches pages server-side. Instagram, LinkedIn and X posts usually return a login wall. Copy the text and save it from the companion instead.
9. The desktop companion does not read selected text or the active app automatically. It uses the clipboard, with a preview, on explicit request.
10. Global hotkeys may not register on some Linux Wayland compositors.
11. Desktop installers are unsigned and show OS warnings.
12. If the OS keychain is unavailable, the companion forgets its sign-in when it quits.
13. No document upload, integrations, billing, proactive suggestions or durable job queue.
14. Answers count against a daily limit per plan (Free: 30). Workers AI's free daily allocation is 10,000 neurons shared by all users; how many answers that covers has not been measured.
15. The TypeScript `worker/` folder is superseded and not maintained.
