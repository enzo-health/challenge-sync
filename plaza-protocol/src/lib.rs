//! The plaza's shared contract: the signed pass the server hands out, the JSON messages the room
//! and the browser page exchange, and the room's pure rules (clamping, chat cleaning, rate limits,
//! high fives). Compiled natively by `server/` and for `wasm32-unknown-unknown` by `plaza/`, so
//! nothing here reads a clock or an RNG: time is always a parameter.

pub mod msg;
pub mod pass;
pub mod rules;

/// World size in plaza units. Positions are clamped to `0..=WORLD_W` and `0..=WORLD_H`.
pub const WORLD_W: f32 = 2000.0;
pub const WORLD_H: f32 = 1200.0;

/// Sustained `move` messages per second per connection; extra moves are silently dropped.
pub const MOVES_PER_SEC: u32 = 15;
/// Moves that may arrive back to back before the sustained rate applies.
pub const MOVE_BURST: u32 = 5;
/// Sustained `jump` messages per second per connection (burst the same).
pub const JUMPS_PER_SEC: u32 = 3;
/// One chat message per this many milliseconds, sustained.
pub const CHAT_INTERVAL_MS: u32 = 1500;
/// Chat messages that may be sent back to back before `chat_too_fast`.
pub const CHAT_BURST: u32 = 3;
/// Longest chat message, in Unicode scalar values, after cleaning.
pub const CHAT_MAX_CHARS: usize = 80;

/// Two members high-five when both jump within this window and stand within this distance.
pub const HIGH_FIVE_DISTANCE: f32 = 140.0;
pub const HIGH_FIVE_WINDOW_MS: u32 = 700;

/// Text frames larger than this are ignored.
pub const MAX_FRAME_BYTES: usize = 1024;
/// Longest pass `pass::verify` will look at; anything longer is malformed.
pub const MAX_PASS_BYTES: usize = 512;
/// A socket that has not sent a valid `hello` within this long is closed.
pub const HELLO_TIMEOUT_MS: u32 = 10_000;

/// WebSocket close codes the room uses.
pub const CLOSE_PASS_REJECTED: u16 = 4001;
pub const CLOSE_REPLACED: u16 = 4002;
pub const CLOSE_PROTOCOL: u16 = 4003;
/// The room cannot check passes because its own configuration is broken (not the client's fault).
pub const CLOSE_ROOM_MISCONFIGURED: u16 = 4004;
/// The socket never said hello in time.
pub const CLOSE_HELLO_TIMEOUT: u16 = 4005;

/// Machine codes carried in `{"t":"error","code":…}`.
pub mod codes {
    pub const PASS_MALFORMED: &str = "pass_malformed";
    pub const PASS_BAD_SIGNATURE: &str = "pass_bad_signature";
    pub const PASS_EXPIRED: &str = "pass_expired";
    pub const HELLO_REQUIRED: &str = "hello_required";
    pub const HELLO_TIMEOUT: &str = "hello_timeout";
    pub const REPLACED: &str = "replaced";
    pub const CHAT_TOO_LONG: &str = "chat_too_long";
    pub const CHAT_TOO_FAST: &str = "chat_too_fast";
    pub const ROOM_MISCONFIGURED: &str = "room_misconfigured";
}
