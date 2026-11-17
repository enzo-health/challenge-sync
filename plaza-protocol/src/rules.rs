//! The room's pure rules, kept here so they are unit-tested natively.

use crate::{
    CHAT_BURST, CHAT_INTERVAL_MS, CHAT_MAX_CHARS, HIGH_FIVE_DISTANCE, HIGH_FIVE_WINDOW_MS,
    JUMPS_PER_SEC, MOVES_PER_SEC, MOVE_BURST, WORLD_H, WORLD_W,
};

/// Clamps a (finite) position into the world.
pub fn clamp_position(x: f32, y: f32) -> (f32, f32) {
    (x.clamp(0.0, WORLD_W), y.clamp(0.0, WORLD_H))
}

/// Spawn spread around the centre, in plaza units each way.
pub const SPAWN_SPREAD: f32 = 200.0;

/// A spawn point near the centre. `r1`/`r2` are uniform in `[0, 1)` (the room passes
/// `Math.random()`); out-of-range or non-finite inputs still land inside the world.
pub fn spawn_position(r1: f64, r2: f64) -> (f32, f32) {
    let off = |r: f64| {
        let r = if r.is_finite() {
            r.clamp(0.0, 1.0)
        } else {
            0.5
        };
        ((r * 2.0 - 1.0) as f32) * SPAWN_SPREAD
    };
    clamp_position(WORLD_W / 2.0 + off(r1), WORLD_H / 2.0 + off(r2))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatError {
    /// Nothing left after trimming and dropping control characters.
    Empty,
    /// Longer than `CHAT_MAX_CHARS` Unicode scalar values after cleaning.
    TooLong { chars: usize },
}

impl std::fmt::Display for ChatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChatError::Empty => write!(f, "chat message is empty"),
            ChatError::TooLong { chars } => write!(
                f,
                "chat message is {chars} characters; the limit is {CHAT_MAX_CHARS}"
            ),
        }
    }
}

impl std::error::Error for ChatError {}

/// Drops control characters (newlines and tabs included), trims, and checks the length in
/// Unicode scalar values.
pub fn clean_chat(text: &str) -> Result<String, ChatError> {
    let cleaned: String = text.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim();
    let chars = cleaned.chars().count();
    if chars == 0 {
        return Err(ChatError::Empty);
    }
    if chars > CHAT_MAX_CHARS {
        return Err(ChatError::TooLong { chars });
    }
    Ok(cleaned.to_string())
}

/// A token bucket: holds up to `burst` tokens, refills `per_sec` tokens per second.
#[derive(Debug, Clone, PartialEq)]
pub struct RateLimiter {
    capacity: f64,
    refill_per_ms: f64,
    tokens: f64,
    last_ms: Option<f64>,
}

impl RateLimiter {
    /// Starts full.
    pub fn new(per_sec: f64, burst: u32) -> Self {
        let capacity = f64::from(burst.max(1));
        RateLimiter {
            capacity,
            refill_per_ms: per_sec / 1000.0,
            tokens: capacity,
            last_ms: None,
        }
    }

    pub fn moves() -> Self {
        Self::new(f64::from(MOVES_PER_SEC), MOVE_BURST)
    }

    pub fn jumps() -> Self {
        Self::new(f64::from(JUMPS_PER_SEC), JUMPS_PER_SEC)
    }

    pub fn chats() -> Self {
        Self::new(1000.0 / f64::from(CHAT_INTERVAL_MS), CHAT_BURST)
    }

