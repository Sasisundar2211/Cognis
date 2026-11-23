//! Minimal WebAuthn (passkeys) relying party: ES256 and RS256, attestation "none".
//!
//! Why passkeys: no passwords to hash (password hashing needs about 250 ms of CPU on Workers;
//! the free plan allows 10 ms), no email provider needed, and phishing-resistant by design.
//! Verifying a passkey signature costs a few milliseconds.
//!
//! What is checked, per the WebAuthn Level 2 spec:
//! - clientDataJSON: type, challenge (exact, single use), origin (exact).
//! - authenticatorData: RP ID hash, user-present flag, sign counter (clone detection).
//! - registration: attested credential data, COSE public key (EC2 P-256 / RSA).
//! - assertion: signature over authenticatorData || SHA-256(clientDataJSON).
//!
//! Attestation statements are not verified (attestation "none"): Cognis does not restrict
//! which authenticator brands users may use.

use base64::Engine;
use ciborium::value::Value;
use sha2::{Digest, Sha256};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

pub const ALG_ES256: i64 = -7;
pub const ALG_RS256: i64 = -257;
const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_AT: u8 = 0x40;

pub fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn unb64(s: &str) -> Result<Vec<u8>, &'static str> {
    if s.len() > 8192 {
        return Err("too_large");
    }
    B64.decode(s.trim_end_matches('=')).map_err(|_| "bad_base64")
}

#[derive(Debug, PartialEq)]
pub struct ClientData {
    pub typ: String,
    pub challenge: String,
    pub origin: String,
}

pub fn parse_client_data(json: &[u8]) -> Result<ClientData, &'static str> {
    let v: serde_json::Value = serde_json::from_slice(json).map_err(|_| "bad_client_data")?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string).ok_or("bad_client_data");
    Ok(ClientData { typ: s("type")?, challenge: s("challenge")?, origin: s("origin")? })
}

#[derive(Debug)]
pub struct AuthData {
    pub rp_id_hash: [u8; 32],
    pub flags: u8,
    pub sign_count: u32,
    /// (credential id, COSE public key bytes) when the AT flag is set.
    pub attested: Option<(Vec<u8>, Vec<u8>)>,
}

pub fn parse_auth_data(b: &[u8]) -> Result<AuthData, &'static str> {
    if b.len() < 37 {
        return Err("bad_auth_data");
    }
    let mut rp = [0u8; 32];
    rp.copy_from_slice(&b[..32]);
    let flags = b[32];
    let sign_count = u32::from_be_bytes([b[33], b[34], b[35], b[36]]);
    let mut attested = None;
    if flags & FLAG_AT != 0 {
        // aaguid (16) | credIdLen (2) | credId | credentialPublicKey (CBOR) | extensions?
        if b.len() < 37 + 18 {
            return Err("bad_auth_data");
        }
        let len = u16::from_be_bytes([b[53], b[54]]) as usize;
        let start = 55;
        if len == 0 || len > 1023 || b.len() < start + len + 1 {
            return Err("bad_credential_id");
        }
        let cred_id = b[start..start + len].to_vec();
        let rest = &b[start + len..];
        let mut cursor = std::io::Cursor::new(rest);
        let _: Value = ciborium::de::from_reader(&mut cursor).map_err(|_| "bad_public_key")?;
        let used = cursor.position() as usize;
        attested = Some((cred_id, rest[..used].to_vec()));
    }
    Ok(AuthData { rp_id_hash: rp, flags, sign_count, attested })
}

/// Extract authData from a CBOR attestationObject {fmt, attStmt, authData}.
pub fn auth_data_from_attestation(att: &[u8]) -> Result<Vec<u8>, &'static str> {
    let v: Value = ciborium::de::from_reader(att).map_err(|_| "bad_attestation")?;
    let map = v.as_map().ok_or("bad_attestation")?;
    for (k, val) in map {
        if k.as_text() == Some("authData") {
            return val.as_bytes().cloned().ok_or("bad_attestation");
        }
    }
    Err("bad_attestation")
}

#[derive(Debug, PartialEq)]
pub enum PublicKey {
    Es256 { x: Vec<u8>, y: Vec<u8> },
    Rs256 { n: Vec<u8>, e: Vec<u8> },
}

fn int_key(k: &Value) -> Option<i64> {
    k.as_integer().and_then(|i| i64::try_from(i).ok())
}

