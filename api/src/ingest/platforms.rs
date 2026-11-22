//! Turn a saved post or reel link into knowledge, using each platform's official public route.
//!
//! | Platform  | Route                                                     | What we get                         |
//! |-----------|-----------------------------------------------------------|-------------------------------------|
//! | Reddit    | `<post>.json` (public JSON)                               | title, body, subreddit, top comments |
//! | X         | publish.twitter.com/oembed                                | post text, author                   |
//! | YouTube   | youtube.com/oembed + watch page meta                      | title, channel, description         |
//! | TikTok    | tiktok.com/oembed                                         | caption, author                     |
//! | Instagram | graph.facebook.com instagram_oembed (needs a Meta app token) | caption, author                  |
//! | GitHub    | api.github.com/repos/{o}/{r}/readme                       | README text                         |
//! | Others    | the page itself (LinkedIn, Substack, Medium, blogs)       | title, description, readable text   |
//!
//! Nothing here logs in, bypasses a login wall, or downloads media. When a platform only returns
//! a login wall, the item fails with `login_wall` so the user knows to save the text another way.

use base64::Engine;
use serde_json::{json, Value};
use url::Url;

use super::extract::{extract_html, extract_plain, Extracted, MAX_EXTRACTED_CHARS};
use super::fetch::{safe_fetch, safe_fetch_json, PageFetcher};
use super::url_safety::detect_platform;
use crate::util::normalize_text;

#[derive(Debug, PartialEq)]
pub enum Route {
    Reddit { json: Url },
    OEmbed { endpoint: Url, platform: &'static str, page_too: bool },
    GitHubReadme { api: Url, repo: String },
    Page,
}

fn oembed(base: &str, target: &Url, extra: &[(&str, &str)]) -> Url {
    let mut u = Url::parse(base).expect("static oembed base");
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("url", target.as_str());
        for (k, v) in extra {
            q.append_pair(k, v);
        }
    }
    u
}

/// Pick the official route for a link. Pure: no network.
pub fn route(url: &Url, instagram_token: Option<&str>) -> Route {
    let path = url.path();
    match detect_platform(url) {
        "reddit" if path.contains("/comments/") => {
            let mut j = url.clone();
            j.set_query(Some("raw_json=1&limit=8&sort=top"));
            j.set_fragment(None);
            let p = format!("{}.json", path.trim_end_matches('/'));
            j.set_path(&p);
            Route::Reddit { json: j }
        }
        "x" if path.contains("/status/") => Route::OEmbed { endpoint: oembed("https://publish.twitter.com/oembed", url, &[("omit_script", "1"), ("dnt", "true")]), platform: "x", page_too: false },
        "youtube" => Route::OEmbed { endpoint: oembed("https://www.youtube.com/oembed", url, &[("format", "json")]), platform: "youtube", page_too: true },
        "instagram" if instagram_token.is_some() && (path.starts_with("/p/") || path.starts_with("/reel/") || path.starts_with("/reels/") || path.starts_with("/tv/")) => {
            Route::OEmbed { endpoint: oembed("https://graph.facebook.com/v21.0/instagram_oembed", url, &[("access_token", instagram_token.unwrap_or("")), ("omitscript", "true")]), platform: "instagram", page_too: false }
        }
        _ if url.host_str().map(|h| h.trim_start_matches("www.") == "tiktok.com").unwrap_or(false) && path.contains("/video/") => {
            Route::OEmbed { endpoint: oembed("https://www.tiktok.com/oembed", url, &[]), platform: "tiktok", page_too: false }
        }
        "github" => {
            let segs: Vec<&str> = path.trim_matches('/').split('/').filter(|s| !s.is_empty()).collect();
            match segs.as_slice() {
                [owner, repo] | [owner, repo, "tree", ..] | [owner, repo, "blob", ..] if !["orgs", "topics", "settings", "marketplace"].contains(owner) => {
                    let repo = repo.trim_end_matches(".git");
                    Route::GitHubReadme { api: Url::parse(&format!("https://api.github.com/repos/{owner}/{repo}/readme")).expect("valid"), repo: format!("{owner}/{repo}") }
                }
                _ => Route::Page,
            }
        }
        _ => Route::Page,
    }
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Reddit post JSON: `[post_listing, comments_listing]`.
pub fn parse_reddit(v: &Value) -> Option<Extracted> {
    let post = v.get(0)?.pointer("/data/children/0/data")?;
    let title = s(post, "title");
    if title.is_empty() {
        return None;
    }
    let mut text = s(post, "selftext");
    let comments: Vec<String> = v
        .get(1)
        .and_then(|c| c.pointer("/data/children"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|c| c.get("kind").and_then(Value::as_str) == Some("t1"))
                .filter_map(|c| c.pointer("/data/body").and_then(Value::as_str))
                .filter(|b| !b.is_empty() && *b != "[deleted]" && *b != "[removed]")
                .take(5)
                .map(|b| b.chars().take(800).collect())
                .collect()
        })
        .unwrap_or_default();
    if !comments.is_empty() {
        text.push_str("\n\nTop comments:\n");
        for c in comments {
            text.push_str(&format!("- {c}\n"));
        }
    }
    let link = s(post, "url");
    if !link.is_empty() && !link.contains("reddit.com") && !link.contains("redd.it") {
        text.push_str(&format!("\nLinked: {link}"));
    }
    Some(Extracted {
        title: normalize_text(&title, 300),
        description: normalize_text(&format!("{} post by u/{}", s(post, "subreddit_name_prefixed"), s(post, "author")), 1000),
        site_name: "Reddit".into(),
        text: normalize_text(&text, MAX_EXTRACTED_CHARS),
    })
}

