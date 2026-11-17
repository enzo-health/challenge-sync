//! The plaza room: a Worker that checks the Origin and hands WebSocket upgrades to one Durable
//! Object (the room), which knows only who is connected and where they stand.
//!
//! The room uses the WebSocket Hibernation API: each socket's state (member id, position, last
//! jump) lives in its attachment, so it survives the object being evicted from memory. Rate-limit
//! buckets are in memory only and start full again after an eviction. Nothing is stored; chat is
//! relayed and never stored or logged, and passes are never logged.

use plaza_protocol::msg::{parse_client, ClientMsg, Presence, ServerMsg};
use plaza_protocol::rules::{
    clamp_position, clean_chat, high_five_partner, origin_allowed, spawn_position, ChatError,
    Jumper, RateLimiter,
};
use plaza_protocol::{codes, pass};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use worker::*;

const ROOM_NAME: &str = "plaza";
/// Sockets that have not said hello yet; beyond this, new upgrades get 503.
const MAX_PENDING: usize = 64;

fn now_ms() -> f64 {
    Date::now().as_millis() as f64
}

fn var(env: &Env, name: &str) -> Option<String> {
    env.var(name).ok().map(|v| v.to_string())
}

// --- the Worker: routing and the Origin check ----------------------------------------------------

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let origin = req.headers().get("Origin")?;
    let allowed_csv = var(&env, "PLAZA_ALLOWED_ORIGINS");
    let any_local_port = var(&env, "PLAZA_ALLOW_LOCALHOST_ANY_PORT").as_deref() == Some("1");
    let allowed = |o: &str| origin_allowed(o, allowed_csv.as_deref().unwrap_or(""), any_local_port);

    match (req.method(), req.path().as_str()) {
        (Method::Get, "/health") => {
            let ok = origin.as_deref().is_some_and(allowed);
            let mut res =
                Response::from_json(&serde_json::json!({ "ok": true, "originAllowed": ok }))?;
            res.headers_mut().set("Access-Control-Allow-Origin", "*")?;
            res.headers_mut().set("Cache-Control", "no-store")?;
            Ok(res)
        }
        (Method::Get, "/room") => {
            let upgrade = req.headers().get("Upgrade")?.unwrap_or_default();
            if !upgrade.eq_ignore_ascii_case("websocket") {
                return Response::error("/room only accepts WebSocket upgrades", 426);
            }
            match origin.as_deref() {
                None => {
                    return Response::error(
                        "origin not allowed: the request has no Origin header",
                        403,
                    )
                }
                Some(o) if !allowed(o) => {
                    let why = if allowed_csv.is_none() {
                        " (PLAZA_ALLOWED_ORIGINS is not set)"
                    } else {
                        ""
                    };
                    return Response::error(format!("origin not allowed: {o}{why}"), 403);
                }
                Some(_) => {}
            }
            let stub = env
                .durable_object("ROOM")?
                .id_from_name(ROOM_NAME)?
                .get_stub()?;
            stub.fetch_with_request(req).await
        }
        (_, "/health" | "/room") => Response::error("method not allowed", 405),
        _ => Response::error("not found", 404),
    }
}

// --- the room -------------------------------------------------------------------------------------

/// Per-socket state, kept as a JSON string in the socket's hibernation attachment (a string so
/// member ids beyond 2^53 survive; serde_wasm_bindgen would refuse them as numbers).
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Att {
    /// Random per-connection id, used to tell sockets apart.
    conn: String,
    connected_ms: f64,
    /// Set once `hello` verified a pass; never changed afterwards.
    member: Option<i64>,
    x: f32,
    y: f32,
    last_jump_ms: Option<f64>,
    /// A newer connection for the same member took over; this one is closing and is no longer
    /// anybody's presence.
    replaced: bool,
}

struct Limits {
    moves: RateLimiter,
    jumps: RateLimiter,
    chats: RateLimiter,
}

impl Limits {
    fn new() -> Self {
        Limits {
            moves: RateLimiter::moves(),
            jumps: RateLimiter::jumps(),
            chats: RateLimiter::chats(),
        }
    }
}

#[durable_object]
pub struct Room {
    state: State,
    env: Env,
    limits: RefCell<HashMap<String, Limits>>,
    /// Sockets whose close/error handler already ran (in case the runtime still lists them).
    closed: RefCell<HashSet<String>>,
}