pub fn parse_cose_key(bytes: &[u8]) -> Result<PublicKey, &'static str> {
    let v: Value = ciborium::de::from_reader(bytes).map_err(|_| "bad_public_key")?;
    let map = v.as_map().ok_or("bad_public_key")?;
    let get = |label: i64| map.iter().find(|(k, _)| int_key(k) == Some(label)).map(|(_, v)| v);
    let kty = get(1).and_then(int_key).ok_or("bad_public_key")?;
    let alg = get(3).and_then(int_key).ok_or("bad_public_key")?;
    match (kty, alg) {
        (2, ALG_ES256) => {
            if get(-1).and_then(int_key) != Some(1) {
                return Err("unsupported_curve");
            }
            let x = get(-2).and_then(|v| v.as_bytes()).cloned().ok_or("bad_public_key")?;
            let y = get(-3).and_then(|v| v.as_bytes()).cloned().ok_or("bad_public_key")?;
            if x.len() != 32 || y.len() != 32 {
                return Err("bad_public_key");
            }
            Ok(PublicKey::Es256 { x, y })
        }
        (3, ALG_RS256) => {
            let n = get(-1).and_then(|v| v.as_bytes()).cloned().ok_or("bad_public_key")?;
            let e = get(-2).and_then(|v| v.as_bytes()).cloned().ok_or("bad_public_key")?;
            if n.len() < 256 || n.len() > 512 || e.is_empty() || e.len() > 4 {
                return Err("bad_public_key");
            }
            Ok(PublicKey::Rs256 { n, e })
        }
        _ => Err("unsupported_algorithm"),
    }
}

pub fn verify_signature(key: &PublicKey, message: &[u8], sig: &[u8]) -> bool {
    match key {
        PublicKey::Es256 { x, y } => {
            use p256::ecdsa::signature::Verifier;
            let mut sec1 = Vec::with_capacity(65);
            sec1.push(0x04);
            sec1.extend_from_slice(x);
            sec1.extend_from_slice(y);
            let (Ok(vk), Ok(s)) = (p256::ecdsa::VerifyingKey::from_sec1_bytes(&sec1), p256::ecdsa::Signature::from_der(sig)) else { return false };
            vk.verify(message, &s).is_ok()
        }
        PublicKey::Rs256 { n, e } => {
            use rsa::signature::Verifier;
            let bits = (n.len() * 8) as u32;
            let (Ok(nn), Ok(ee)) = (rsa::BoxedUint::from_be_slice(n, bits), rsa::BoxedUint::from_be_slice(e, 64)) else { return false };
            let Ok(pk) = rsa::PublicKey::new(nn, ee) else { return false };
            let vk = rsa::pkcs1v15::VerifyingKey::<sha2::Sha256>::new(pk);
            let Ok(s) = rsa::pkcs1v15::Signature::try_from(sig) else { return false };
            vk.verify(message, &s).is_ok()
        }
    }
}

pub struct Expect<'a> {
    pub rp_id: &'a str,
    pub origin: &'a str,
    pub challenge: &'a str,
}

fn check_client(cd: &ClientData, typ: &str, ex: &Expect) -> Result<(), &'static str> {
    if cd.typ != typ {
        return Err("wrong_type");
    }
    if cd.challenge.trim_end_matches('=') != ex.challenge {
        return Err("wrong_challenge");
    }
    if cd.origin != ex.origin {
        return Err("wrong_origin");
    }
    Ok(())
}

fn check_auth(ad: &AuthData, ex: &Expect) -> Result<(), &'static str> {
    if ad.rp_id_hash[..] != Sha256::digest(ex.rp_id.as_bytes())[..] {
        return Err("wrong_rp");
    }
    if ad.flags & FLAG_UP == 0 {
        return Err("user_not_present");
    }
    Ok(())
}

pub struct Registered {
    pub credential_id: Vec<u8>,
    pub cose_key: Vec<u8>,
    pub sign_count: u32,
    pub user_verified: bool,
}

pub fn verify_registration(ex: &Expect, client_data_json: &[u8], attestation_object: &[u8]) -> Result<Registered, &'static str> {
    check_client(&parse_client_data(client_data_json)?, "webauthn.create", ex)?;
    let ad = parse_auth_data(&auth_data_from_attestation(attestation_object)?)?;
    check_auth(&ad, ex)?;
    let (credential_id, cose_key) = ad.attested.ok_or("no_credential")?;
    parse_cose_key(&cose_key)?;
    Ok(Registered { credential_id, cose_key, sign_count: ad.sign_count, user_verified: ad.flags & FLAG_UV != 0 })
}

