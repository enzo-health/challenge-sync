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
- **Admins.** The system-admin flag is "admin". An admin can grant or remove it for others from
  the All users page, which also shows, generates and replaces the join link. The first admin is set in the database.
- **Kept:** the email and password login, at `/auth/password`, for accounts that have one. The
  signup page is gone; the signup API remains for the tests and is still limited to enzo.health.

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
