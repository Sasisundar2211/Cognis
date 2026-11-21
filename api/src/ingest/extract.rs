//! Readable text and metadata from HTML via lol_html (the engine behind Cloudflare's HTMLRewriter).
//! Output is plain text only; markup, scripts and attributes are discarded.

use lol_html::{doc_text, element, text, RewriteStrSettings};
use std::cell::RefCell;
use std::rc::Rc;

use crate::util::normalize_text;

pub const MAX_EXTRACTED_CHARS: usize = 50_000;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Extracted {
    pub title: String,
    pub description: String,
    pub site_name: String,
    pub text: String,
}

const SKIP: &str = "head, script, style, noscript, svg, template, iframe, nav, footer, header, form, aside, button, select";
const BLOCK: &str = "p, div, li, h1, h2, h3, h4, h5, h6, br, tr, section, article, blockquote, pre";

#[derive(Default)]
struct State {
    title: String,
    og_title: String,
    description: String,
    og_description: String,
    site_name: String,
    skip_depth: i32,
    in_title: bool,
    parts: String,
}

pub fn extract_html(html: &str) -> Extracted {
    let st = Rc::new(RefCell::new(State::default()));
    let (s1, s2, s3, s4, s5, s6) = (st.clone(), st.clone(), st.clone(), st.clone(), st.clone(), st.clone());

    let settings = RewriteStrSettings::new()
        .append_element_content_handler(
            element!("title", move |el| {
                s1.borrow_mut().in_title = true;
                let s = s1.clone();
                let on_end: lol_html::EndTagHandler<'static> = Box::new(move |_| {
                    s.borrow_mut().in_title = false;
                    Ok(())
                });
                if let Some(h) = el.end_tag_handlers() {
                    h.push(on_end);
                }
                Ok(())
            }),
        )
        .append_element_content_handler(
            text!("title", move |t| {
                let mut s = s2.borrow_mut();
                if s.in_title && s.title.len() < 500 {
                    s.title.push_str(t.as_str());
                }
                Ok(())
            }),
        )
        .append_element_content_handler(
            element!("meta", move |el| {
                let name = el.get_attribute("name").or_else(|| el.get_attribute("property")).unwrap_or_default().to_ascii_lowercase();
                let content = el.get_attribute("content").unwrap_or_default();
                let mut s = s3.borrow_mut();
                match name.as_str() {
                    "description" if s.description.is_empty() => s.description = content,
                    "og:description" if s.og_description.is_empty() => s.og_description = content,
                    "og:title" if s.og_title.is_empty() => s.og_title = content,
                    "og:site_name" if s.site_name.is_empty() => s.site_name = content,
                    _ => {}
                }
                Ok(())
            }),
        )
        .append_element_content_handler(
            element!(SKIP, move |el| {
                s4.borrow_mut().skip_depth += 1;
                let s = s4.clone();
                let on_end: lol_html::EndTagHandler<'static> = Box::new(move |_| {
                    s.borrow_mut().skip_depth -= 1;
                    Ok(())
                });
                match el.end_tag_handlers() {
                    Some(h) => h.push(on_end),
                    None => s4.borrow_mut().skip_depth -= 1, // void element
                }
                Ok(())
            }),
        )
        .append_element_content_handler(
            element!(BLOCK, move |_| {
                let mut s = s5.borrow_mut();
                if s.skip_depth == 0 {
                    s.parts.push('\n');
                }
                Ok(())
            }),
        )
        // Document-level text handler works even when the page omits <html>/<body>.
        .append_document_content_handler(doc_text!(move |t| {
            let mut s = s6.borrow_mut();
            if s.skip_depth > 0 || s.in_title || s.parts.len() > MAX_EXTRACTED_CHARS * 4 {
                return Ok(());
            }
            s.parts.push_str(t.as_str());
            Ok(())
        }));

    if lol_html::rewrite_str(html, settings).is_err() {
        return Extracted::default();
    }
    let s = st.borrow();
    Extracted {
        title: normalize_text(&decode_entities(if s.og_title.is_empty() { &s.title } else { &s.og_title }), 300),
        description: normalize_text(&decode_entities(if s.og_description.is_empty() { &s.description } else { &s.og_description }), 1000),
        site_name: normalize_text(&decode_entities(&s.site_name), 100),
        text: normalize_text(&decode_entities(&s.parts), MAX_EXTRACTED_CHARS),
    }
}

pub fn extract_plain(body: &str) -> Extracted {
    let text = normalize_text(body, MAX_EXTRACTED_CHARS);
    let title = text.lines().next().unwrap_or("").chars().take(200).collect();
    Extracted { title, text, ..Default::default() }
}

/// Decode the HTML entities lol_html leaves in text chunks. Result stays plain text.
pub fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let end = tail[1..].find(';').map(|e| e + 1).filter(|e| *e <= 10);
        let decoded = end.and_then(|e| {
            let ent = &tail[1..e];
            let lower = ent.to_ascii_lowercase();
            let named = match lower.as_str() {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                _ => None,
            };
            let ch = named.or_else(|| {
                let code = if let Some(h) = lower.strip_prefix("#x") {
                    u32::from_str_radix(h, 16).ok()
                } else if let Some(d) = lower.strip_prefix('#') {
                    d.parse::<u32>().ok()
                } else {
                    None
                }?;
                if code < 32 {
                    return None;
                }
                char::from_u32(code)
            })?;
            Some((ch, e))
        });
        match decoded {
            Some((ch, e)) => {
                out.push(ch);
                rest = &tail[e + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_readable_text_and_drops_the_rest() {
        let ex = extract_html(
            r#"<!doctype html><html><head><title>Fallback</title>
      <meta property="og:title" content="Audience Building &amp; Distribution">
      <meta name="description" content="How to grow">
      <script>alert('x'); window.evil = 1</script><style>.a{color:red}</style></head>
      <body><nav>Home About</nav><header>Site header</header>
      <article><h1>Grow</h1><p>Post every day on <b>three</b> channels.</p><p>Measure &lt;replies&gt;.</p>
      <img src=x onerror="alert(1)"><br><form><input value="secret"></form></article>
      <footer>Copyright</footer><svg><text>svgtext</text></svg></body></html>"#,
        );
        assert_eq!(ex.title, "Audience Building & Distribution");
        assert_eq!(ex.description, "How to grow");
        assert!(ex.text.contains("Post every day on three channels."), "{}", ex.text);
        assert!(ex.text.contains("Measure <replies>."));
        for bad in ["alert", "color:red", "Home About", "Site header", "Copyright", "svgtext", "onerror", "secret", "Fallback"] {
            assert!(!ex.text.contains(bad), "leaked {bad}: {}", ex.text);
        }
    }

    #[test]
    fn works_without_body_tag() {
        let ex = extract_html("<title>Reddit growth playbook</title><p>Use subreddits for launch feedback.</p>");
        assert_eq!(ex.title, "Reddit growth playbook");
        assert!(ex.text.contains("subreddits"));
    }

    #[test]
    fn entity_edge_cases() {
        assert_eq!(decode_entities("a &amp; b &#x41; &#66; &bogus; &#0; &"), "a & b A B &bogus; &#0; &");
    }
}