/// oEmbed JSON (X, YouTube, TikTok, Instagram). Post text lives in `title` (TikTok) or in the `html` blockquote (X, Instagram).
pub fn parse_oembed(v: &Value, platform: &str) -> Option<Extracted> {
    let author = s(v, "author_name");
    let html = s(v, "html");
    let title = s(v, "title");
    let (title, text) = match platform {
        "x" | "instagram" => {
            // X: the post text is the first <p> of the embed; the rest is attribution.
            // Instagram: drop the embed's boilerplate lines.
            let body = if platform == "x" {
                let p = html.find("<p").and_then(|a| html[a..].find("</p>").map(|b| &html[a..a + b + 4])).unwrap_or(&html);
                extract_html(p).text
            } else {
                extract_html(&html).text.lines().filter(|l| { let l = l.trim(); !l.is_empty() && !l.starts_with("View this post on Instagram") && !l.starts_with("A post shared by") }).collect::<Vec<_>>().join("\n")
            };
            let body = body.trim().to_string();
            let first = body.lines().next().unwrap_or("").chars().take(120).collect::<String>();
            (if first.is_empty() { format!("Post by {author}") } else { first }, body)
        }
        _ => (title.clone(), title),
    };
    if title.trim().is_empty() && text.trim().is_empty() {
        return None;
    }
    Some(Extracted {
        title: normalize_text(&title, 300),
        description: normalize_text(&if author.is_empty() { String::new() } else { format!("By {author} on {}", s(v, "provider_name")) }, 1000),
        site_name: s(v, "provider_name"),
        text: normalize_text(&text, MAX_EXTRACTED_CHARS),
    })
}

/// GitHub `GET /repos/{o}/{r}/readme` JSON: base64 content.
pub fn parse_github_readme(v: &Value, repo: &str) -> Option<Extracted> {
    let raw = s(v, "content").replace('\n', "");
    let bytes = base64::engine::general_purpose::STANDARD.decode(raw).ok()?;
    let md = String::from_utf8_lossy(&bytes);
    let ex = extract_plain(&md);
    Some(Extracted { title: repo.to_string(), description: format!("GitHub repository {repo}"), site_name: "GitHub".into(), text: ex.text })
}

/// A page that only asks the visitor to sign in carries no knowledge.
pub fn is_login_wall(ex: &Extracted) -> bool {
    let t = ex.title.to_lowercase();
    let wall_title = ["log in", "login", "sign in", "sign up", "join linkedin", "instagram", "x.com"].iter().any(|w| t == *w || t.starts_with(&format!("{w} ")) || t.ends_with(&format!(" {w}")) || t.contains(&format!("{w} •")) || t.contains(&format!("• {w}")));
    let thin = ex.text.chars().count() < 400 && ex.description.chars().count() < 40;
    let mentions = { let x = ex.text.to_lowercase(); x.contains("log in") || x.contains("sign in") || x.contains("create an account") };
    (wall_title && thin) || (thin && mentions && ex.text.chars().count() < 200)
}

pub struct LinkKnowledge {
    pub ex: Extracted,
    pub final_url: Url,
    pub meta: Value,
}