/// Verify a sign-in. Returns the new signature counter.
pub fn verify_assertion(ex: &Expect, cose_key: &[u8], stored_count: u32, client_data_json: &[u8], auth_data: &[u8], signature: &[u8]) -> Result<u32, &'static str> {
    check_client(&parse_client_data(client_data_json)?, "webauthn.get", ex)?;
    let ad = parse_auth_data(auth_data)?;
    check_auth(&ad, ex)?;
    let key = parse_cose_key(cose_key)?;
    let mut msg = auth_data.to_vec();
    msg.extend_from_slice(&Sha256::digest(client_data_json));
    if !verify_signature(&key, &msg, signature) {
        return Err("bad_signature");
    }
    // Counters that do not increase suggest a cloned authenticator. Many passkeys report 0 always.
    if (ad.sign_count != 0 || stored_count != 0) && ad.sign_count <= stored_count {
        return Err("counter_regressed");
    }
    Ok(ad.sign_count)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer, SigningKey};

    const RP: &str = "cognis.example.workers.dev";
    const ORIGIN: &str = "https://cognis.example.workers.dev";

    pub fn cose_es256(sk: &SigningKey) -> Vec<u8> {
        let pt = sk.verifying_key().to_sec1_point(false);
        let raw = pt.as_bytes();
        let (x, y) = (raw[1..33].to_vec(), raw[33..65].to_vec());
        let v = Value::Map(vec![
            (Value::Integer(1.into()), Value::Integer(2.into())),
            (Value::Integer(3.into()), Value::Integer((-7).into())),
            (Value::Integer((-1).into()), Value::Integer(1.into())),
            (Value::Integer((-2).into()), Value::Bytes(x)),
            (Value::Integer((-3).into()), Value::Bytes(y)),
        ]);
        let mut out = vec![];
        ciborium::ser::into_writer(&v, &mut out).unwrap();
        out
    }

    fn auth_data(rp: &str, flags: u8, count: u32, cred: Option<(&[u8], &[u8])>) -> Vec<u8> {
        let mut b = Sha256::digest(rp.as_bytes()).to_vec();
        b.push(flags);
        b.extend_from_slice(&count.to_be_bytes());
        if let Some((id, key)) = cred {
            b.extend_from_slice(&[0u8; 16]);
            b.extend_from_slice(&(id.len() as u16).to_be_bytes());
            b.extend_from_slice(id);
            b.extend_from_slice(key);
        }
        b
    }

    fn attestation(ad: Vec<u8>) -> Vec<u8> {
        let v = Value::Map(vec![
            (Value::Text("fmt".into()), Value::Text("none".into())),
            (Value::Text("attStmt".into()), Value::Map(vec![])),
            (Value::Text("authData".into()), Value::Bytes(ad)),
        ]);
        let mut out = vec![];
        ciborium::ser::into_writer(&v, &mut out).unwrap();
        out
    }

    fn client(typ: &str, challenge: &str, origin: &str) -> Vec<u8> {
        serde_json::json!({ "type": typ, "challenge": challenge, "origin": origin, "crossOrigin": false }).to_string().into_bytes()
    }

    fn key() -> SigningKey {
        SigningKey::from_slice(&[7u8; 32]).unwrap()
    }

    #[test]
    fn registration_and_assertion_es256() {
        let sk = key();
        let ex = Expect { rp_id: RP, origin: ORIGIN, challenge: "chal-1" };
        let cose = cose_es256(&sk);
        let att = attestation(auth_data(RP, FLAG_UP | FLAG_UV | FLAG_AT, 0, Some((b"cred-123", &cose))));
        let reg = verify_registration(&ex, &client("webauthn.create", "chal-1", ORIGIN), &att).unwrap();
        assert_eq!(reg.credential_id, b"cred-123");
        assert!(reg.user_verified);

        let ex2 = Expect { challenge: "chal-2", ..ex };
        let ad = auth_data(RP, FLAG_UP, 5, None);
        let cd = client("webauthn.get", "chal-2", ORIGIN);
        let mut msg = ad.clone();
        msg.extend_from_slice(&Sha256::digest(&cd));
        let sig: p256::ecdsa::Signature = sk.sign(&msg);
        let der = sig.to_der();
        assert_eq!(verify_assertion(&ex2, &reg.cose_key, 0, &cd, &ad, der.as_bytes()), Ok(5));
        assert_eq!(verify_assertion(&ex2, &reg.cose_key, 5, &cd, &ad, der.as_bytes()), Err("counter_regressed"));
        // Tampered data, wrong key, wrong origin, wrong challenge, wrong type, wrong RP.
        let mut bad = ad.clone();
        bad[33] ^= 1;
        assert_eq!(verify_assertion(&ex2, &reg.cose_key, 0, &cd, &bad, der.as_bytes()), Err("bad_signature"));
        let other = cose_es256(&SigningKey::from_slice(&[9u8; 32]).unwrap());
        assert_eq!(verify_assertion(&ex2, &other, 0, &cd, &ad, der.as_bytes()), Err("bad_signature"));
        assert_eq!(verify_assertion(&ex2, &reg.cose_key, 0, &client("webauthn.get", "chal-2", "https://evil.example"), &ad, der.as_bytes()), Err("wrong_origin"));
        assert_eq!(verify_assertion(&ex2, &reg.cose_key, 0, &client("webauthn.get", "chal-X", ORIGIN), &ad, der.as_bytes()), Err("wrong_challenge"));
        assert_eq!(verify_assertion(&ex2, &reg.cose_key, 0, &client("webauthn.create", "chal-2", ORIGIN), &ad, der.as_bytes()), Err("wrong_type"));
        assert_eq!(verify_assertion(&ex2, &reg.cose_key, 0, &cd, &auth_data("evil.example", FLAG_UP, 5, None), der.as_bytes()), Err("wrong_rp"));
        assert_eq!(verify_assertion(&ex2, &reg.cose_key, 0, &cd, &auth_data(RP, 0, 5, None), der.as_bytes()), Err("user_not_present"));
        assert_eq!(verify_assertion(&ex2, &reg.cose_key, 0, &cd, &ad, b"garbage"), Err("bad_signature"));
    }

    #[test]
    fn registration_rejects_bad_inputs() {
        let sk = key();
        let ex = Expect { rp_id: RP, origin: ORIGIN, challenge: "c" };
        let cose = cose_es256(&sk);
        let ok_cd = client("webauthn.create", "c", ORIGIN);
        assert_eq!(verify_registration(&ex, &ok_cd, &attestation(auth_data(RP, FLAG_UP, 0, None))).err(), Some("no_credential"));
        assert_eq!(verify_registration(&ex, &ok_cd, b"\xff\x00").err(), Some("bad_attestation"));
        assert_eq!(verify_registration(&ex, b"{}", &attestation(auth_data(RP, FLAG_UP | FLAG_AT, 0, Some((b"id", &cose))))).err(), Some("bad_client_data"));
        let weird = { let mut v = vec![]; ciborium::ser::into_writer(&Value::Map(vec![(Value::Integer(1.into()), Value::Integer(1.into())), (Value::Integer(3.into()), Value::Integer((-8).into()))]), &mut v).unwrap(); v };
        assert_eq!(verify_registration(&ex, &ok_cd, &attestation(auth_data(RP, FLAG_UP | FLAG_AT, 0, Some((b"id", &weird))))).err(), Some("unsupported_algorithm"));
        // Truncated auth data never panics.
        for n in 0..60 {
            let full = auth_data(RP, FLAG_UP | FLAG_AT, 0, Some((b"id", &cose)));
            let _ = parse_auth_data(&full[..n.min(full.len())]);
        }
    }

    #[test]
    fn rs256_signature() {
        use rsa::pkcs1v15::SigningKey as RsaSigningKey;
        use rsa::signature::{SignatureEncoding, Signer as _};
        use rsa::traits::PublicKeyParts;
        let mut rng = rsa::rand_core::UnwrapErr(getrandom::SysRng);
        let sk = rsa::RsaPrivateKey::new(&mut rng, 2048).unwrap();
        let pk = sk.to_public_key();
        let key = PublicKey::Rs256 { n: pk.n().to_be_bytes().to_vec(), e: pk.e().to_be_bytes().to_vec().into_iter().skip_while(|b| *b == 0).collect() };
        let signer = RsaSigningKey::<sha2::Sha256>::new(sk);
        let sig = signer.sign(b"hello");
        assert!(verify_signature(&key, b"hello", &sig.to_bytes()));
        assert!(!verify_signature(&key, b"hellO", &sig.to_bytes()));
    }
}
