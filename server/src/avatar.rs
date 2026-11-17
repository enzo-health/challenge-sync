//! A member's own avatar on the lottery wheel (`/api/me/avatar`, and `avatar` on the lottery
//! entrants and audience).
//!
//! The allowed values live in `components/lottery/avatar-options.json`, the one file both the
//! React editor and this module read, so the two can never disagree on what a valid avatar is.
//! An avatar is a flat object: `v` plus one string per list in that file, each of which must be
//! one of the listed values exactly.
//!
//! **Versions.** The current version is the options file's `version`, and every avatar this
//! module returns or stores is in it. One older version is still accepted, on save and on read:
//! v1, which predates `facialHair`. A v1 avatar has every current field except `facialHair`; its
//! values are checked against the current lists (v2 only added values, so every v1 value is still
//! listed), and it is upgraded with `facialHair: "none"`. Stored v1 rows are therefore never
//! migrated: they are upgraded each time they are read.
//!
//! Stored as canonical JSON in `members.avatar_json`; `None` means the member never saved one
//! and the client draws the look generated from their id.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use utoipa::ToSchema;

use crate::models::Member;

/// The options file, read at compile time.
const OPTIONS_JSON: &str = include_str!("../components/lottery/avatar-options.json");

/// Every avatar field other than `v` in the current version, in the order the struct declares
/// them (and errors list them). A unit test keeps this, the struct and the options file in step.
pub const FIELDS: [&str; 13] = [
    "skin", "outfit", "accent", "hairColor", "hair", "facialHair", "hat", "ears", "eyes", "brows",
    "nose", "mouth", "build",
];

/// The one older version still accepted. It differs from the current one only in having no
/// `facialHair` field (added in v2, together with more `hair` values); see the module docs.
pub const LEGACY_VERSION: u64 = 1;
/// The field a v1 avatar does not have, and the value it is upgraded with.
const NOT_IN_LEGACY: &str = "facialHair";
const LEGACY_UPGRADE_VALUE: &str = "none";

/// The parsed options file: its `version` and, per field, the allowed values.
pub struct AvatarOptions {
    pub version: u64,
    pub values: BTreeMap<String, Vec<String>>,
}

pub static OPTIONS: LazyLock<AvatarOptions> = LazyLock::new(|| {
    let raw: BTreeMap<String, Value> =
        serde_json::from_str(OPTIONS_JSON).expect("avatar-options.json is not a JSON object");
    let mut version = None;
    let mut values = BTreeMap::new();
    for (key, value) in raw {
        if key == "version" {
            version = Some(value.as_u64().expect("avatar-options.json: version must be a whole number"));
            continue;
        }
        let list: Vec<String> = serde_json::from_value(value)
            .unwrap_or_else(|e| panic!("avatar-options.json: {key} must be a list of strings: {e}"));
        values.insert(key, list);
    }
    AvatarOptions {
        version: version.expect("avatar-options.json has no version"),
        values,
    }
});

/// A member's saved avatar, always in the current version. Each string is one of the values
/// listed for it in `components/lottery/avatar-options.json` (colours as lowercase `#rrggbb`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Avatar {
    /// The options file's `version` (currently 2). A save may also send a v1 avatar, which has no
    /// `facialHair`; it comes back upgraded to the current version with `facialHair: "none"`.
    pub v: u64,
    pub skin: String,
    pub outfit: String,
    pub accent: String,
    pub hair_color: String,
    pub hair: String,
    pub facial_hair: String,
    pub hat: String,
    pub ears: String,
    pub eyes: String,
    pub brows: String,
    pub nose: String,
    pub mouth: String,
    pub build: String,
}

