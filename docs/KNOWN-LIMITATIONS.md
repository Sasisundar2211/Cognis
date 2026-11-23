# Known limitations

1. Hosted on Cloudflare's free plan: 100,000 requests per day, 10 ms CPU per request, 10,000 Workers AI neurons per day shared by all users. A short answer used about 5 neurons in production. Above the limits, requests fail until the next day unless you move to Workers Paid ($5/month).
2. Cloudflare is a proprietary service with a free tier. The code, models (Mistral Small 3.1, bge-small-en-v1.5) and libraries are open source, and the open-source workerd runtime can host the API yourself.
3. No email. Lose every passkey and every recovery code and the account cannot be recovered.
4. Passkeys need a browser and device that support WebAuthn (current Chrome, Edge, Safari, Firefox; Windows Hello, Touch ID, Android, iOS, or a security key).
5. Answer quality and citation accuracy are spot-checked only, not measured.
6. Semantic search scans the newest 2,000 items per user. Older items are still found by words.
7. The semantic similarity floor (0.45) is not calibrated. No retrieval evaluation harness yet.
8. Reddit blocks Cloudflare servers (HTTP 403). Reddit links save the title and author through oEmbed, without the post body or comments.
9. TikTok gives Cloudflare servers no readable text. TikTok links fail with `no_content`; add a note with what the video said.
10. Instagram posts and reels need a Meta app token (`INSTAGRAM_OEMBED_TOKEN`); without it they fail with `login_wall`. LinkedIn posts often hit a login wall too.
11. Reels and videos keep captions, titles and descriptions only. Spoken audio is not transcribed, because that would mean downloading the video, which the platforms' terms do not allow.
12. Bulk import takes up to 50 links at a time. Importing a whole platform export file is not built yet.
13. Observe reads window titles only. Apps whose titles do not name the work give it little to go on.
14. Observe on macOS needs the Screen Recording permission for window titles; on Linux Wayland titles may be unavailable. Global hotkeys may not register on some Wayland compositors.
15. The desktop app has run on Linux only. Not run on macOS or Windows. Installers are unsigned and show OS warnings.
16. If the OS keychain is unavailable, the companion forgets its sign-in when it quits.
17. No document upload, billing, or account-linked integrations (OAuth imports of all saved items).
18. Answers count against a daily limit per plan (Free: 30).
19. The TypeScript `worker/` folder is superseded and not maintained.
