# Extension-first auth

Status: built 2026-11-12, as described under "As built". The rest of this document is the
original proposal, kept for the reasoning.

## As built

- **No password.** A signed-out visitor sees a get-started page (`/auth/login`) with two steps:
  get the extension, and be logged in to LinkedIn. The page signs itself in when both are true.
- **One company join link**, `/join/<code>`. An admin generates the code on the All users page
  (`POST /api/system/join-link`) and it is stored in the database (`join_links`). Generating a
  new one replaces it, and the old link stops working for anyone who has not joined yet; people
  already signed in are unaffected. The `JOIN_CODE` environment variable is optional: when set, it
  is an extra fixed code that also works, for the tests and for letting the first people in before
  anyone has generated a link. The page stores the code in a `join_code` cookie; the extension
  reads it and presents it with the person's LinkedIn identity to `POST /api/auth/extension/join`,
  which creates the account on first use and signs in to it afterwards.
- **Website session from the extension.** `POST /api/auth/device/web-session` turns the device
  sync token into a session, and the extension writes the cookie into the browser itself.
- **Page to extension.** `extension/bridge.js` is a content script on the site that relays the
  get-started page's status question to the service worker. Only status flags cross the page.
- **How often the page asks** (`server/components/poll-schedule.ts`). The get-started page sends
  the extension a hello at once, then after 3, 3, 3, 5, 5, 10 and 10 seconds, then every 30
  seconds. It asks the site (`/api/auth/me`) when it opens, right after the extension replies
  "linked" (it has just written the session cookie), and otherwise once a minute. A hidden tab
  asks nothing; coming back to it, or the extension reporting something new, asks at once and
  starts the schedule over. Until 2026-11-13 it asked both every 3 seconds forever, hidden or not,
  which got the owner's network challenged by Vercel's DDoS mitigation (see "Host blocks" below).
  Idle, that is 8 hellos and 2 to 3 `/api/auth/me` in the first minute, then 2 and 1 a minute,
  instead of 20 and 20.
