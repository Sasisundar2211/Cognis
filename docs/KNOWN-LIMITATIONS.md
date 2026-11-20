# Known limitations

1. Not deployed. No production URL exists yet.
2. Free-plan CPU. Password hashing costs about 60 ms CPU. The Workers Free plan allows 10 ms. Sign-up and sign-in may fail on Free.
3. No email in production until a domain is set up. Without it, there is no email verification and no password reset.
4. Semantic search scans the newest 2,000 items per user. Older items are still found by word search.
5. Semantic similarity floor (0.45) is a starting value, not calibrated on real data.
6. No retrieval evaluation harness yet. Search quality is unmeasured with the real model.
7. URL import fetches pages server-side. Sites that require login (Instagram, LinkedIn, X posts) usually return a login wall or block the fetcher. Those items fail with a clear reason, or save with little text. The extension is the planned path for those sites.
8. No document upload (PDF, DOCX).
9. No browser extension, WorkContext, TaskContext, or context suggestions.
10. No platform integrations. Platform labels come from the URL hostname.
11. No billing. Every account is on the Free plan.
12. No durable job queue. URL processing runs after the response; if the Worker is evicted mid-fetch, the item stays in processing until a retry reclaims it after 5 minutes.
13. Export is a single JSON response. Very large libraries (tens of thousands of items) may hit response limits.
14. Audit events have no retention job.
15. No CI pipeline yet.
