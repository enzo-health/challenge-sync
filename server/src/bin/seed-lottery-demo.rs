//! Fill the LOCAL development database with a crowd for the weekly lottery page, and exit.
//!
//! Run with `just seed-lottery-demo`. Opt-in only: the server never calls this (it lives in this
//! binary, not in the library), and it refuses any database but the local file `turso:linkedin.db`,
//! whatever the build.
//!
//! Everyone it creates is invented, in the local account's org, created on 2026-09-01, with no
//! password, no LinkedIn profile URL, and an `@local.test` email. Idempotent: members are found by
//! email and posts by URN, so running it again changes nothing.
//!
//! What it gives, weeks running Friday to Thursday in Denver time (named by their Friday):
//!   2026-11-13  40 entrants; 15 others in the audience (5 of them only reshared); 2 deleted
//!               members who posted and are in neither list
//!   2026-11-06  about 25 entrants
//!   2026-10-30  about 15 entrants (the week clocks fall back, 169 hours)
//!   2026-10-23  exactly 1 entrant (others only reshared)
//!   2026-10-16  no entrants (two reshares only)
//!   2026-11-20  the week after: 3 entrants so far
//!
//! It also creates a system admin to view the page as, since the local account is not one:
//! `lottery-admin@local.test` / `localpassword`.

use linkedin_challenge_server::auth::{hash_password, member_by_email};
use linkedin_challenge_server::lottery::{LotteryWeek, denver_offset, resolve_week};
use linkedin_challenge_server::models::{self, Member, Org, Post, PostSnapshot};
use linkedin_challenge_server::seed::{self, LOCAL_PASSWORD};
use linkedin_challenge_server::util::{new_bearer_token, now_unix, parse_date};
use toasty::Db;

const LOCAL_DATABASE: &str = "turso:linkedin.db";
const ADMIN_EMAIL: &str = "lottery-admin@local.test";
const HOUR: i64 = 3_600;
const DAY: i64 = 86_400;

/// Invented names. First and last names are paired by index, not taken from anyone real.
const FIRST: [&str; 57] = [
    "Avery", "Bram", "Celeste", "Dorian", "Elowen", "Fintan", "Greer", "Hollis", "Ines", "Jory",
    "Kestrel", "Linnea", "Maren", "Niall", "Odette", "Perrin", "Quilla", "Rowan", "Saoirse", "Tobin",
    "Una", "Vesper", "Wren", "Xavi", "Yara", "Zeke", "Amabel", "Bastian", "Cosima", "Dashiell",
    "Eira", "Florian", "Gemma", "Hugo", "Isolde", "Jasper", "Keziah", "Lucan", "Mirela", "Nico",
    "Orla", "Pascal", "Rhea", "Silas", "Tamsin", "Ulric", "Valka", "Wilder", "Ximena", "Yusuf",
    "Zinnia", "Anouk", "Bodhi", "Clio", "Desmond", "Esme", "Fabian",
];
const LAST: [&str; 19] = [
    "Ashgrove", "Brightwater", "Calloway", "Dunmore", "Ellery", "Fairbank", "Glenholt", "Hartwell",
    "Ironwood", "Juniper", "Kettering", "Larkspur", "Marchetti", "Northcott", "Oakhurst",
    "Pemberly", "Quarrington", "Redfern", "Stonebridge",
];

fn name(i: usize) -> String {
    format!("{} {}", FIRST[i], LAST[(i * 7 + i / 19) % LAST.len()])
}

fn week(friday: &str) -> LotteryWeek {
    // Any time after 2026-11-20 lets every week above resolve.
    resolve_week(Some(friday), parse_date("2027-01-01").unwrap()).expect("a valid demo week")
}

/// An instant inside `week`: `day` 0 = Friday … 6 = Thursday, at `hour` o'clock local (any hour
/// but 02:00 to 03:00, when the clocks change on a Sunday, day 2).
fn at(week: LotteryWeek, day: i64, hour: i64) -> i64 {
    let naive = week.starts_at + day * DAY + hour * HOUR;
    naive + denver_offset(week.starts_at) - denver_offset(naive)
}