- **What the page says when sign-in has not happened**, one of exactly three things, so a
  screenshot tells them apart: no invite link in this browser ("You need your company's invite
  link"); the server refused the code ("This invite link isn't valid, or it has been replaced");
  or the specific failure the extension reported, in its own words with a small reason code (see
  "Failure categories" below). Invite messages need positive evidence: a refused code is only the
  server's `code: "join_code_invalid"`, never its English text and never a bare 403. Extensions
  before 0.1.4 reported refused codes, host blocks and outages alike as "needs invite", so with a
  code in the browser the page shows such a reply as "this older version doesn't say why"
  (`legacy-extension`); 0.1.3's own error text, which has no code, is shown labelled
  `extension-0.1.3`. The popup uses the same cases.
- **Failure categories** (`extension/errors.js` `describeError`, mirrored by the site). Every
  failure in the sign-in and sync path is sorted by what the evidence shows, with its own message
  and a short code shown in small print. Nothing falls back to "Error" or "Something went wrong".

  | Evidence | Code | Message |
  | --- | --- | --- |
  | `fetch` to our server threw (offline, DNS, refused connection) | `unreachable` | Can't reach the Challenge Sync server. Check your connection; we'll keep trying. |
  | no answer within 30 seconds | `timeout` | The Challenge Sync server didn't answer in time. We'll keep trying. |
  | host block: `x-vercel-mitigated`, any 429, a non-JSON 403 | `blocked` | Challenge Sync's host blocked this request for a moment (a security check on your network). We'll try again shortly. |
  | 5xx, JSON or not | `server-<status>` | Challenge Sync's server had a problem (500). We'll try again shortly. |
  | server refusal `join_code_required` | (needs invite) | the page's "You need your company's invite link" |
  | server refusal `join_code_invalid` | (invite refused) | This invite link isn't valid, or it has been replaced by a newer one. … |
  | server refusal `account_deleted` | `account_deleted` | This Challenge Sync account has been removed. Ask an admin to restore it. |
  | server refusal `sync_token_rejected` (after the session fallback failed) | `sync_token_rejected` | The server no longer accepts this browser's link to your account. Open the Challenge Sync site to sign in again. |
  | server refusal `session_expired` | (treated as no session: link from the join code instead) | — |
  | server refusal `admin_use_password` | `admin_use_password` | Admins sign in with their email and password on the Challenge Sync site (/auth/password). … |
  | server refusal `impersonation_session` | `impersonation_session` | You're viewing the Challenge Sync site as someone else ("View as"). Stop viewing as them, and Challenge Sync connects as you. |
  | server refusal `identity_required`, `linkedin_taken`, `already_linked` | that code | a sentence for each |
  | LinkedIn: no session cookie, or LinkedIn said 401/403 | `linkedin-signed-out` | You're not logged in to LinkedIn in this browser. … |
  | LinkedIn: another status | `linkedin-<status>` | Couldn't read your LinkedIn data (LinkedIn answered 999). … |
  | LinkedIn: `fetch` threw | `linkedin-unreachable` | Can't reach LinkedIn. … |
  | LinkedIn answered without the member's profile | `linkedin-profile` | LinkedIn answered, but without your profile. … |
  | the extension's worker didn't take the page's message | `extension-unavailable` | Challenge Sync is installed but its background worker didn't answer … Reload this page. |
  | anything thrown inside the extension | `extension-error` | Challenge Sync hit an internal error: <its message> |
  | none of the above (a 4xx with no known code) | `unexpected-<status>` | Unexpected response from the server (status 403, application/json, code …). |

  The server's codes are in `server/src/web.rs` (`codes`), on the `code` field of its JSON error
  body; the `error` text is kept for 0.1.3. An unexpected answer's server text is deliberately not
  shown: without a code it is not evidence, and an old message would read as an invite problem.
  On the site, a same-origin `/api/` request that gets no answer at all shows "Can't reach the
  Challenge Sync server" app-wide (`host-block.tsx`), separate from the host-block notice and
  cleared by the next answered request.
- **"Chrome paused Challenge Sync"** (`server/components/sync-paused.tsx`). Extension 0.1.3 asked
  for access to the new site address, so Chrome switched it off until its owner approved it. A
  page cannot tell "switched off" from "not installed", so pages ask with the bridge's hello and
  word themselves on the answer:
  - The get-started page says "Looking for the Challenge Sync extension…" and shows "Already had
    Challenge Sync? Chrome paused it." only after 10 seconds of silence (`NO_ANSWER_MS`); 0.1.3
    answers only after linking and minting a session, which can take several seconds, and the old
    2-second wait called working extensions paused. 0.1.4's bridge says "present" at once. Any
    answer removes the notice at once. A tab left unanswered reloads once when its owner comes
    back to it, since Chrome injects the bridge only into pages loaded after re-enabling.
  - The signed-in banner (every page, when `/api/auth/me` says `syncStale`: no sync in 48 hours):

    | Extension's answer | Banner |
    | --- | --- |
    | none yet (up to 10 s) | "Your stats haven't synced …" / Checking whether Challenge Sync is running in this browser… |
    | none | "Chrome paused Challenge Sync" + Re-enable the extension |
    | worker didn't answer (0.1.4) | "Challenge Sync didn't answer" + reason + Re-enable |
    | 0.1.4, sync started or running | "Syncing your stats…" |
    | LinkedIn logged out | "Challenge Sync is on, but you're not logged in to LinkedIn" |
    | last attempt failed (0.1.4) | "Challenge Sync is on, but its last sync failed": the category message, Sync now, reason code |
    | otherwise (0.1.3 always) | "Challenge Sync is on but hasn't synced yet" / Click the Challenge Sync icon in your browser's toolbar and press Sync now. |

    Its hello says `signedIn`, so 0.1.4 leaves the working session cookie alone (a signed-in hello
    costs 0.1.4 no request to our server). Hellos follow the get-started schedule and stop at the
    first answer (0.1.4 reporting a sync running is asked again every 30 seconds). While it shows
    and the tab is visible it re-asks `/api/auth/me` after 30 seconds, then every 60
    (`BANNER_ME_DELAYS_MS`), so it clears by itself soon after a sync lands; nothing while hidden.
- **The sync alarm** (`extension/background.js`). Armed on install and browser start as before,
  and now also on every service worker start if it is missing (`chrome.alarms.get`, then create;
  an armed alarm is left alone). Headless Chromium 155 showed that disabling and re-enabling an
  extension (`chrome.management.setEnabled`) keeps its alarms and does not fire `onInstalled`; the
  permission-increase update path itself could not be reproduced with an unpacked build, so this
  covers it whatever Chrome does there. `chrome.management.onEnabled` would need the
  "management" permission, a new prompt for everyone, so it is not used.
- **Visits start a due sync** (0.1.4). A hello from the site or opening the popup, for an
  already-linked extension whose automatic sync is due (`msUntilSyncAllowed() === 0`), starts an
  unattended sync (so the 12-hour floor and the request delays hold), one at a time however many
  hellos arrive; after a failed one another visit waits 15 minutes. 0.1.3 never syncs because of a
  hello, which is why its banner points at "Sync now".
- **Host blocks.** Vercel's automatic DDoS mitigation can put an IP under a "challenge" for some
  minutes: every request gets 403, an HTML page and `x-vercel-mitigated: challenge` from Vercel,
  never reaching our server. A page load lets the browser pass it; a fetch, and the extension's
  service worker, cannot.
  - Site (`server/components/host-block.tsx`, installed from `app/layout.tsx`): one wrapper
    around `window.fetch` turns a blocked same-origin `/api/` response (that header, any 429, or
    an HTML 403) into a `HostBlockedError` for every generated query and mutation. The app shows
    one notice with a Reload button ("Our host paused requests from your network for a moment")
    instead of each page's "could not be saved, try again", and React Query does not retry a
    blocked query. The get-started page reloads itself once on a blocked `/api/auth/me` (guarded
    by `sessionStorage` against loops), then shows the notice and stops polling.
  - Extension (0.1.4, `extension/api.js` `isBlocked`, `extension/sync.js` `reach`): the same
    test, plus any 403 whose body is not JSON. A blocked call throws `BlockedError` ("Challenge
    Sync's host blocked this request for a moment …"), which is never "needs invite", never
    "token rejected" (no re-link, no token replaced) and never "signed out". After a block the
    extension backs off, 30 seconds doubling to 10 minutes, during which calls fail without a
    request and LinkedIn is not read for a join or sync that cannot land.
  - The extension does not send cookies (`credentials: "include"`) to carry the browser's
    challenge clearance; see the comment in `extension/sync.js`.
- **Admins.** The system-admin flag is "admin". An admin can grant or remove it for others from
  the All users page, which also shows, generates and replaces the join link. The first admin is set in the database.
- **Kept:** the email and password login, at `/auth/password`, for accounts that have one. The
  signup page is gone; the signup API remains for the tests, is still limited to enzo.health, and
  answers 404 in release builds unless `ALLOW_PASSWORD_SIGNUP` is set (`auth::password_signup_allowed`).
- **Admins sign in with a password.** The LinkedIn identity is an unverified claim, so the join
  refuses an identity that belongs to an admin (`is_admin` or `is_system_admin`): 403
  `admin_use_password`. Otherwise the join code plus an admin's public LinkedIn id would be a sync
  token, then a session, as that admin. Admins sign in at `/auth/password`, and the extension then
  links from that session (`/api/auth/device/session`); the get-started page links there. After
  such a refusal the extension does not ask LinkedIn again for 10 minutes.
- **An identity is bound once.** `/api/link` refuses to re-point an account already linked to a
  different LinkedIn id (409 `already_linked`) and refuses `pending:` placeholders (400
  `identity_required`).
- **"View as" stays a view.** `/api/auth/device/session` refuses an impersonation session (403
  `impersonation_session`), so it cannot become a lasting, unmarked device token as the target.
- **Deleting an account** (for people who have left). An admin uses "Delete account" in a row's
  menu on the All users page (`DELETE /api/system/members/{id}`, in `server/src/accounts.rs`). It
  marks the account deleted (`members.deleted_at`) and removes nothing the person recorded: posts
  with their snapshots and comments, profile readings, challenge memberships and invites all stay.
  It does remove what lets them in: device tokens (and the legacy sync token hash is replaced),
  website sessions (including ones where they were viewing as someone else), the API keys they
  created, and their admin flag.

  A deleted account gets in nowhere, and the check is made where members are resolved
  (`auth::session_from_token`, `auth::member_from_bearer`, `auth::api_key_from_bearer`), so
  anything deleting missed is refused too:

  | Way in | A deleted account gets |
  | --- | --- |
  | Password login (`/api/auth/login`) | 401 "invalid email or password", the same as a wrong password |
  | Website session cookie (every cookie route, `/api/auth/me`) | signed out; 401 on routes that need a member |
  | Viewing as someone else (their session as impersonator) | signed out |
  | "View as" them (`/api/system/impersonate`) | 400 "this account has been deleted" |
  | Sync token (`/api/sync`, `/api/link`, `/api/me/sync-status`) | 401 with `code: "account_deleted"` |
  | Sync token to website session (`/api/auth/device/web-session`) | 401 with `code: "account_deleted"` |
  | Session token to sync token (`/api/auth/device/session`) | 401 |
  | Company join link (`/api/auth/extension/join`) | 403 "this account has been removed; ask an admin to restore it", and no new account is made (only after a valid join code; a wrong code gets the usual join-code message) |
  | Signup and invite join with their email | 409 "an account with that email already exists" |
  | API keys they created | 401 (deleted, and refused while the creator is deleted) |
  | Being made an admin | 400 until restored |

  They are left off leaderboards and challenge standings, member counts and company totals,
  automatic enrolment (also at server start), member detail pages, `/api/v1/members` and its sync
  summary. They stay in `/api/v1/posts` for the period they posted in, flagged `authorDeleted`,
  so past reports do not change. The All users page hides them unless "Show deleted" is on.

  "Restore account" (`POST /api/system/members/{id}/restore`) clears the mark: the person signs in
  again the usual way and is back on the boards with everything they had. It does not bring back
  tokens, sessions, API keys or admin access. Deleting a deleted account, or restoring one that is
  not deleted, succeeds and changes nothing. Two refusals: an admin cannot delete their own account
  (400), and an account that owns a challenge, as its creator or through an owner membership,
  cannot be deleted until the challenge is handed to someone else or removed (409). There is no
  challenge transfer yet.

Differences from the proposal below: the gate is one reusable code rather than single-use
invites, and a second device needs only the same link. The LinkedIn identity is still an
unverified claim, so anyone holding the join link could claim another member's identity.

## The idea

Drop the website login. Installing the extension is how you join: it creates your account from
your LinkedIn identity and signs you in, and the website is reached through the extension. No
email, no password.

## How it works today

The root of trust is the website's email and password login. The extension borrows it:
`extension/sync.js` reads the site's session cookie and exchanges it for a per-device sync token
(`signInDeviceWithSession`). `POST /api/link` then fills in the LinkedIn identity of an account
that already exists; it never creates accounts.

The proposal inverts this. LinkedIn identity, as seen by the extension, becomes the root, and the
website session is minted from the extension's token.

## Problems to solve

**The server cannot verify who the extension says you are.** The extension knows the member's
LinkedIn id, but anything it sends is a claim. A scripted request could claim to be another
member and take over their account and points.

Sending LinkedIn cookies (`li_at`) to our server so it can check with LinkedIn is **ruled out**.
Those cookies are full access to the person's LinkedIn account, so we would be storing everyone's
LinkedIn keys, and it violates LinkedIn's terms. Identity needs a different proof.

**It reopens signup.** If installing the extension creates an account, anyone with LinkedIn gets
in. The enzo.health domain gate (#3) checks email, and there would be no email left to check.

## Proposed shape

- **Admission by invite link.** An admin sends a link; the person installs the extension from it;
  the extension creates the account from that single-use invite plus their LinkedIn identity. No
  link, no account. This replaces the domain gate. Invite codes already exist.
- **Identity bound once.** Redeeming the invite binds the LinkedIn member id to the new account.
  A later claim to the same member id is refused, not treated as a login.
- **Website opened from the extension.** A popup button such as "View leaderboard" opens the site
  already signed in, using a session minted from the device token. No login page.
- **Second device.** Installing on another machine is the same unverifiable claim again. It needs
  approval from an existing device, or a fresh invite from an admin.

## Tradeoffs

- The extension becomes the only way in. Phone-only users, or anyone on a laptop that blocks
  extensions, cannot see the board at all.
- Account recovery depends on admins issuing invites, since there is no email to reset through.

## Open decisions

1. Are single-use invite links the right admission gate, or should a domain check survive in
   some form (for example, one email verification at join time)?
2. How does a second device get approved?

## Scope

Medium. Touches signup and invite redemption, `/api/link`, website session minting, and the
extension popup. Best done after the in-flight work: the deploy-time migrate step (#8),
distinct-commenter scoring, and the repost scoring fix.