fn att_of(ws: &WebSocket) -> Option<Att> {
    match ws.deserialize_attachment::<String>() {
        Ok(Some(s)) => match serde_json::from_str(&s) {
            Ok(a) => Some(a),
            Err(e) => {
                console_error!("room: socket attachment is not valid JSON: {e}");
                None
            }
        },
        Ok(None) => None,
        Err(e) => {
            console_error!("room: reading a socket attachment failed: {e}");
            None
        }
    }
}

fn save(ws: &WebSocket, att: &Att) {
    let json = serde_json::to_string(att).expect("attachment serializes");
    if let Err(e) = ws.serialize_attachment(json) {
        console_error!("room: writing a socket attachment failed: {e}");
    }
}

/// Sends, ignoring sockets that have gone away meanwhile.
fn send(ws: &WebSocket, msg: &ServerMsg) {
    let _ = ws.send_with_str(msg.to_json());
}

fn send_error_and_close(ws: &WebSocket, code: &str, message: String, close: u16) {
    send(ws, &ServerMsg::error(code, message));
    let _ = ws.close(Some(close), Some(code));
}

fn random_conn_id() -> String {
    let a = (js_sys::Math::random() * 4_294_967_296.0) as u64;
    let b = (js_sys::Math::random() * 4_294_967_296.0) as u64;
    format!("{a:08x}{b:08x}")
}

impl Room {
    fn hello_timeout_ms(&self) -> f64 {
        match var(&self.env, "PLAZA_HELLO_TIMEOUT_MS") {
            None => f64::from(plaza_protocol::HELLO_TIMEOUT_MS),
            Some(v) => match v.trim().parse::<u32>() {
                Ok(ms) if ms > 0 => f64::from(ms),
                _ => {
                    console_error!(
                        "room: PLAZA_HELLO_TIMEOUT_MS={v:?} is not a positive integer; using {}",
                        plaza_protocol::HELLO_TIMEOUT_MS
                    );
                    f64::from(plaza_protocol::HELLO_TIMEOUT_MS)
                }
            },
        }
    }

    /// Every socket the runtime still lists, with its attachment, minus ones already closed.
    fn sockets(&self) -> Vec<(WebSocket, Att)> {
        let all: Vec<(WebSocket, Att)> = self
            .state
            .get_websockets()
            .into_iter()
            .filter_map(|ws| att_of(&ws).map(|a| (ws, a)))
            .collect();
        let mut closed = self.closed.borrow_mut();
        // Forget sockets the runtime no longer lists, so the set stays small.
        closed.retain(|c| all.iter().any(|(_, a)| &a.conn == c));
        all.into_iter()
            .filter(|(_, a)| !closed.contains(&a.conn))
            .collect()
    }

    /// Authenticated, current presences (the only sockets that ever receive broadcasts).
    fn members(&self) -> Vec<(WebSocket, Att)> {
        self.sockets()
            .into_iter()
            .filter(|(_, a)| a.member.is_some() && !a.replaced)
            .collect()
    }

    fn broadcast(&self, msg: &ServerMsg, except_conn: Option<&str>) {
        let text = msg.to_json();
        for (ws, a) in self.members() {
            if Some(a.conn.as_str()) != except_conn {
                let _ = ws.send_with_str(&text);
            }
        }
    }

    /// Closes sockets that have not said hello within the timeout; returns the earliest deadline
    /// among the pending sockets that remain.
    fn reap_pending(&self, now: f64) -> Option<f64> {
        let timeout = self.hello_timeout_ms();
        let mut next: Option<f64> = None;
        for (ws, a) in self.sockets() {
            if a.member.is_some() {
                continue;
            }
            let deadline = a.connected_ms + timeout;
            if deadline <= now {
                self.closed.borrow_mut().insert(a.conn.clone());
                send_error_and_close(
                    &ws,
                    codes::HELLO_TIMEOUT,
                    format!("no hello within {} ms of connecting", timeout as u64),
                    plaza_protocol::CLOSE_HELLO_TIMEOUT,
                );
            } else {
                next = Some(next.map_or(deadline, |n: f64| n.min(deadline)));
            }
        }
        next
    }

    async fn ensure_alarm(&self, at_ms: f64) -> Result<()> {
        let storage = self.state.storage();
        if storage.get_alarm().await?.is_none() {
            let offset = (at_ms - now_ms()).max(50.0) as i64;
            storage.set_alarm(offset).await?;
        }
        Ok(())
    }

