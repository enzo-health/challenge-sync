//! The plaza pass: a short-lived, Ed25519-signed statement "this connection is member M until EXP".
//!
//! Format: `base64url_nopad(payload_json) + "." + base64url_nopad(signature)`, where the payload is
//! `{"m":<member id>,"exp":<unix seconds>}` and the signature covers the exact payload bytes.
//! Keys travel as standard (padded) base64 of 32 raw bytes: the private key is the Ed25519 seed,
//! the public key the verifying key.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::fmt;

use crate::MAX_PASS_BYTES;

/// How long a freshly signed pass stays valid.
pub const PASS_TTL_SECS: i64 = 60;

/// What a verified pass says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PassClaims {
    pub member_id: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PassError {
    /// The pass is not shaped like a pass; the string says what was wrong.
    Malformed(String),
    /// Well formed, but the signature does not match the room's public key.
    BadSignature,
    /// Signature fine, but `now >= expired_at`.
    Expired { expired_at: i64, now: i64 },
}

impl PassError {
    /// Stable machine code, as sent in the room's `error` message.
    pub fn code(&self) -> &'static str {
        match self {
            PassError::Malformed(_) => crate::codes::PASS_MALFORMED,
            PassError::BadSignature => crate::codes::PASS_BAD_SIGNATURE,
            PassError::Expired { .. } => crate::codes::PASS_EXPIRED,
        }
    }
}

impl fmt::Display for PassError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PassError::Malformed(what) => write!(f, "pass is malformed: {what}"),
            PassError::BadSignature => {
                write!(f, "pass signature does not match this room's public key")
            }
            PassError::Expired { expired_at, now } => write!(
                f,
                "pass expired at {expired_at} (unix seconds); it is now {now}, {}s later",
                now - expired_at
            ),
        }
    }
}

impl std::error::Error for PassError {}

#[derive(Serialize, Deserialize)]
struct Payload {
    m: i64,
    exp: i64,
}

/// Signs a pass for `member_id`, valid until `expires_at` (unix seconds).
pub fn sign(private_seed: &[u8; 32], member_id: i64, expires_at: i64) -> String {
    let payload = serde_json::to_vec(&Payload {
        m: member_id,
        exp: expires_at,
    })
    .expect("serializing two integers cannot fail");
    sign_raw(private_seed, &payload)
}

/// Signs arbitrary payload bytes in the pass format (tests use it to make well-signed garbage).
#[doc(hidden)]
pub fn sign_raw(private_seed: &[u8; 32], payload: &[u8]) -> String {
    let key = SigningKey::from_bytes(private_seed);
    let sig = key.sign(payload);
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(payload),
        URL_SAFE_NO_PAD.encode(sig.to_bytes())
    )
}

/// Checks shape, signature (strict Ed25519) and expiry, in that order.
pub fn verify(public_key: &[u8; 32], pass: &str, now_unix: i64) -> Result<PassClaims, PassError> {
    use PassError::Malformed;
    if pass.len() > MAX_PASS_BYTES {
        return Err(Malformed(format!(
            "it is {} bytes, longer than the {MAX_PASS_BYTES}-byte limit",
            pass.len()
        )));
    }
    let (payload_b64, sig_b64) = pass
        .split_once('.')
        .ok_or_else(|| Malformed("there is no '.' between payload and signature".into()))?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|e| Malformed(format!("payload is not unpadded base64url ({e})")))?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|e| Malformed(format!("signature is not unpadded base64url ({e})")))?;
    let sig_bytes: [u8; 64] = sig_bytes.as_slice().try_into().map_err(|_| {
        Malformed(format!(
            "signature is {} bytes, expected 64",
            sig_bytes.len()
        ))
    })?;
    let key = VerifyingKey::from_bytes(public_key).map_err(|_| PassError::BadSignature)?;
    key.verify_strict(&payload, &Signature::from_bytes(&sig_bytes))
        .map_err(|_| PassError::BadSignature)?;
    let claims: Payload = serde_json::from_slice(&payload).map_err(|e| {
        Malformed(format!(
            "payload is not {{\"m\":<int>,\"exp\":<int>}} JSON ({e})"
        ))
    })?;
    if now_unix >= claims.exp {
        return Err(PassError::Expired {
            expired_at: claims.exp,
            now: now_unix,
        });
    }
    Ok(PassClaims {
        member_id: claims.m,
        expires_at: claims.exp,
    })
}

/// The 32-byte public (verifying) key for a 32-byte private seed.
pub fn public_key_of(private_seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(private_seed)
        .verifying_key()
        .to_bytes()
}