/// `GET`/`PUT`/`DELETE /api/me/avatar`: the signed-in member's avatar, or null when they have
/// none saved (the client then draws the look generated from their id).
#[derive(Debug, Serialize, ToSchema)]
pub struct MyAvatar {
    #[schema(required = true)]
    pub avatar: Option<Avatar>,
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

/// The fields (other than `v`) of an avatar of `version`, or None for an unsupported version.
fn fields_of(version: u64) -> Option<Vec<&'static str>> {
    if version == OPTIONS.version {
        Some(FIELDS.to_vec())
    } else if version == LEGACY_VERSION {
        Some(FIELDS.into_iter().filter(|field| *field != NOT_IN_LEGACY).collect())
    } else {
        None
    }
}

/// Check an avatar (a request body or a stored row) against the options file and return it in
/// the current version. Every problem found is reported, joined with "; ", each naming the field
/// and what was wrong with it.
pub fn validate(value: &Value) -> Result<Avatar, String> {
    let options = &*OPTIONS;
    let Value::Object(map) = value else {
        return Err(format!("an avatar must be a JSON object, got {}", kind(value)));
    };
    let mut problems = Vec::new();

    let version = match map.get("v") {
        None => None,
        Some(v) => match v.as_u64().filter(|v| fields_of(*v).is_some()) {
            Some(v) => Some(v),
            None => {
                problems.push(format!(
                    "unsupported avatar version: v must be {LEGACY_VERSION} or {}, got {v}",
                    options.version,
                ));
                None
            }
        },
    };
    // Without a usable `v`, the field set is unknown: check only what both versions agree on.
    let fields = version.and_then(fields_of);
    let expected: Vec<&str> = match &fields {
        Some(fields) => fields.clone(),
        None => FIELDS.into_iter().filter(|field| *field != NOT_IN_LEGACY).collect(),
    };
    let allowed_keys: Vec<&str> = match &fields {
        Some(fields) => fields.clone(),
        None => FIELDS.to_vec(),
    };

    if version == Some(LEGACY_VERSION) && map.contains_key(NOT_IN_LEGACY) {
        problems.push(format!(
            "{NOT_IN_LEGACY} is not a field of a v{LEGACY_VERSION} avatar (it was added in v{}); \
             send v {} to set it",
            options.version, options.version,
        ));
    }
    let unknown: Vec<&str> = map
        .keys()
        .map(String::as_str)
        .filter(|key| *key != "v" && !allowed_keys.contains(key))
        .filter(|key| !(version == Some(LEGACY_VERSION) && *key == NOT_IN_LEGACY))
        .collect();
    if !unknown.is_empty() {
        let shape = match version {
            Some(v) => format!("a v{v} avatar has exactly the fields v, {}", allowed_keys.join(", ")),
            None => format!("an avatar has exactly the fields v, {}", FIELDS.join(", ")),
        };
        problems.push(format!("unknown field{} {}; {shape}", plural(unknown.len()), unknown.join(", ")));
    }
    let missing: Vec<&str> = std::iter::once("v")
        .chain(expected.iter().copied())
        .filter(|key| !map.contains_key(*key))
        .collect();
    if !missing.is_empty() {
        problems.push(format!("missing field{} {}", plural(missing.len()), missing.join(", ")));
    }

    for field in &expected {
        let Some(value) = map.get(*field) else { continue };
        let Value::String(text) = value else {
            problems.push(format!("{field} must be a string, got {} ({value})", kind(value)));
            continue;
        };
        let allowed = &options.values[*field];
        if !allowed.iter().any(|option| option == text) {
            problems.push(format!(
                "{field} {text:?} is not an allowed value; allowed: {}",
                allowed.join(", "),
            ));
        }
    }

    if !problems.is_empty() {
        return Err(problems.join("; "));
    }
    Ok(upgrade(map))
}

/// Build the current-version avatar from a validated object (every expected field present and a
/// string; a v1 object gets `facialHair: "none"`).
fn upgrade(map: &Map<String, Value>) -> Avatar {
    let get = |field: &str| match map.get(field) {
        Some(Value::String(text)) => text.clone(),
        _ if field == NOT_IN_LEGACY => LEGACY_UPGRADE_VALUE.to_string(),
        _ => unreachable!("validate checked {field} is present and a string"),
    };
    Avatar {
        v: OPTIONS.version,
        skin: get("skin"),
        outfit: get("outfit"),
        accent: get("accent"),
        hair_color: get("hairColor"),
        hair: get("hair"),
        facial_hair: get("facialHair"),
        hat: get("hat"),
        ears: get("ears"),
        eyes: get("eyes"),
        brows: get("brows"),
        nose: get("nose"),
        mouth: get("mouth"),
        build: get("build"),
    }
}

