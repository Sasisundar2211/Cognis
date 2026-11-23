//! URL validation and canonicalization for user-submitted links (SSRF defense in depth).

use url::{Host, Url};

const MAX_URL_LENGTH: usize = 2048;
const BLOCKED_SUFFIXES: [&str; 11] = [
    ".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet", ".arpa", ".invalid", ".test", ".onion",
];

fn is_tracking_param(k: &str) -> bool {
    let k = k.to_ascii_lowercase();
    k.starts_with("utm_")
        || matches!(
            k.as_str(),
            "fbclid" | "gclid" | "dclid" | "msclkid" | "mc_cid" | "mc_eid" | "igshid" | "ref_src" | "_hsenc" | "_hsmi" | "yclid"
        )
}

const PRIVATE_V4: [([u8; 4], u8); 15] = [
    ([0, 0, 0, 0], 8), ([10, 0, 0, 0], 8), ([100, 64, 0, 0], 10), ([127, 0, 0, 0], 8), ([169, 254, 0, 0], 16),
    ([172, 16, 0, 0], 12), ([192, 0, 0, 0], 24), ([192, 0, 2, 0], 24), ([192, 88, 99, 0], 24), ([192, 168, 0, 0], 16),
    ([198, 18, 0, 0], 15), ([198, 51, 100, 0], 24), ([203, 0, 113, 0], 24), ([224, 0, 0, 0], 4), ([240, 0, 0, 0], 4),
];

fn is_private_v4(ip: std::net::Ipv4Addr) -> bool {
    let v = u32::from(ip);
    PRIVATE_V4.iter().any(|(base, bits)| {
        let mask = if *bits == 0 { 0 } else { u32::MAX << (32 - bits) };
        (v & mask) == (u32::from_be_bytes(*base) & mask)
    })
}

/// Validate a URL for server-side fetching. Returns a stable reason code on rejection.
/// The WHATWG URL parser normalizes decimal, octal and hex IPv4 hosts, so they are caught as IPv4.
pub fn assert_fetchable(raw: &str) -> Result<Url, &'static str> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_URL_LENGTH {
        return Err("invalid_url");
    }
    let url = Url::parse(raw).map_err(|_| "invalid_url")?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("unsupported_scheme");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials_in_url");
    }
    if url.port().is_some() {
        return Err("non_default_port");
    }
    match url.host() {
        None => Err("invalid_url"),
        Some(Host::Ipv6(_)) => Err("ip_literal"),
        Some(Host::Ipv4(ip)) => Err(if is_private_v4(ip) { "private_address" } else { "ip_literal" }),
        Some(Host::Domain(d)) => {
            let host = d.trim_end_matches('.').to_ascii_lowercase();
            if !host.contains('.') {
                return Err("single_label_host");
            }
            if host == "localhost" || BLOCKED_SUFFIXES.iter().any(|s| host.ends_with(s)) {
                return Err("internal_host");
            }
            if !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
                return Err("invalid_host");
            }
            Ok(url)
        }
    }
}

/// Canonical form for duplicate detection. Drops fragment, `www.`, tracking params and trailing slashes; sorts the query.
pub fn canonicalize(url: &Url) -> String {
    let mut u = url.clone();
    u.set_fragment(None);
    if let Some(h) = u.host_str().map(|h| h.to_ascii_lowercase()) {
        let h = h.strip_prefix("www.").unwrap_or(&h).to_string();
        let _ = u.set_host(Some(&h));
    }
    let mut kept: Vec<(String, String)> = u.query_pairs().filter(|(k, _)| !is_tracking_param(k)).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    kept.sort_by(|a, b| a.0.cmp(&b.0));
    if kept.is_empty() {
        u.set_query(None);
    } else {
        u.query_pairs_mut().clear().extend_pairs(kept.iter());
    }
    let path = u.path().to_string();
    if path.len() > 1 && path.ends_with('/') {
        let trimmed = path.trim_end_matches('/');
        u.set_path(if trimmed.is_empty() { "/" } else { trimmed });
    }
    u.to_string()
}