    fn on_hello(&self, ws: &WebSocket, mut att: Att, pass_text: &str) {
        let key = match var(&self.env, "PLAZA_PASS_PUBLIC_KEY") {
            None => Err("PLAZA_PASS_PUBLIC_KEY is not set".to_string()),
            Some(k) => pass::decode_key(&k).map_err(|e| format!("PLAZA_PASS_PUBLIC_KEY: {e}")),
        };
        let key = match key {
            Ok(k) => k,
            Err(why) => {
                console_error!("room: cannot check passes: {why}");
                self.closed.borrow_mut().insert(att.conn.clone());
                return send_error_and_close(
                    ws,
                    codes::ROOM_MISCONFIGURED,
                    format!("the room cannot check passes: {why}"),
                    plaza_protocol::CLOSE_ROOM_MISCONFIGURED,
                );
            }
        };
        let now = now_ms();
        let claims = match pass::verify(&key, pass_text, (now / 1000.0).floor() as i64) {
            Ok(c) => c,
            Err(e) => {
                self.closed.borrow_mut().insert(att.conn.clone());
                return send_error_and_close(
                    ws,
                    e.code(),
                    e.to_string(),
                    plaza_protocol::CLOSE_PASS_REJECTED,
                );
            }
        };
        let me = claims.member_id;

        // One live connection per member: the newest wins and keeps the old position, so the
        // others see no leave/join, only the same presence carrying on.
        let mut kept: Option<(f32, f32)> = None;
        for (old_ws, mut old) in self.members() {
            if old.member == Some(me) && old.conn != att.conn {
                kept = Some((old.x, old.y));
                old.replaced = true;
                save(&old_ws, &old);
                self.limits.borrow_mut().remove(&old.conn);
                send_error_and_close(
                    &old_ws,
                    codes::REPLACED,
                    "this member connected again elsewhere; this connection was replaced".into(),
                    plaza_protocol::CLOSE_REPLACED,
                );
            }
        }
        let (x, y) =
            kept.unwrap_or_else(|| spawn_position(js_sys::Math::random(), js_sys::Math::random()));
        att.member = Some(me);
        att.x = x;
        att.y = y;
        att.last_jump_ms = None;
        save(ws, &att);

        let online = self
            .members()
            .into_iter()
            .filter(|(_, a)| a.conn != att.conn)
            .filter_map(|(_, a)| a.member.map(|id| Presence { id, x: a.x, y: a.y }))
            .collect();
        send(
            ws,
            &ServerMsg::Welcome {
                you: me,
                x,
                y,
                online,
            },
        );
        if kept.is_none() {
            self.broadcast(&ServerMsg::Join { id: me, x, y }, Some(&att.conn));
        }
    }

    fn on_member_msg(&self, ws: &WebSocket, mut att: Att, me: i64, msg: ClientMsg) {
        let now = now_ms();
        let mut limits = self.limits.borrow_mut();
        let lim = limits.entry(att.conn.clone()).or_insert_with(Limits::new);
        match msg {
            ClientMsg::Hello { .. } => {} // already authenticated; the member id cannot change
            ClientMsg::Move { x, y } => {
                if !lim.moves.try_take(now) {
                    return;
                }
                drop(limits);
                let (x, y) = clamp_position(x, y);
                att.x = x;
                att.y = y;
                save(ws, &att);
                self.broadcast(&ServerMsg::Move { id: me, x, y }, Some(&att.conn));
            }
            ClientMsg::Jump => {
                if !lim.jumps.try_take(now) {
                    return;
                }
                drop(limits);
                let others: Vec<(WebSocket, Att)> = self
                    .members()
                    .into_iter()
                    .filter(|(_, a)| a.conn != att.conn)
                    .collect();
                let partner = high_five_partner(
                    me,
                    (att.x, att.y),
                    now,
                    others.iter().filter_map(|(_, a)| {
                        a.member.map(|id| Jumper {
                            id,
                            x: a.x,
                            y: a.y,
                            last_jump_ms: a.last_jump_ms,
                        })
                    }),
                );
                self.broadcast(&ServerMsg::Jump { id: me }, Some(&att.conn));
                match partner {
                    Some(b) => {
                        for (ows, mut o) in others {
                            if o.member == Some(b) {
                                o.last_jump_ms = None;
                                save(&ows, &o);
                            }
                        }
                        att.last_jump_ms = None;
                        save(ws, &att);
                        self.broadcast(&ServerMsg::Highfive { a: me, b }, None);
                    }
                    None => {
                        att.last_jump_ms = Some(now);
                        save(ws, &att);
                    }
                }
            }
            ClientMsg::Chat { text } => {
                let text = match clean_chat(&text) {
                    Ok(t) => t,
                    Err(ChatError::Empty) => return,
                    Err(e @ ChatError::TooLong { .. }) => {
                        return send(ws, &ServerMsg::error(codes::CHAT_TOO_LONG, e.to_string()))
                    }
                };
                if !lim.chats.try_take(now) {
                    return send(
                        ws,
                        &ServerMsg::error(
                            codes::CHAT_TOO_FAST,
                            format!(
                                "too many chat messages: at most {} in a row, then one every {} ms",
                                plaza_protocol::CHAT_BURST,
                                plaza_protocol::CHAT_INTERVAL_MS
                            ),
                        ),
                    );
                }
                drop(limits);
                self.broadcast(&ServerMsg::Chat { id: me, text }, Some(&att.conn));
            }
        }
    }