/// Read back a stored `avatar_json`, applying the same rules as a save (the options file may have
/// changed since) and upgrading a v1 row to the current version.
pub fn parse_stored(json: &str) -> Result<Avatar, String> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("stored avatar is not valid JSON: {e}"))?;
    validate(&value)
}

/// The member's saved avatar, or None when there is none or the stored one no longer validates;
/// the latter is logged with the member id and the reason.
pub fn member_avatar(member: &Member) -> Option<Avatar> {
    let json = member.avatar_json.as_deref()?;
    match parse_stored(json) {
        Ok(avatar) => Some(avatar),
        Err(reason) => {
            tracing::warn!(member_id = member.id, %reason, "stored avatar is invalid; treating it as unset");
            None
        }
    }
}

/// The canonical stored form of a validated avatar (always the current version).
pub fn to_stored(avatar: &Avatar) -> String {
    serde_json::to_string(avatar).expect("an Avatar always serializes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeSet;

    fn sample() -> Value {
        json!({ "v": 2, "skin": "#ffe8d6", "outfit": "#ff4d6d", "accent": "#ffffff",
                "hairColor": "#2b1d3a", "hair": "sidepart", "facialHair": "goatee", "hat": "none",
                "ears": "round", "eyes": "dot", "brows": "none", "nose": "none", "mouth": "smile",
                "build": "signature" })
    }

    /// A v1 avatar as v1 clients saved it: no `facialHair`.
    fn sample_v1() -> Value {
        json!({ "v": 1, "skin": "#ffe8d6", "outfit": "#ff4d6d", "accent": "#ffffff",
                "hairColor": "#2b1d3a", "hair": "bob", "hat": "none", "ears": "round",
                "eyes": "dot", "brows": "none", "nose": "none", "mouth": "smile",
                "build": "signature" })
    }

    #[test]
    fn options_lists_are_non_empty_and_distinct() {
        // A version bump past 2 must revisit LEGACY_VERSION and what it lacks.
        assert_eq!(OPTIONS.version, 2);
        for (field, values) in &OPTIONS.values {
            assert!(!values.is_empty(), "{field} has no values");
            let distinct: BTreeSet<&String> = values.iter().collect();
            assert_eq!(distinct.len(), values.len(), "{field} lists a value twice");
        }
    }

    #[test]
    fn v1_values_are_all_still_listed() {
        // The upgrade value must be valid, and every hair style v1 offered must still be listed,
        // or stored v1 rows would stop validating.
        assert!(OPTIONS.values[NOT_IN_LEGACY].iter().any(|v| v == LEGACY_UPGRADE_VALUE));
        for hair in ["none", "buzz", "bob", "spiky", "mohawk", "bun", "pigtails", "curly", "swoop", "long"] {
            assert!(OPTIONS.values["hair"].iter().any(|v| v == hair), "v1 hair {hair} is gone");
        }
    }

    #[test]
    fn struct_fields_match_the_options_file() {
        let from_file: BTreeSet<&str> = OPTIONS.values.keys().map(String::as_str).collect();
        let declared: BTreeSet<&str> = FIELDS.into_iter().collect();
        assert_eq!(from_file, declared);
        let avatar = validate(&sample()).unwrap();
        let Value::Object(serialized) = serde_json::to_value(&avatar).unwrap() else { panic!() };
        let keys: BTreeSet<&str> = serialized.keys().map(String::as_str).collect();
        let expected: BTreeSet<&str> = std::iter::once("v").chain(FIELDS).collect();
        assert_eq!(keys, expected);
    }

    #[test]
    fn a_v2_avatar_round_trips() {
        let avatar = validate(&sample()).unwrap();
        assert_eq!((avatar.hair.as_str(), avatar.facial_hair.as_str()), ("sidepart", "goatee"));
        assert_eq!(parse_stored(&to_stored(&avatar)).unwrap(), avatar);
        assert_eq!(serde_json::to_value(&avatar).unwrap(), sample());
    }

    #[test]
    fn a_v1_avatar_is_upgraded() {
        let avatar = validate(&sample_v1()).unwrap();
        let mut expected = sample_v1();
        expected["v"] = json!(2);
        expected["facialHair"] = json!("none");
        assert_eq!(serde_json::to_value(&avatar).unwrap(), expected);
        assert_eq!(parse_stored(&sample_v1().to_string()).unwrap(), avatar);
    }

    #[test]
    fn a_v1_avatar_with_facial_hair_is_refused() {
        let mut body = sample_v1();
        body["facialHair"] = json!("goatee");
        assert_eq!(
            validate(&body).unwrap_err(),
            "facialHair is not a field of a v1 avatar (it was added in v2); send v 2 to set it"
        );
    }

    #[test]
    fn every_listed_value_is_accepted() {
        for (field, values) in &OPTIONS.values {
            for value in values {
                let mut body = sample();
                body[field.as_str()] = json!(value);
                validate(&body).unwrap_or_else(|e| panic!("{field}={value}: {e}"));
            }
        }
    }

    #[test]
    fn rejects_a_non_object() {
        assert_eq!(validate(&json!([1])).unwrap_err(), "an avatar must be a JSON object, got an array");
        assert_eq!(validate(&Value::Null).unwrap_err(), "an avatar must be a JSON object, got null");
    }

    #[test]
    fn names_unknown_and_missing_keys() {
        let mut body = sample();
        body["memberId"] = json!(7);
        body.as_object_mut().unwrap().remove("hat");
        body.as_object_mut().unwrap().remove("facialHair");
        let error = validate(&body).unwrap_err();
        assert!(error.starts_with("unknown field memberId; a v2 avatar has exactly the fields v, skin,"), "{error}");
        assert!(error.ends_with("missing fields facialHair, hat"), "{error}");

        // Without v, only the fields both versions share are required.
        let mut body = sample_v1();
        body.as_object_mut().unwrap().remove("v");
        body.as_object_mut().unwrap().remove("hat");
        assert_eq!(validate(&body).unwrap_err(), "missing fields v, hat");
    }

    #[test]
    fn rejects_wrong_version_type_and_value() {
        let mut body = sample();
        body["v"] = json!(3);
        assert_eq!(validate(&body).unwrap_err(), "unsupported avatar version: v must be 1 or 2, got 3");
        body["v"] = json!("2");
        assert_eq!(validate(&body).unwrap_err(), "unsupported avatar version: v must be 1 or 2, got \"2\"");

        let mut body = sample();
        body["hair"] = json!(3);
        assert_eq!(validate(&body).unwrap_err(), "hair must be a string, got a number (3)");

        let mut body = sample();
        body["hair"] = json!("afro");
        body["skin"] = json!("#FFE8D6");
        let error = validate(&body).unwrap_err();
        assert!(error.contains("skin \"#FFE8D6\" is not an allowed value; allowed: #ffe8d6,"), "{error}");
        assert!(error.contains("hair \"afro\" is not an allowed value; allowed: none, crew, buzz,"), "{error}");

        let mut body = sample();
        body["facialHair"] = json!("mutton");
        assert_eq!(
            validate(&body).unwrap_err(),
            "facialHair \"mutton\" is not an allowed value; allowed: none, stubble, moustache, goatee, shortbeard, fullbeard"
        );
    }

    #[test]
    fn parse_stored_explains_bad_json() {
        assert!(parse_stored("{").unwrap_err().starts_with("stored avatar is not valid JSON: "));
    }
}