struct Demo {
    db: Db,
    org_id: i64,
    created: usize,
}

impl Demo {
    async fn member(&mut self, i: usize) -> toasty::Result<i64> {
        let email = format!("lottery-demo-{i}@local.test");
        if let Some(member) = member_by_email(&mut self.db, &email).await? {
            return Ok(member.id);
        }
        let (_unused, token_hash) = new_bearer_token();
        let member = toasty::create!(Member {
            org_id: self.org_id,
            display_name: name(i),
            linkedin_urn: format!("pending:{email}"),
            public_identifier: "",
            profile_url: None,
            is_admin: false,
            is_system_admin: false,
            email: Some(email),
            password_hash: None,
            api_token_hash: token_hash,
            created_at: parse_date("2026-09-01").unwrap(),
        })
        .exec(&mut self.db)
        .await?;
        self.created += 1;
        Ok(member.id)
    }

    async fn post(&mut self, i: usize, key: &str, created_at: i64, is_repost: bool) -> toasty::Result<()> {
        let urn = format!("urn:li:activity:lottery-demo-{i}-{key}");
        if Post::filter_by_urn(&urn).first().exec(&mut self.db).await?.is_some() {
            return Ok(());
        }
        let member_id = self.member(i).await?;
        let post = toasty::create!(Post {
            member_id,
            urn: &urn,
            permalink: format!("https://www.linkedin.com/feed/update/{urn}/"),
            created_at,
            text_preview: Some(if is_repost {
                format!("{} reshared a post", name(i))
            } else {
                format!("{}'s post ({key})", name(i))
            }),
            image_urls_json: None,
            is_repost,
        })
        .exec(&mut self.db)
        .await?;
        let impressions = 150 + (i as i64 * 37 + created_at / DAY % 50) % 900;
        toasty::create!(PostSnapshot {
            post_id: post.id,
            captured_at: created_at + DAY,
            impressions: Some(impressions),
            reactions: Some(impressions / 40),
            comments: Some(impressions / 200),
            reposts: Some(impressions / 500),
            sends: None,
            saves: None,
            impressions_in_network: None,
            impressions_out_of_network: None,
            members_reached: None,
            profile_viewers_from_post: None,
            followers_from_post: None,
        })
        .exec(&mut self.db)
        .await?;
        self.created += 1;
        Ok(())
    }

    async fn delete(&mut self, i: usize, at: i64) -> toasty::Result<()> {
        let id = self.member(i).await?;
        let member = Member::filter_by_id(id).first().exec(&mut self.db).await?;
        if member.is_some_and(|member| member.deleted_at.is_none()) {
            toasty::update!(Member::filter_by_id(id) { deleted_at: Some(at) })
                .exec(&mut self.db)
                .await?;
            self.created += 1;
        }
        Ok(())
    }
}

#[tokio::main]
async fn main() {
    // No dotenv: nothing but the command line chooses the database.
    let url = std::env::var("DATABASE_URL").unwrap_or_default();
    if url != LOCAL_DATABASE {
        eprintln!(
            "refusing to seed lottery demo data: DATABASE_URL must be exactly {LOCAL_DATABASE:?} \
             (the local file database), got {url:?}. Run it with `just seed-lottery-demo`."
        );
        std::process::exit(2);
    }
    let mut db = models::connect().await;
    seed::seed_local_account(&mut db).await.expect("failed to seed the local account");
    let org = Org::filter_by_slug("local")
        .first()
        .exec(&mut db)
        .await
        .expect("failed to read the local org")
        .expect("the local org exists after seeding the local account");

    let mut demo = Demo { db, org_id: org.id, created: 0 };
    run(&mut demo).await.expect("failed to seed lottery demo data");
    println!(
        "lottery demo data ready ({} rows added): sign in as {ADMIN_EMAIL} / {LOCAL_PASSWORD} and open the lottery for the week of 2026-11-13 (Fri 13 to Thu 19 November)",
        demo.created
    );
}