    /// Takes one token if there is one. A clock that goes backwards refills nothing.
    pub fn try_take(&mut self, now_ms: f64) -> bool {
        if let Some(last) = self.last_ms {
            let elapsed = (now_ms - last).max(0.0);
            if elapsed.is_finite() {
                self.tokens = (self.tokens + elapsed * self.refill_per_ms).min(self.capacity);
            }
        }
        if self.last_ms.is_none_or(|last| now_ms > last) {
            self.last_ms = Some(now_ms);
        }
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Another member as the high-five rule sees them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Jumper {
    pub id: i64,
    pub x: f32,
    pub y: f32,
    /// When they last jumped without it already being used up by a high five.
    pub last_jump_ms: Option<f64>,
}

/// "A jumps; if another online member B jumped within the last `HIGH_FIVE_WINDOW_MS` and is
/// within `HIGH_FIVE_DISTANCE`, that is a high five between A and B." When several qualify, the
/// nearest wins (ties: the most recent jump). The caller then clears both members' pending jump,
/// so one jump high-fives at most once.
pub fn high_five_partner(
    me: i64,
    my_pos: (f32, f32),
    now_ms: f64,
    others: impl IntoIterator<Item = Jumper>,
) -> Option<i64> {
    let window = f64::from(HIGH_FIVE_WINDOW_MS);
    let mut best: Option<(f32, f64, i64)> = None;
    for o in others {
        if o.id == me {
            continue;
        }
        let Some(t) = o.last_jump_ms else { continue };
        let age = now_ms - t;
        if !(0.0..=window).contains(&age) {
            continue;
        }
        let d = ((o.x - my_pos.0).powi(2) + (o.y - my_pos.1).powi(2)).sqrt();
        if d > HIGH_FIVE_DISTANCE {
            continue;
        }
        let better = match best {
            None => true,
            Some((bd, bt, _)) => d < bd || (d == bd && t > bt),
        };
        if better {
            best = Some((d, t, o.id));
        }
    }
    best.map(|(_, _, id)| id)
}

/// Whether a WebSocket upgrade from `origin` is allowed. `allowed_csv` is a comma-separated list
/// of exact origins (whitespace around entries ignored). With `allow_localhost_any_port` (a dev
/// switch), `http://localhost[:port]` and `http://127.0.0.1[:port]` are accepted too.
pub fn origin_allowed(origin: &str, allowed_csv: &str, allow_localhost_any_port: bool) -> bool {
    if origin.is_empty() {
        return false;
    }
    if allowed_csv
        .split(',')
        .map(str::trim)
        .any(|a| !a.is_empty() && a == origin)
    {
        return true;
    }
    if allow_localhost_any_port {
        for host in ["http://localhost", "http://127.0.0.1"] {
            if let Some(rest) = origin.strip_prefix(host) {
                if rest.is_empty() {
                    return true;
                }
                if let Some(port) = rest.strip_prefix(':') {
                    return !port.is_empty()
                        && port.len() <= 5
                        && port.bytes().all(|b| b.is_ascii_digit())
                        && port.parse::<u32>().is_ok_and(|p| (1..=65535).contains(&p));
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        let list = "http://localhost:3312, https://challenge.example.com";
        assert!(origin_allowed("http://localhost:3312", list, false));
        assert!(origin_allowed("https://challenge.example.com", list, false));
        assert!(!origin_allowed(
            "https://challenge.example.com.evil.net",
            list,
            false
        ));
        assert!(!origin_allowed("http://localhost:4000", list, false));
        assert!(!origin_allowed("", list, true));
        assert!(!origin_allowed("null", "", true));
        assert!(!origin_allowed("anything", "", false));
        // The dev switch.
        assert!(origin_allowed("http://localhost:4000", list, true));
        assert!(origin_allowed("http://127.0.0.1:54321", "", true));
        assert!(origin_allowed("http://localhost", "", true));
        assert!(!origin_allowed("http://localhost:0", "", true));
        assert!(!origin_allowed("http://localhost:99999", "", true));
        assert!(!origin_allowed("http://localhost:80.evil.net", "", true));
        assert!(!origin_allowed("http://localhost.evil.net", "", true));
        assert!(!origin_allowed("https://localhost:4000", "", true));
        assert!(!origin_allowed("http://localhost:", "", true));
    }

    #[test]
    fn clamping() {
        assert_eq!(clamp_position(-5.0, 99999.0), (0.0, WORLD_H));
        assert_eq!(clamp_position(2500.0, -1.0), (WORLD_W, 0.0));
        assert_eq!(clamp_position(10.0, 20.0), (10.0, 20.0));
    }

    #[test]
    fn spawn_is_near_the_centre() {
        for (a, b) in [(0.0, 0.0), (0.999, 0.999), (0.5, 0.5), (f64::NAN, 7.0)] {
            let (x, y) = spawn_position(a, b);
            assert!((x - WORLD_W / 2.0).abs() <= SPAWN_SPREAD, "{x}");
            assert!((y - WORLD_H / 2.0).abs() <= SPAWN_SPREAD, "{y}");
        }
    }

    #[test]
    fn chat_cleaning() {
        assert_eq!(clean_chat("  hello  ").unwrap(), "hello");
        assert_eq!(clean_chat("a\nb\tc\u{0}d\u{7f}").unwrap(), "abcd");
        assert_eq!(clean_chat(""), Err(ChatError::Empty));
        assert_eq!(clean_chat(" \n\t "), Err(ChatError::Empty));
        // 80 scalar values of a multi-byte character is fine; 81 is not.
        assert_eq!(clean_chat(&"é".repeat(80)).unwrap().chars().count(), 80);
        assert_eq!(
            clean_chat(&"é".repeat(81)),
            Err(ChatError::TooLong { chars: 81 })
        );
        // Control characters don't count towards the limit.
        assert!(clean_chat(&format!("{}\n\n\n", "a".repeat(80))).is_ok());
        assert_eq!(clean_chat("👋 hi").unwrap(), "👋 hi");
    }

    #[test]
    fn rate_limiter_allows_burst_then_rate() {
        let mut r = RateLimiter::new(10.0, 3);
        let t = 1_000_000.0;
        assert!(r.try_take(t) && r.try_take(t) && r.try_take(t));
        assert!(!r.try_take(t));
        assert!(!r.try_take(t + 50.0)); // half a token
        assert!(r.try_take(t + 100.0));
        assert!(!r.try_take(t + 100.0));
        // A long pause refills only up to the burst.
        let later = t + 60_000.0;
        assert!(r.try_take(later) && r.try_take(later) && r.try_take(later));
        assert!(!r.try_take(later));
    }

    #[test]
    fn rate_limiter_counts_a_blast() {
        // 100 moves over ~1s at 15/s with burst 5: about 20 get through.
        let mut r = RateLimiter::moves();
        let passed = (0..100)
            .filter(|i| r.try_take(f64::from(*i) * 10.0))
            .count();
        assert!((18..=22).contains(&passed), "{passed}");
    }

    #[test]
    fn rate_limiter_ignores_clock_going_backwards() {
        let mut r = RateLimiter::new(1.0, 1);
        assert!(r.try_take(5000.0));
        assert!(!r.try_take(1000.0));
        assert!(!r.try_take(5500.0));
        assert!(r.try_take(6000.0));
    }

    #[test]
    fn chat_limiter() {
        let mut r = RateLimiter::chats();
        assert!(r.try_take(0.0) && r.try_take(1.0) && r.try_take(2.0));
        assert!(!r.try_take(3.0));
        assert!(r.try_take(1503.0));
    }

    fn j(id: i64, x: f32, y: f32, t: Option<f64>) -> Jumper {
        Jumper {
            id,
            x,
            y,
            last_jump_ms: t,
        }
    }

    #[test]
    fn high_five_rule() {
        let now = 10_000.0;
        // Near and recent.
        assert_eq!(
            high_five_partner(
                1,
                (100.0, 100.0),
                now,
                [j(2, 200.0, 100.0, Some(now - 300.0))]
            ),
            Some(2)
        );
        // Exactly at the edges still counts.
        assert_eq!(
            high_five_partner(1, (0.0, 0.0), now, [j(2, 140.0, 0.0, Some(now - 700.0))]),
            Some(2)
        );
        // Too far.
        assert_eq!(
            high_five_partner(1, (0.0, 0.0), now, [j(2, 141.0, 0.0, Some(now))]),
            None
        );
        // Too long ago.
        assert_eq!(
            high_five_partner(1, (0.0, 0.0), now, [j(2, 10.0, 0.0, Some(now - 701.0))]),
            None
        );
        // Never jumped, or it is me.
        assert_eq!(
            high_five_partner(
                1,
                (0.0, 0.0),
                now,
                [j(2, 10.0, 0.0, None), j(1, 0.0, 0.0, Some(now))]
            ),
            None
        );
        // Nearest qualifying wins.
        assert_eq!(
            high_five_partner(
                1,
                (0.0, 0.0),
                now,
                [
                    j(2, 100.0, 0.0, Some(now)),
                    j(3, 50.0, 0.0, Some(now - 600.0)),
                    j(4, 10.0, 0.0, Some(now - 900.0))
                ]
            ),
            Some(3)
        );
    }
}