/// Fetch and extract knowledge from a saved link. Errors are stable codes.
pub async fn extract_link<F: PageFetcher>(fetcher: &F, url: Url, instagram_token: Option<&str>) -> Result<LinkKnowledge, String> {
    let platform = detect_platform(&url);
    match route(&url, instagram_token) {
        Route::Reddit { json } => {
            let page = safe_fetch_json(fetcher, json).await?;
            let v: Value = serde_json::from_str(&page.body).map_err(|_| "parse_failed".to_string())?;
            let ex = parse_reddit(&v).ok_or("parse_failed")?;
            Ok(LinkKnowledge { ex, final_url: url, meta: json!({ "via": "reddit_json" }) })
        }
        Route::GitHubReadme { api, repo } => match safe_fetch_json(fetcher, api).await {
            Ok(page) => {
                let v: Value = serde_json::from_str(&page.body).map_err(|_| "parse_failed".to_string())?;
                let ex = parse_github_readme(&v, &repo).ok_or("parse_failed")?;
                Ok(LinkKnowledge { ex, final_url: url, meta: json!({ "via": "github_api" }) })
            }
            Err(_) => page_knowledge(fetcher, url, platform).await,
        },
        Route::OEmbed { endpoint, platform: p, page_too } => {
            let o = safe_fetch_json(fetcher, endpoint).await.ok().and_then(|page| serde_json::from_str::<Value>(&page.body).ok()).and_then(|v| parse_oembed(&v, p));
            match (o, page_too) {
                (Some(mut ex), true) => {
                    // YouTube: oEmbed has title and channel; the watch page meta has the description.
                    if let Ok(pk) = page_knowledge(fetcher, url.clone(), platform).await {
                        if !pk.ex.description.is_empty() {
                            ex.text = normalize_text(&format!("{}\n\n{}", ex.text, pk.ex.description), MAX_EXTRACTED_CHARS);
                        }
                    }
                    Ok(LinkKnowledge { ex, final_url: url, meta: json!({ "via": "oembed" }) })
                }
                (Some(ex), false) => Ok(LinkKnowledge { ex, final_url: url, meta: json!({ "via": "oembed" }) }),
                (None, _) => page_knowledge(fetcher, url, platform).await,
            }
        }
        Route::Page => page_knowledge(fetcher, url, platform).await,
    }
}

