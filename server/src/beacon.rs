//! The public randomness the official weekly draw is seeded with: drand's "quicknet" beacon, run by
//! the League of Entropy (<https://drand.love>). Nobody here controls it, every round is published
//! once at a time fixed since the chain began, and anyone can look a round up and check it.
//!
//! **Rounds and time.** Round `r` is published at `GENESIS + (r - 1) * PERIOD` (unix seconds). The
//! draw names its round by a time ([`round_at_or_after`]) before the round exists.
//!
//! **Fetching.** `GET <relay>/<CHAIN_HASH>/public/<round>` answers
//! `{"round": r, "randomness": "<64 hex>", "signature": "<96 hex>"}`; a round not yet published is a
//! 425 (or 404 on Cloudflare). The relays are [`DEFAULT_RELAYS`], tried in order with
//! [`FETCH_TIMEOUT`] each, or the comma-separated base URLs in `LOTTERY_BEACON_URLS` (the tests point
//! it at a local fake). There is no fallback to local randomness anywhere: a failure is reported,
//! and the next request tries again.
//!
//! **Checking.** A beacon is accepted only when it is for the round asked, its randomness is the
//! SHA-256 of its signature (quicknet's rule), and the signature verifies against the chain's public
//! key ([`PUBLIC_KEY_HEX`], BLS12-381 with the key on G2 and signatures on G1, RFC 9380 hashing) via
//! the pure-Rust `drand-verify` crate. Debug builds only, `DEV_BEACON_SKIP_SIGNATURE_CHECK=1` skips
//! the BLS check (the local fake beacon cannot sign as the League of Entropy); a release build
//! always verifies.

use std::time::Duration;

use crate::util::sha256;

/// quicknet's chain hash.
pub const CHAIN_HASH: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
/// quicknet's group public key (G2, 96 bytes), as its `/info` publishes it.
pub const PUBLIC_KEY_HEX: &str = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
/// Unix time of round 1.
pub const GENESIS: i64 = 1_692_803_367;
/// Seconds between rounds.
pub const PERIOD: i64 = 3;
/// Public HTTP relays (drand's documented endpoints), tried in this order: drand's own, then
/// Cloudflare's independent one, then drand's second.
pub const DEFAULT_RELAYS: [&str; 3] = ["https://api.drand.sh", "https://drand.cloudflare.com", "https://api2.drand.sh"];
/// Comma-separated relay base URLs replacing [`DEFAULT_RELAYS`].
pub const RELAYS_ENV: &str = "LOTTERY_BEACON_URLS";
/// Per relay, connecting and reading together.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(3);
/// Where anyone can read the chain's parameters, to check a round themselves.
pub const INFO_URL: &str =
    "https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/info";

/// The first round published at or after unix time `t`.
pub fn round_at_or_after(t: i64) -> i64 {
    if t <= GENESIS {
        return 1;
    }
    (t - GENESIS + PERIOD - 1).div_euclid(PERIOD) + 1
}

/// When round `round` is published (unix seconds).
pub fn round_time(round: i64) -> i64 {
    GENESIS + (round - 1) * PERIOD
}

/// One checked beacon value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Beacon {
    pub round: i64,
    /// 64 lowercase hex characters.
    pub randomness: String,
    /// 96 lowercase hex characters (a compressed G1 point).
    pub signature: String,
}

/// The relays to try: `LOTTERY_BEACON_URLS` when set and not blank, else [`DEFAULT_RELAYS`].
pub fn relays() -> Vec<String> {
    let configured: Vec<String> = std::env::var(RELAYS_ENV)
        .unwrap_or_default()
        .split(',')
        .map(|url| url.trim().trim_end_matches('/').to_string())
        .filter(|url| !url.is_empty())
        .collect();
    if configured.is_empty() { DEFAULT_RELAYS.iter().map(|url| url.to_string()).collect() } else { configured }
}