/// Best-effort platform label from the hostname. Used for filtering, never for trust decisions.
pub fn detect_platform(url: &Url) -> &'static str {
    let h = url.host_str().unwrap_or("").to_ascii_lowercase();
    let h = h.strip_prefix("www.").unwrap_or(&h);
    let is = |d: &str| h == d || h.ends_with(&format!(".{d}"));
    if is("reddit.com") {
        "reddit"
    } else if is("github.com") {
        "github"
    } else if is("youtube.com") || is("youtu.be") {
        "youtube"
    } else if is("linkedin.com") {
        "linkedin"
    } else if is("x.com") || is("twitter.com") {
        "x"
    } else if is("substack.com") {
        "substack"
    } else if is("instagram.com") {
        "instagram"
    } else if is("medium.com") {
        "medium"
    } else if is("tiktok.com") {
        "tiktok"
    } else {
        "web"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(u: &str) -> Option<&'static str> {
        assert_fetchable(u).err()
    }

    #[test]
    fn ssrf_matrix() {
        let long = format!("https://{}.com", "a".repeat(3000));
        let cases: &[(&str, Option<&str>)] = &[
            ("http://localhost/", Some("single_label_host")),
            ("http://localhost./", Some("single_label_host")),
            ("http://foo.localhost/", Some("internal_host")),
            ("http://127.0.0.1/", Some("private_address")),
            ("http://2130706433/", Some("private_address")),
            ("http://0x7f.0.0.1/", Some("private_address")),
            ("http://0177.0.0.1/", Some("private_address")),
            ("http://10.1.2.3/", Some("private_address")),
            ("http://172.16.0.1/", Some("private_address")),
            ("http://192.168.1.1/", Some("private_address")),
            ("http://169.254.169.254/", Some("private_address")),
            ("http://100.64.0.1/", Some("private_address")),
            ("http://0.0.0.0/", Some("private_address")),
            ("http://8.8.8.8/", Some("ip_literal")),
            ("http://[::1]/", Some("ip_literal")),
            ("http://[::ffff:127.0.0.1]/", Some("ip_literal")),
            ("http://user:pw@example.com/", Some("credentials_in_url")),
            ("http://example.com:8080/", Some("non_default_port")),
            ("https://example.com:443/", None),
            ("ftp://example.com/", Some("unsupported_scheme")),
            ("file:///etc/passwd", Some("unsupported_scheme")),
            ("javascript:alert(1)", Some("unsupported_scheme")),
            ("data:text/html,hi", Some("unsupported_scheme")),
            ("http://metadata.google.internal/", Some("internal_host")),
            ("http://printer.local/", Some("internal_host")),
            ("https://site.invalid/", Some("internal_host")),
            ("not a url", Some("invalid_url")),
            (&long, Some("invalid_url")),
            ("https://example.com/path?q=1", None),
            ("https://sub.example.co.uk/", None),
        ];
        for (u, want) in cases {
            assert_eq!(reason(u), *want, "{u}");
        }
    }

    #[test]
    fn canonical_forms() {
        let c = |s: &str| canonicalize(&Url::parse(s).unwrap());
        assert_eq!(c("https://WWW.Example.com/a/?utm_source=x&b=2&a=1#frag"), "https://example.com/a?a=1&b=2");
        assert_eq!(c("https://example.com/a"), c("https://www.example.com/a/"));
        assert_ne!(c("https://example.com/a?id=1"), c("https://example.com/a?id=2"));
    }

    #[test]
    fn platform_labels() {
        let p = |s: &str| detect_platform(&Url::parse(s).unwrap());
        assert_eq!(p("https://old.reddit.com/r/x"), "reddit");
        assert_eq!(p("https://youtu.be/abc"), "youtube");
        assert_eq!(p("https://notreddit.com/"), "web");
        assert_eq!(p("https://reddit.com.evil.io/"), "web");
    }
}
