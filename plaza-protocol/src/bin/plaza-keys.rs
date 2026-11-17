//! Dev helper for plaza pass keys (native only; reads /dev/urandom for keygen).
//!
//!   plaza-keys keygen                      print a new PRIVATE/PUBLIC pair as env lines
//!   plaza-keys public <private-b64>        print the public key for a private seed
//!   plaza-keys sign <private-b64> <member-id> <expires-at-unix>
//!                                          print a signed pass
//!   plaza-keys verify <public-b64> <pass> <now-unix>
//!                                          print the claims, or the error and exit 1

use plaza_protocol::pass;
use std::io::Read;
use std::process::ExitCode;

const USAGE: &str = "usage: plaza-keys keygen | public <private-b64> | sign <private-b64> <member-id> <expires-at-unix> | verify <public-b64> <pass> <now-unix>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match run(&args) {
        Ok(out) => {
            println!("{out}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("plaza-keys: {e}");
            ExitCode::FAILURE
        }
    }
}

fn key(arg: &str, which: &str) -> Result<[u8; 32], String> {
    pass::decode_key(arg).map_err(|e| format!("{which} key: {e}"))
}

fn int(arg: &str, what: &str) -> Result<i64, String> {
    arg.parse()
        .map_err(|_| format!("{what} {arg:?} is not an integer"))
}

fn run(args: &[&str]) -> Result<String, String> {
    match args {
        ["keygen"] => {
            let mut seed = [0u8; 32];
            std::fs::File::open("/dev/urandom")
                .and_then(|mut f| f.read_exact(&mut seed))
                .map_err(|e| format!("reading /dev/urandom: {e}"))?;
            Ok(format!(
                "PLAZA_PASS_PRIVATE_KEY={}\nPLAZA_PASS_PUBLIC_KEY={}",
                pass::encode_key(&seed),
                pass::encode_key(&pass::public_key_of(&seed))
            ))
        }
        ["public", private] => Ok(pass::encode_key(&pass::public_key_of(&key(
            private, "private",
        )?))),
        ["sign", private, member, exp] => Ok(pass::sign(
            &key(private, "private")?,
            int(member, "member id")?,
            int(exp, "expires-at")?,
        )),
        ["verify", public, p, now] => {
            let c = pass::verify(&key(public, "public")?, p, int(now, "now")?)
                .map_err(|e| format!("{} ({})", e, e.code()))?;
            Ok(format!("member {} until {}", c.member_id, c.expires_at))
        }
        _ => Err(USAGE.to_string()),
    }
}