/// Decodes a key given as standard base64 of exactly 32 bytes (surrounding whitespace ignored).
pub fn decode_key(base64: &str) -> Result<[u8; 32], String> {
    let trimmed = base64.trim();
    if trimmed.is_empty() {
        return Err("key is empty".into());
    }
    let bytes = STANDARD
        .decode(trimmed)
        .map_err(|e| format!("key is not standard base64 ({e})"))?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("key decodes to {} bytes, expected 32", bytes.len()))
}

/// Encodes a 32-byte key as standard base64.
pub fn encode_key(key: &[u8; 32]) -> String {
    STANDARD.encode(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: [u8; 32] = [7; 32];
    const OTHER_SEED: [u8; 32] = [9; 32];
    const NOW: i64 = 1_800_000_000;

    fn pk() -> [u8; 32] {
        public_key_of(&SEED)
    }

    #[test]
    fn valid_pass_round_trips() {
        let p = sign(&SEED, 42, NOW + PASS_TTL_SECS);
        assert_eq!(
            verify(&pk(), &p, NOW).unwrap(),
            PassClaims {
                member_id: 42,
                expires_at: NOW + 60
            }
        );
        // Payload is exactly the documented JSON.
        let payload = URL_SAFE_NO_PAD
            .decode(p.split_once('.').unwrap().0)
            .unwrap();
        assert_eq!(
            payload,
            format!("{{\"m\":42,\"exp\":{}}}", NOW + 60).as_bytes()
        );
    }

    #[test]
    fn negative_and_large_ids_survive() {
        let p = sign(&SEED, -5, i64::MAX);
        assert_eq!(verify(&pk(), &p, NOW).unwrap().member_id, -5);
    }

    #[test]
    fn expired() {
        let p = sign(&SEED, 1, NOW);
        let e = verify(&pk(), &p, NOW).unwrap_err();
        assert_eq!(
            e,
            PassError::Expired {
                expired_at: NOW,
                now: NOW
            }
        );
        assert_eq!(e.code(), "pass_expired");
        assert!(verify(&pk(), &p, NOW - 1).is_ok());
    }

    #[test]
    fn tampered_payload() {
        let p = sign(&SEED, 1, NOW + 60);
        let sig = p.split_once('.').unwrap().1;
        let forged = format!(
            "{}.{sig}",
            URL_SAFE_NO_PAD.encode(format!("{{\"m\":2,\"exp\":{}}}", NOW + 60))
        );
        let e = verify(&pk(), &forged, NOW).unwrap_err();
        assert_eq!(e, PassError::BadSignature);
        assert_eq!(e.code(), "pass_bad_signature");
    }

    #[test]
    fn tampered_signature() {
        let p = sign(&SEED, 1, NOW + 60);
        let (payload, sig) = p.split_once('.').unwrap();
        let mut bytes = URL_SAFE_NO_PAD.decode(sig).unwrap();
        bytes[10] ^= 1;
        let forged = format!("{payload}.{}", URL_SAFE_NO_PAD.encode(bytes));
        assert_eq!(
            verify(&pk(), &forged, NOW).unwrap_err(),
            PassError::BadSignature
        );
    }

    #[test]
    fn wrong_key() {
        let p = sign(&OTHER_SEED, 1, NOW + 60);
        assert_eq!(verify(&pk(), &p, NOW).unwrap_err(), PassError::BadSignature);
    }

    fn malformed(p: &str) -> String {
        match verify(&pk(), p, NOW) {
            Err(e @ PassError::Malformed(_)) => {
                assert_eq!(e.code(), "pass_malformed");
                e.to_string()
            }
            other => panic!("expected Malformed for {p:?}, got {other:?}"),
        }
    }

    #[test]
    fn malformed_passes() {
        assert!(malformed("nodothere").contains("no '.'"));
        assert!(malformed("").contains("no '.'"));
        assert!(malformed("!!!.AAAA").contains("payload is not"));
        assert!(malformed("eyJ9.###").contains("signature is not"));
        assert!(malformed("eyJ9.AAAA").contains("expected 64"));
        assert!(malformed(&"a".repeat(513)).contains("513 bytes"));
        // Correctly signed, but the payload is not the pass JSON.
        assert!(malformed(&sign_raw(&SEED, b"not json")).contains("JSON"));
        assert!(malformed(&sign_raw(&SEED, b"{\"m\":\"1\",\"exp\":5}")).contains("JSON"));
    }

    #[test]
    fn keys_encode_and_decode() {
        let pk = pk();
        assert_eq!(decode_key(&encode_key(&pk)).unwrap(), pk);
        assert_eq!(decode_key(&format!(" {}\n", encode_key(&pk))).unwrap(), pk);
        assert!(decode_key("").unwrap_err().contains("empty"));
        assert!(decode_key("not base64!")
            .unwrap_err()
            .contains("not standard base64"));
        assert!(decode_key("AAAA")
            .unwrap_err()
            .contains("3 bytes, expected 32"));
    }
}