    fn on_gone(&self, ws: &WebSocket) {
        let Some(att) = att_of(ws) else { return };
        let first_time = self.closed.borrow_mut().insert(att.conn.clone());
        self.limits.borrow_mut().remove(&att.conn);
        if first_time && !att.replaced {
            if let Some(id) = att.member {
                // Only if no other live connection is this member (it never should be).
                if !self.members().iter().any(|(_, a)| a.member == Some(id)) {
                    self.broadcast(&ServerMsg::Leave { id }, Some(&att.conn));
                }
            }
        }
    }
}

impl DurableObject for Room {
    fn new(state: State, env: Env) -> Self {
        Room {
            state,
            env,
            limits: RefCell::new(HashMap::new()),
            closed: RefCell::new(HashSet::new()),
        }
    }

    async fn fetch(&self, _req: Request) -> Result<Response> {
        let now = now_ms();
        // Sockets past their hello deadline go now (the alarm also does this on its own).
        self.reap_pending(now);
        let pending = self
            .sockets()
            .iter()
            .filter(|(_, a)| a.member.is_none())
            .count();
        if pending >= MAX_PENDING {
            return Response::error(
                format!(
                    "{pending} connections are already waiting to say hello; try again shortly"
                ),
                503,
            );
        }
        let pair = WebSocketPair::new()?;
        self.state.accept_web_socket(&pair.server);
        let att = Att {
            conn: random_conn_id(),
            connected_ms: now,
            member: None,
            x: 0.0,
            y: 0.0,
            last_jump_ms: None,
            replaced: false,
        };
        save(&pair.server, &att);
        self.ensure_alarm(now + self.hello_timeout_ms()).await?;
        Response::from_websocket(pair.client)
    }

    async fn alarm(&self) -> Result<Response> {
        if let Some(next) = self.reap_pending(now_ms()) {
            self.ensure_alarm(next).await?;
        }
        Response::ok("")
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let WebSocketIncomingMessage::String(text) = message else {
            return Ok(());
        };
        let Some(att) = att_of(&ws) else {
            return Ok(());
        };
        if self.closed.borrow().contains(&att.conn) || att.replaced {
            return Ok(());
        }
        let Ok(msg) = parse_client(&text) else {
            return Ok(());
        };
        match (att.member, msg) {
            (Some(me), msg) => self.on_member_msg(&ws, att, me, msg),
            (None, ClientMsg::Hello { pass }) => self.on_hello(&ws, att, &pass),
            (None, _) => {
                self.closed.borrow_mut().insert(att.conn.clone());
                send_error_and_close(
                    &ws,
                    codes::HELLO_REQUIRED,
                    "the first message must be {\"t\":\"hello\",\"pass\":…}".into(),
                    plaza_protocol::CLOSE_PROTOCOL,
                );
            }
        }
        Ok(())
    }

    async fn websocket_close(
        &self,
        ws: WebSocket,
        code: usize,
        _reason: String,
        _clean: bool,
    ) -> Result<()> {
        self.on_gone(&ws);
        // Complete the closing handshake (a no-op if the runtime already replied).
        let code = u16::try_from(code)
            .ok()
            .filter(|c| *c == 1000 || (3000..5000).contains(c));
        let _ = ws.close(Some(code.unwrap_or(1000)), Some(""));
        Ok(())
    }

    async fn websocket_error(&self, ws: WebSocket, _error: Error) -> Result<()> {
        self.on_gone(&ws);
        Ok(())
    }
}