async fn run(demo: &mut Demo) -> toasty::Result<()> {
    // The viewer: a system admin in the local org, since challenge pages are for system admins.
    if member_by_email(&mut demo.db, ADMIN_EMAIL).await?.is_none() {
        let (_unused, token_hash) = new_bearer_token();
        toasty::create!(Member {
            org_id: demo.org_id,
            display_name: "Lottery Admin",
            linkedin_urn: format!("pending:{ADMIN_EMAIL}"),
            public_identifier: "",
            profile_url: None,
            is_admin: true,
            is_system_admin: true,
            email: Some(ADMIN_EMAIL.to_string()),
            password_hash: Some(hash_password(LOCAL_PASSWORD)),
            api_token_hash: token_hash,
            created_at: now_unix(),
        })
        .exec(&mut demo.db)
        .await?;
        demo.created += 1;
    }

    // Everyone exists first, so the non-posters are in every week's audience.
    for i in 0..FIRST.len() {
        demo.member(i).await?;
    }

    // 2026-11-13: members 0..40 post (some two or three times, some also reshare); 40..45 only
    // reshare; 45..55 do not post; 55 and 56 post and are deleted.
    let main = week("2026-11-13");
    for i in 0..40 {
        let day = (i % 7) as i64;
        demo.post(i, "f1113a", at(main, day, 8 + (i as i64 * 3) % 11), false).await?;
        if i % 4 == 0 {
            demo.post(i, "f1113b", at(main, (day + 2) % 7, 12), false).await?;
        }
        if i % 9 == 0 {
            demo.post(i, "f1113c", at(main, (day + 4) % 7, 16), false).await?;
        }
        if i % 5 == 0 {
            demo.post(i, "f1113r", at(main, (day + 1) % 7, 10), true).await?;
        }
    }
    // The edges of the week: the last second of Thursday counts, the first of Friday does not.
    demo.post(6, "f1113-edge", main.ends_at - 1, false).await?;
    for i in 40..45 {
        demo.post(i, "f1113r", at(main, (i % 7) as i64, 9), true).await?;
    }
    for i in 55..57 {
        demo.post(i, "f1113a", at(main, 2, 11), false).await?;
        demo.delete(i, main.ends_at - 2 * DAY).await?;
    }

    // 2026-11-06: every other poster from above, plus some of the quiet ones.
    let w1106 = week("2026-11-06");
    for i in (0..40).step_by(2).chain(45..50) {
        demo.post(i, "f1106", at(w1106, (i % 5) as i64, 9 + (i as i64 % 8)), false).await?;
    }
    demo.post(47, "f1120-edge", main.ends_at, false).await?; // Friday 00:00, the week after

    // 2026-10-30, the week the clocks fall back.
    let w1030 = week("2026-10-30");
    for i in (1..45).step_by(3) {
        demo.post(i, "f1030", at(w1030, (i % 6) as i64, 10), false).await?;
    }

    // 2026-10-23: one entrant; others only reshared.
    let w1023 = week("2026-10-23");
    demo.post(11, "f1023", at(w1023, 3, 9), false).await?;
    for i in [2, 20, 33] {
        demo.post(i, "f1023r", at(w1023, 1, 14), true).await?;
    }

    // 2026-10-16: no entrants, two reshares.
    let w1016 = week("2026-10-16");
    for i in [5, 18] {
        demo.post(i, "f1016r", at(w1016, 2, 13), true).await?;
    }

    // 2026-11-20, the week after: two more on Friday morning.
    let current = main.next();
    for i in [1, 22] {
        demo.post(i, "f1120", at(current, 0, 8), false).await?;
    }
    Ok(())
}
