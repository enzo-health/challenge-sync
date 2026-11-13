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
  or anything else, a generic "Something went wrong signing you in" with a small reason code
  (`blocked`, `network`, `http-<status>`, `error`, or `legacy-extension`). Only the server's own
  JSON 403 "open your company's invite link first" is a refused code; extensions before 0.1.4
  reported refused codes and host blocks alike as "needs invite", so with a code in the browser
  the page shows such a reply as the generic error (`legacy-extension`). The popup uses the same
  three cases.
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
    test, plus any 403 whose body is not JSON. A blocked call throws `BlockedError` ("Couldn't
    reach Challenge Sync just now. Trying again shortly."), which is never "needs invite", never
    "token rejected" (no re-link, no token replaced) and never "signed out". After a block the
    extension backs off, 30 seconds doubling to 10 minutes, during which calls fail without a
    request and LinkedIn is not read for a join or sync that cannot land.
  - The extension does not send cookies (`credentials: "include"`) to carry the browser's
    challenge clearance; see the comment in `extension/sync.js`.
- **Admins.** The system-admin flag is "admin". An admin can grant or remove it for others from
  the All users page, which also shows, generates and replaces the join link. The first admin is set in the database.
- **Kept:** the email and password login, at `/auth/password`, for accounts that have one. The
  signup page is gone; the signup API remains for the tests and is still limited to enzo.health.
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
  | Sync token (`/api/sync`, `/api/link`, `/api/me/sync-status`) | 401 |
  | Sync token to website session (`/api/auth/device/web-session`) | 401 |
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
