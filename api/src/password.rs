//! Password hashing: scrypt (RustCrypto), N=2^14, r=16, p=1, 64-byte key, 16-byte salt.
//! Stored as "scrypt:N:r:p:saltHex:keyHex" so parameters can rise later without breaking old hashes.

use subtle::ConstantTimeEq;

const LOG_N: u8 = 14;
const R: u32 = 16;
const P: u32 = 1;
const KEYLEN: usize = 64;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn derive(password: &str, salt: &[u8], log_n: u8, r: u32, p: u32) -> Option<[u8; KEYLEN]> {
    use unicode_normalization::UnicodeNormalization;
    let pw: String = password.nfkc().collect();
    let params = scrypt::Params::new(log_n, r, p).ok()?;
    let mut out = [0u8; KEYLEN];
    scrypt::scrypt(pw.as_bytes(), salt, &params, &mut out).ok()?;
    Some(out)
}

pub fn hash_password(password: &str) -> String {
    let salt: [u8; 16] = crate::util::random_bytes();
    let key = derive(password, &salt, LOG_N, R, P).expect("valid scrypt params");
    format!("scrypt:{}:{}:{}:{}:{}", 1u32 << LOG_N, R, P, hex(&salt), hex(&key))
}

/// Constant-time verification. Malformed or hostile hash strings return false, never panic.
pub fn verify_password(hash: &str, password: &str) -> bool {
    let parts: Vec<&str> = hash.split(':').collect();
    if parts.len() != 6 || parts[0] != "scrypt" {
        return false;
    }
    let (Ok(n), Ok(r), Ok(p)) = (parts[1].parse::<u32>(), parts[2].parse::<u32>(), parts[3].parse::<u32>()) else {
        return false;
    };
    if !n.is_power_of_two() || n < 2 || n > 1 << 20 || r == 0 || r > 32 || p == 0 || p > 4 {
        return false;
    }
    let (Some(salt), Some(expected)) = (unhex(parts[4]), unhex(parts[5])) else {
        return false;
    };
    if salt.len() != 16 || expected.len() != KEYLEN {
        return false;
    }
    match derive(password, &salt, n.trailing_zeros() as u8, r, p) {
        Some(actual) => actual.ct_eq(&expected).into(),
        None => false,
    }
}

/// A fixed hash used when the account does not exist, so sign-in takes the same time either way.
pub const DUMMY_HASH: &str = "scrypt:16384:16:1:00000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_are_salted_and_verify() {
        let a = hash_password("a-long-password-1");
        let b = hash_password("a-long-password-1");
        assert_ne!(a, b);
        assert!(a.starts_with("scrypt:16384:16:1:"));
        assert!(verify_password(&a, "a-long-password-1"));
        assert!(!verify_password(&a, "a-long-password-2"));
    }

    #[test]
    fn rejects_hostile_hashes() {
        for h in ["", "bcrypt:x", "scrypt:99999999:16:1:00:00", "scrypt:16384:16:1:zz:zz", "scrypt:16384:16:1", "scrypt:3:16:1:00:00", DUMMY_HASH] {
            assert!(!verify_password(h, "x"), "{h}");
        }
    }

    #[test]
    fn measures_native_cost() {
        let t = std::time::Instant::now();
        let _ = hash_password("timing");
        eprintln!("native scrypt hash: {:?}", t.elapsed());
    }
}
