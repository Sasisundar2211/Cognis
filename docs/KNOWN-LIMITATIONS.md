# Known limitations

1. Not deployed. No production URL exists yet.
2. Workers Paid is required for sign-in: scrypt in WebAssembly costs about 250 ms CPU; the Free plan allows 10 ms.
3. No email in production until a domain is set up. No verification and no password reset until then.
4. The written-answer path of `/ask` has not run against the real model. Answer quality and citation accuracy are unmeasured.
5. Semantic search scans the newest 2,000 items per user. Older items are still found by words.
6. The semantic similarity floor (0.45) is not calibrated.
7. No retrieval evaluation harness yet.
8. Platform extraction has only been tested against documented formats, not live responses: this environment cannot reach those sites.
9. Instagram posts and reels need a Meta app token (`INSTAGRAM_OEMBED_TOKEN`); without it they usually fail with `login_wall`. LinkedIn posts often hit a login wall too.
10. Reels and videos keep captions, titles and descriptions only. Spoken audio is not transcribed, because that would mean downloading the video, which the platforms' terms do not allow.
11. Reddit share links (`/s/...`) and `redd.it` short links fall back to the page instead of the post JSON. Paste the full post link for comments.
12. Bulk import takes up to 50 links at a time. Importing a whole platform export file is not built yet.
13. Observe reads window titles only. Apps whose titles do not name the work (many chat and design tools) give it little to go on. It does not read window contents.
14. Observe on macOS needs the Screen Recording permission for window titles; on Linux Wayland titles may be unavailable. Global hotkeys may not register on some Wayland compositors.
15. Desktop installers are unsigned and show OS warnings.
16. If the OS keychain is unavailable, the companion forgets its sign-in when it quits.
17. No document upload, billing, or account-linked integrations (OAuth imports of all saved items).
18. Answers count against a daily limit per plan (Free: 30). Workers AI's free daily allocation is 10,000 neurons shared by all users; how many answers that covers has not been measured.
19. The TypeScript `worker/` folder is superseded and not maintained.