/// Fetch and check `round`, trying each relay in turn. The error names every relay and what
/// happened there, e.g. `api.drand.sh: round 123 is not published yet (HTTP 425); …`.
pub async fn fetch(round: i64) -> Result<Beacon, String> {
    let relays = relays();
    tokio::task::spawn_blocking(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(FETCH_TIMEOUT))
            .http_status_as_error(false)
            .user_agent("challenge-sync-lottery")
            .build()
            .into();
        let mut failures = Vec::new();
        for relay in &relays {
            match fetch_from(&agent, relay, round) {
                Ok(beacon) => return Ok(beacon),
                Err(why) => failures.push(format!("{}: {why}", host_of(relay))),
            }
        }
        Err(failures.join("; "))
    })
    .await
    .map_err(|error| format!("the beacon fetch task failed: {error}"))?
}

fn host_of(url: &str) -> &str {
    url.split("://").nth(1).unwrap_or(url)
}

fn fetch_from(agent: &ureq::Agent, relay: &str, round: i64) -> Result<Beacon, String> {
    let url = format!("{relay}/{CHAIN_HASH}/public/{round}");
    let mut response = agent.get(&url).call().map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .with_config()
        .limit(16 * 1024)
        .read_to_string()
        .map_err(|error| format!("reading the answer failed: {error}"))?;
    match status {
        200 => check(round, &body),
        // drand's relays say "too early" with 425; Cloudflare says 404 to a future round and an
        // unknown one alike.
        425 => Err(format!("round {round} is not published yet (HTTP 425)")),
        404 => Err(format!("round {round} was not found there (HTTP 404)")),
        _ => Err(format!("HTTP {status}: {}", body.trim().chars().take(160).collect::<String>())),
    }
}

/// Check a relay's answer for `round` (see the module docs).
pub fn check(round: i64, body: &str) -> Result<Beacon, String> {
    #[derive(serde::Deserialize)]
    struct Answer {
        round: i64,
        randomness: String,
        signature: String,
    }
    let answer: Answer = serde_json::from_str(body)
        .map_err(|error| format!("the answer is not a beacon ({error}): {}", body.chars().take(160).collect::<String>()))?;
    if answer.round != round {
        return Err(format!("asked for round {round}, got round {}", answer.round));
    }
    let randomness = answer.randomness.to_ascii_lowercase();
    let signature = answer.signature.to_ascii_lowercase();
    let random_bytes = hex_bytes(&randomness).filter(|b| b.len() == 32).ok_or("randomness is not 64 hex characters")?;
    let signature_bytes = hex_bytes(&signature).filter(|b| b.len() == 48).ok_or("signature is not 96 hex characters")?;
    if sha256(&signature_bytes).as_slice() != random_bytes.as_slice() {
        return Err("randomness is not the SHA-256 of the signature".to_string());
    }
    if !skip_signature_check() {
        verify_signature(round, &signature_bytes)?;
    }
    Ok(Beacon { round, randomness, signature })
}

/// The BLS check: `signature` is the chain's signature on `round`.
pub fn verify_signature(round: i64, signature: &[u8]) -> Result<(), String> {
    use drand_verify::{G2PubkeyRfc, Pubkey};
    let key: [u8; 96] = hex_bytes(PUBLIC_KEY_HEX)
        .and_then(|bytes| bytes.try_into().ok())
        .expect("PUBLIC_KEY_HEX is 96 bytes of hex");
    let key = G2PubkeyRfc::from_fixed(key).map_err(|error| format!("the chain public key is invalid: {error}"))?;
    let round = u64::try_from(round).map_err(|_| format!("round {round} is negative"))?;
    match key.verify(round, b"", signature) {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!("the signature does not verify for round {round} against quicknet's public key")),
        Err(error) => Err(format!("the signature could not be checked: {error}")),
    }
}

#[cfg(debug_assertions)]
fn skip_signature_check() -> bool {
    std::env::var("DEV_BEACON_SKIP_SIGNATURE_CHECK").is_ok_and(|value| value == "1")
}