async fn page_knowledge<F: PageFetcher>(fetcher: &F, url: Url, platform: &str) -> Result<LinkKnowledge, String> {
    let page = safe_fetch(fetcher, url).await?;
    let ex = if page.content_type == "text/plain" { extract_plain(&page.body) } else { extract_html(&page.body) };
    let social = matches!(platform, "instagram" | "linkedin" | "x" | "reddit");
    if social && is_login_wall(&ex) {
        return Err("login_wall".into());
    }
    let mut meta = json!({ "via": "page", "contentType": page.content_type });
    if !ex.site_name.is_empty() {
        meta["siteName"] = json!(ex.site_name);
    }
    Ok(LinkKnowledge { ex, final_url: page.final_url, meta })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::fetch::RawResponse;
    use std::cell::RefCell;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn routes() {
        match route(&u("https://www.reddit.com/r/startups/comments/abc123/launch_tips/?utm_source=share"), None) {
            Route::Reddit { json } => assert_eq!(json.as_str(), "https://www.reddit.com/r/startups/comments/abc123/launch_tips.json?raw_json=1&limit=8&sort=top"),
            r => panic!("{r:?}"),
        }
        assert_eq!(route(&u("https://www.reddit.com/r/startups/"), None), Route::Page);
        assert!(matches!(route(&u("https://x.com/user/status/123"), None), Route::OEmbed { platform: "x", .. }));
        assert!(matches!(route(&u("https://youtu.be/abc"), None), Route::OEmbed { platform: "youtube", page_too: true, .. }));
        assert!(matches!(route(&u("https://www.tiktok.com/@a/video/1"), None), Route::OEmbed { platform: "tiktok", .. }));
        assert_eq!(route(&u("https://www.instagram.com/reel/Cx1/"), None), Route::Page, "no token: page fallback");
        assert!(matches!(route(&u("https://www.instagram.com/reel/Cx1/"), Some("tok")), Route::OEmbed { platform: "instagram", .. }));
        match route(&u("https://github.com/rust-lang/rust.git"), None) {
            Route::GitHubReadme { api, repo } => {
                assert_eq!(api.as_str(), "https://api.github.com/repos/rust-lang/rust/readme");
                assert_eq!(repo, "rust-lang/rust");
            }
            r => panic!("{r:?}"),
        }
        assert_eq!(route(&u("https://github.com/orgs/x"), None), Route::Page);
        assert_eq!(route(&u("https://www.linkedin.com/posts/someone_activity-1"), None), Route::Page);
    }

    #[test]
    fn parses_reddit_post_and_top_comments() {
        let v = json!([
            { "data": { "children": [{ "kind": "t3", "data": { "title": "How we got our first 100 users", "selftext": "Posted in niche subreddits.", "subreddit_name_prefixed": "r/startups", "author": "founder", "url": "https://www.reddit.com/r/startups/comments/abc/" } }] } },
            { "data": { "children": [
                { "kind": "t1", "data": { "body": "Answer questions first." } },
                { "kind": "t1", "data": { "body": "[deleted]" } },
                { "kind": "more", "data": {} }
            ] } }
        ]);
        let ex = parse_reddit(&v).unwrap();
        assert_eq!(ex.title, "How we got our first 100 users");
        assert_eq!(ex.description, "r/startups post by u/founder");
        assert!(ex.text.contains("Posted in niche subreddits.") && ex.text.contains("- Answer questions first."));
        assert!(!ex.text.contains("[deleted]"));
        assert!(parse_reddit(&json!({})).is_none());
    }

    #[test]
    fn parses_oembeds() {
        let x = json!({ "author_name": "Jane", "provider_name": "Twitter", "html": "<blockquote class=\"twitter-tweet\"><p lang=\"en\">Positioning: say who it is for in one sentence.</p>&mdash; Jane (@jane) <a href=\"https://x.com/jane/status/1\">May 1</a></blockquote><script>evil()</script>" });
        let ex = parse_oembed(&x, "x").unwrap();
        assert_eq!(ex.title, "Positioning: say who it is for in one sentence.");
        assert!(!ex.text.contains("evil"));
        assert_eq!(ex.description, "By Jane on Twitter");
        let tt = json!({ "title": "3 hooks that doubled my views #marketing", "author_name": "creator", "provider_name": "TikTok" });
        assert_eq!(parse_oembed(&tt, "tiktok").unwrap().text, "3 hooks that doubled my views #marketing");
        assert!(parse_oembed(&json!({}), "tiktok").is_none());
    }

    #[test]
    fn parses_github_readme() {
        let v = json!({ "content": base64::engine::general_purpose::STANDARD.encode("# Tool\n\nFast search.\n") });
        let ex = parse_github_readme(&v, "o/r").unwrap();
        assert_eq!(ex.title, "o/r");
        assert!(ex.text.contains("Fast search."));
    }

    #[test]
    fn detects_login_walls_but_not_real_pages() {
        let wall = Extracted { title: "Instagram".into(), text: "Log in to see photos and videos from friends.".into(), ..Default::default() };
        assert!(is_login_wall(&wall));
        let li = Extracted { title: "Sign Up | LinkedIn".into(), text: "Join now. Sign in.".into(), ..Default::default() };
        assert!(is_login_wall(&li));
        let real = Extracted { title: "Audience building on Instagram".into(), description: "A long guide about growing an audience with reels and carousels.".into(), text: "x".repeat(2000), ..Default::default() };
        assert!(!is_login_wall(&real));
    }

    struct Mock(RefCell<Vec<String>>, fn(&Url) -> RawResponse);
    impl PageFetcher for Mock {
        async fn get(&self, url: &Url, _max: usize) -> Result<RawResponse, String> {
            self.0.borrow_mut().push(url.as_str().to_string());
            Ok((self.1)(url))
        }
    }
    fn ok(ct: &str, body: &str) -> RawResponse {
        RawResponse { status: 200, location: None, content_type: ct.into(), content_length: None, body: body.as_bytes().to_vec() }
    }

    #[test]
    fn end_to_end_with_mock_network() {
        let m = Mock(RefCell::new(vec![]), |u| {
            if u.host_str() == Some("publish.twitter.com") {
                ok("application/json", r#"{"author_name":"Jane","provider_name":"Twitter","html":"<blockquote><p>Ship weekly.</p></blockquote>"}"#)
            } else {
                ok("text/html", "<title>Log in</title>")
            }
        });
        let k = futures::executor::block_on(extract_link(&m, u("https://x.com/jane/status/1"), None)).unwrap();
        assert_eq!(k.ex.title, "Ship weekly.");
        assert_eq!(m.0.borrow().len(), 1, "one official request, no page scrape");

        let wall = Mock(RefCell::new(vec![]), |_| ok("text/html", "<html><head><title>Instagram</title></head><body>Log in to see this post.</body></html>"));
        let e = futures::executor::block_on(extract_link(&wall, u("https://www.instagram.com/reel/Cx1/"), None)).err().unwrap();
        assert_eq!(e, "login_wall");

        let reddit_fail = Mock(RefCell::new(vec![]), |_| RawResponse { status: 429, ..ok("application/json", "") });
        assert_eq!(futures::executor::block_on(extract_link(&reddit_fail, u("https://reddit.com/r/a/comments/b/c"), None)).err().unwrap(), "http_429");
    }
}
