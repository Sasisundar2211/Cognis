//! Small shared helpers: ids, time, hashing, text normalization.

use base64::Engine;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("system randomness unavailable");
    b
}

/// Public id like `ki_<32 hex>`. 128 bits of randomness.
pub fn new_id(prefix: &str) -> String {
    let b: [u8; 16] = random_bytes();
    let mut s = String::with_capacity(prefix.len() + 33);
    s.push_str(prefix);
    s.push('_');
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

/// 256-bit URL-safe secret token (sessions, email links, device tokens).
pub fn new_token() -> String {
    let b: [u8; 32] = random_bytes();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

pub fn sha256_hex(input: &str) -> String {
    let d = Sha256::digest(input.as_bytes());
    let mut s = String::with_capacity(64);
    for x in d {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

#[cfg(target_arch = "wasm32")]
pub fn now_ms() -> f64 {
    worker::Date::now().as_millis() as f64
}

#[cfg(not(target_arch = "wasm32"))]
pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// ISO 8601 UTC with milliseconds, e.g. 2026-11-21T09:05:03.120Z. Sorts lexically.
pub fn iso_from_ms(ms: f64) -> String {
    let total_ms = ms.max(0.0) as i64;
    let millis = total_ms % 1000;
    let secs = total_ms / 1000;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant), proleptic Gregorian.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

pub fn now_iso() -> String {
    iso_from_ms(now_ms())
}

pub fn iso_in(ms_from_now: f64) -> String {
    iso_from_ms(now_ms() + ms_from_now)
}

fn is_stripped(c: char) -> bool {
    matches!(c,
        '\u{0000}'..='\u{0008}' | '\u{000B}' | '\u{000C}' | '\u{000E}'..='\u{001F}' | '\u{007F}'
        | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// NFC, strip control and bidi-override characters (keeps \n), collapse spaces,
/// limit blank lines, trim, and cap length in characters.
pub fn normalize_text(input: &str, max_chars: usize) -> String {
    let nfc: String = input.nfc().filter(|c| !is_stripped(*c)).collect();
    let nfc = nfc.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(nfc.len());
    let mut prev_space = false;
    let mut newlines = 0;
    for c in nfc.chars() {
        if c == '\n' {
            // drop trailing spaces before newline
            while out.ends_with(' ') {
                out.pop();
            }
            newlines += 1;
            prev_space = false;
            if newlines <= 2 {
                out.push('\n');
            }
            continue;
        }
        if c == ' ' || c == '\t' {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
            continue;
        }
        if newlines > 0 && out.ends_with('\n') && prev_space {
            // no-op; spaces at line start were already collapsed
        }
        prev_space = false;
        newlines = 0;
        out.push(c);
    }
    let trimmed = out.trim();
    trimmed.chars().take(max_chars).collect::<String>().trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_formats_known_instants() {
        assert_eq!(iso_from_ms(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_795_219_200_000.0), "2026-11-21T00:00:00.000Z");
        assert_eq!(iso_from_ms(951_782_400_123.0), "2000-02-29T00:00:00.123Z");
    }

    #[test]
    fn normalizes_text() {
        assert_eq!(normalize_text("safe\u{0000}text\u{202E}with\u{200B}hidden\u{0002}marks", 100), "safetextwithhiddenmarks");
        assert_eq!(normalize_text("Same   content\n\n\n\nhere", 100), "Same content\n\nhere");
        assert_eq!(normalize_text("  a \r\n b  ", 100), "a\n b");
        assert_eq!(normalize_text("abcdef", 3), "abc");
        assert_eq!(normalize_text("   \n\t ", 10), "");
    }

    #[test]
    fn ids_and_tokens_are_unique_and_well_formed() {
        let a = new_id("ki");
        assert!(a.starts_with("ki_") && a.len() == 35);
        assert_ne!(a, new_id("ki"));
        assert_eq!(new_token().len(), 43);
        assert_eq!(sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