#[cfg(not(debug_assertions))]
const fn skip_signature_check() -> bool {
    false
}

/// Lowercase or uppercase hex to bytes; None for anything else or an odd length.
pub fn hex_bytes(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| text.get(i..i + 2).and_then(|pair| u8::from_str_radix(pair, 16).ok()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round 1000 as every relay serves it (fetched 2026-11-24).
    const ROUND_1000: &str = r#"{"round":1000,"randomness":"fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd","signature":"b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39"}"#;

    #[test]
    fn round_numbers_follow_the_published_schedule() {
        assert_eq!(round_time(1), GENESIS);
        assert_eq!(round_time(1000), GENESIS + 999 * 3);
        assert_eq!(round_at_or_after(GENESIS - 100), 1);
        assert_eq!(round_at_or_after(GENESIS), 1);
        assert_eq!(round_at_or_after(GENESIS + 1), 2);
        assert_eq!(round_at_or_after(GENESIS + 3), 2);
        assert_eq!(round_at_or_after(GENESIS + 4), 3);
        // Friday 2026-11-20 09:35:00 MST = 16:35:00 UTC = 1795192500, which a round falls on exactly.
        let t = 1_795_192_500;
        assert_eq!(round_at_or_after(t), 34_129_712);
        assert_eq!(round_time(34_129_712), t);
        // A second later it is the next round, published two seconds after that.
        assert_eq!(round_at_or_after(t + 1), 34_129_713);
        assert_eq!(round_time(34_129_713), t + 3);
        for t in [t - 7, t - 1, t + 2, t + 5] {
            let r = round_at_or_after(t);
            assert!(round_time(r) >= t && round_time(r - 1) < t, "{t}");
        }
    }

    #[test]
    fn a_real_quicknet_beacon_checks_out() {
        let beacon = check(1000, ROUND_1000).expect("round 1000 verifies");
        assert_eq!(beacon.randomness, "fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd");
        // The same signature is not valid for any other round.
        let sig = hex_bytes(&beacon.signature).unwrap();
        assert!(verify_signature(1001, &sig).unwrap_err().contains("does not verify"));
    }

    /// Live: each public relay over real HTTPS (rustls) serves a round that verifies. Not part of
    /// `scripts/check.sh` (no network there); run with `cargo test --lib beacon -- --ignored`.
    #[tokio::test]
    #[ignore = "reaches the public drand relays"]
    async fn the_public_relays_serve_verified_rounds() {
        // Friday 2026-11-20 09:35:00 Denver.
        let round = round_at_or_after(1_795_192_500);
        for relay in DEFAULT_RELAYS {
            // SAFETY of the test: env is process-wide; this test runs alone with --ignored.
            unsafe { std::env::set_var(RELAYS_ENV, relay) };
            let beacon = fetch(round).await.unwrap_or_else(|e| panic!("{relay}: {e}"));
            assert_eq!(beacon.round, round, "{relay}");
        }
        unsafe { std::env::set_var(RELAYS_ENV, "https://api.drand.sh") };
        let future = fetch(round_at_or_after(crate::util::now_unix()) + 1000).await.unwrap_err();
        assert!(future.contains("is not published yet (HTTP 425)"), "{future}");
    }

    #[test]
    fn a_bad_beacon_is_refused_saying_why() {
        assert_eq!(check(1001, ROUND_1000).unwrap_err(), "asked for round 1001, got round 1000");
        let tampered = ROUND_1000.replace("fe290b", "fe290c");
        assert_eq!(check(1000, &tampered).unwrap_err(), "randomness is not the SHA-256 of the signature");
        assert!(check(1000, "not json").unwrap_err().starts_with("the answer is not a beacon"));
        let short = ROUND_1000.replace("5e39\"", "\"");
        assert_eq!(check(1000, &short).unwrap_err(), "signature is not 96 hex characters");
    }
}
