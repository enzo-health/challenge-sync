//! JSON text frames between the browser page and the room, tagged on `"t"`.

use serde::{Deserialize, Serialize};

pub use crate::{
    codes, CHAT_MAX_CHARS, CLOSE_PASS_REJECTED, CLOSE_PROTOCOL, CLOSE_REPLACED, HIGH_FIVE_DISTANCE,
    HIGH_FIVE_WINDOW_MS, MAX_FRAME_BYTES, MOVES_PER_SEC, WORLD_H, WORLD_W,
};

/// Client → room. Unknown extra fields (say a client-sent `"id"`) are ignored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ClientMsg {
    /// Must be the first message on a connection.
    Hello {
        pass: String,
    },
    Move {
        x: f32,
        y: f32,
    },
    Jump,
    Chat {
        text: String,
    },
}

/// Someone already in the room, as listed in `welcome`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Presence {
    pub id: i64,
    pub x: f32,
    pub y: f32,
}

/// Room → client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ServerMsg {
    /// `online` excludes the recipient.
    Welcome {
        you: i64,
        x: f32,
        y: f32,
        online: Vec<Presence>,
    },
    Join {
        id: i64,
        x: f32,
        y: f32,
    },
    Leave {
        id: i64,
    },
    Move {
        id: i64,
        x: f32,
        y: f32,
    },
    Jump {
        id: i64,
    },
    Highfive {
        a: i64,
        b: i64,
    },
    Chat {
        id: i64,
        text: String,
    },
    Error {
        code: String,
        message: String,
    },
}

impl ServerMsg {
    pub fn error(code: &str, message: impl Into<String>) -> Self {
        ServerMsg::Error {
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("ServerMsg always serializes (positions are finite)")
    }
}

/// Why a client frame was ignored. The room drops these silently; the variants exist for tests
/// and for anyone debugging locally.
#[derive(Debug, Clone, PartialEq)]
pub enum FrameError {
    TooLarge { bytes: usize },
    NotAMessage(String),
    NonFinite,
}

/// Parses one client text frame: size cap, JSON shape, and finite coordinates.
pub fn parse_client(text: &str) -> Result<ClientMsg, FrameError> {
    if text.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge { bytes: text.len() });
    }
    let msg: ClientMsg =
        serde_json::from_str(text).map_err(|e| FrameError::NotAMessage(e.to_string()))?;
    if let ClientMsg::Move { x, y } = msg {
        if !x.is_finite() || !y.is_finite() {
            return Err(FrameError::NonFinite);
        }
    }
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(json: &str, msg: ClientMsg) {
        assert_eq!(parse_client(json).unwrap(), msg, "parsing {json}");
        assert_eq!(serde_json::to_string(&msg).unwrap(), json);
    }

    fn server(msg: ServerMsg, json: &str) {
        assert_eq!(msg.to_json(), json);
        assert_eq!(serde_json::from_str::<ServerMsg>(json).unwrap(), msg);
    }

    #[test]
    fn client_messages_match_the_wire() {
        client(
            r#"{"t":"hello","pass":"abc.def"}"#,
            ClientMsg::Hello {
                pass: "abc.def".into(),
            },
        );
        client(
            r#"{"t":"move","x":12.5,"y":3.0}"#,
            ClientMsg::Move { x: 12.5, y: 3.0 },
        );
        client(r#"{"t":"jump"}"#, ClientMsg::Jump);
        client(
            r#"{"t":"chat","text":"hi"}"#,
            ClientMsg::Chat { text: "hi".into() },
        );
    }

    #[test]
    fn server_messages_match_the_wire() {
        server(
            ServerMsg::Welcome {
                you: 7,
                x: 1000.0,
                y: 600.5,
                online: vec![Presence {
                    id: 3,
                    x: 1.0,
                    y: 2.0,
                }],
            },
            r#"{"t":"welcome","you":7,"x":1000.0,"y":600.5,"online":[{"id":3,"x":1.0,"y":2.0}]}"#,
        );
        server(
            ServerMsg::Join {
                id: 3,
                x: 1.0,
                y: 2.0,
            },
            r#"{"t":"join","id":3,"x":1.0,"y":2.0}"#,
        );
        server(ServerMsg::Leave { id: 3 }, r#"{"t":"leave","id":3}"#);
        server(
            ServerMsg::Move {
                id: 3,
                x: 4.0,
                y: 5.0,
            },
            r#"{"t":"move","id":3,"x":4.0,"y":5.0}"#,
        );
        server(ServerMsg::Jump { id: 3 }, r#"{"t":"jump","id":3}"#);
        server(
            ServerMsg::Highfive { a: 3, b: 4 },
            r#"{"t":"highfive","a":3,"b":4}"#,
        );
        server(
            ServerMsg::Chat {
                id: 3,
                text: "yo".into(),
            },
            r#"{"t":"chat","id":3,"text":"yo"}"#,
        );
        server(
            ServerMsg::error(codes::CHAT_TOO_FAST, "slow down"),
            r#"{"t":"error","code":"chat_too_fast","message":"slow down"}"#,
        );
    }

    #[test]
    fn integers_are_accepted_as_coordinates() {
        assert_eq!(
            parse_client(r#"{"t":"move","x":5,"y":6}"#).unwrap(),
            ClientMsg::Move { x: 5.0, y: 6.0 }
        );
    }

    #[test]
    fn client_sent_ids_are_ignored() {
        assert_eq!(
            parse_client(r#"{"t":"move","id":99,"x":1,"y":2}"#).unwrap(),
            ClientMsg::Move { x: 1.0, y: 2.0 }
        );
    }

    #[test]
    fn bad_frames_are_rejected() {
        assert!(matches!(
            parse_client("not json"),
            Err(FrameError::NotAMessage(_))
        ));
        assert!(matches!(
            parse_client(r#"{"t":"dance"}"#),
            Err(FrameError::NotAMessage(_))
        ));
        assert!(matches!(
            parse_client(r#"{"x":1}"#),
            Err(FrameError::NotAMessage(_))
        ));
        assert!(matches!(
            parse_client(r#"{"t":"move","x":"1","y":2}"#),
            Err(FrameError::NotAMessage(_))
        ));
        assert!(matches!(
            parse_client(r#"{"t":"move","x":null,"y":2}"#),
            Err(FrameError::NotAMessage(_))
        ));
        // 1e39 overflows f32 to infinity.
        assert_eq!(
            parse_client(r#"{"t":"move","x":1e39,"y":2}"#),
            Err(FrameError::NonFinite)
        );
        let big = format!(r#"{{"t":"chat","text":"{}"}}"#, "a".repeat(1100));
        assert!(matches!(
            parse_client(&big),
            Err(FrameError::TooLarge { .. })
        ));
    }
}
