> Historical: the server no longer uses Topcoat; it was ported to nextrs (see [MIGRATION.md](../MIGRATION.md)).

# Topcoat 0.5 / Toasty 0.7 — build cheat-sheet

_Distilled from the framework source (`.reference/topcoat`) by a research pass. Ground truth for building the server._

## Contents
1. Topcoat v0.5.0 — view! Templating & Component System Cheat-Sheet
2. Topcoat v0.5 Sessions & Cookies: BYO-Storage Auth, Cookie Jar, CookieStore<T> — Cheat-Sheet
3. Topcoat 0.5.0 Project Scaffolding & Build Pipeline Cheat-Sheet (Cargo, build.rs, Tailwind, assets, fonts, CLI, dev server)
4. Topcoat 0.5 Routing Cheat-Sheet: module_router!, layouts, params, POST routes, and real app wiring
5. Topcoat 0.5.0: Cx, app_context, #[memoize], functions-not-middlewares auth, and JSON/Form content (verified against source)
6. Topcoat 0.5.0 Interactive Runtime Cheat-Sheet: signals, shards, procedures, expr!, SSE (for a live leaderboard)
7. Toasty ORM 0.7 in Topcoat 0.5 — Complete Cheat-Sheet (models, relations, queries, macros, sqlite, seeding)

---



# Topcoat v0.5.0 — view! Templating & Component System Cheat-Sheet


# Topcoat v0.5.0 — `view!` templating & components (ground truth from source)

Sources: `crates/topcoat-view/macro/docs/{view,component,attributes,class,props}.md`, `crates/topcoat-view/src/`, `demos/coffee-shop/src/` (all paths relative to `/home/drew/work/linkedin-challenge/.reference/topcoat`).

## Imports (exact, from the demo app)

```rust
use topcoat::{
    Result,                                    // Result<T = View, E = Error>
    context::Cx,
    view::{Attributes, View, attributes, class, component, view},
};
```
`topcoat::Result` defaults its `T` to `View` (`crates/topcoat/src/lib.rs:15`), so component signatures are just `-> Result`. Docs also use `use topcoat::{Result, view::*};` — the glob works.

## Defining a component

```rust
#[component]
pub async fn badge(label: &str, tone: &str) -> Result {
    view! {
        <span class=(format!("badge badge-{tone}"))>(label)</span>
    }
}
```
- Components are **async fns** returning `Result` (= `Result<View, Error>`).
- `view! { ... }` **evaluates to `Result`**, so it is the last expression with **no `?`**. Add `?` only when you need a `View` value: `let sidebar = view! { <aside></aside> }?;`.
- Parameter attributes:
  - `#[default]` → optional param, filled with `Default::default()`.
  - `#[default(expr)]` → custom fallback, evaluated only when omitted; type need not impl `Default`.
  - `#[into]` → caller can pass `impl Into<T>`; `.into()` happens at the call site (fewer monomorphizations than `impl Into<T>` params — docs explicitly prefer `#[into]`).
- `cx: &Cx` as a parameter injects the request context (callers do NOT pass it).
- Child content: a param literally named `child` of type `View` receives trailing nodes. `View: Default`, so `#[default] child: View` makes children optional.
- Generics: fine, but bounds often need `Send + Sync`.
- **Recursive components need `#[component(boxed)]`** on one component in the cycle or you get a Future dependency cycle.

## `view!` syntax essentials

- Real HTML names. Void elements written **without** closing tags: `<input ...>`, `<br>`, `<img ...>`, `<meta ...>`, `<link ...>`. Non-void elements **must** have closing tags.
- **Text nodes must be quoted**: `<p>"Hello"</p>`. Unquoted text is a compile error (macro limitation).
- Attribute names may contain `-`, `:`, `.` (`data-post-id`, `aria-label`, `hx-get`, `class.active`); Rust keywords are fine (`type="button"`, `for="email"`).
- Element names may contain dashes (`<my-widget>`).
- `//` comments are allowed inside `view!` bodies (used throughout the demo).
- `<!DOCTYPE html>` is written literally in the layout.

### Interpolation — parentheses, not braces

```rust
view! {
    <h1>"Hello, " (user.name) "!"</h1>          // child node
    <a href=(url) aria-current=(is_current)>"Open"</a>  // attribute value
    <(tag) (attr)="ready">"Loaded"</(tag)>       // dynamic element AND attribute names
}
```
- Tuples concatenate in value position (impls up to 9+ elements in `src/html/attribute/{value,key}.rs`): `<a href=(("/orgs/", &org.slug))>` — used verbatim in the demo (`href=(("/menu/", &drink.slug))`).
- All interpolated text/attributes are auto-escaped. Opt-out is `topcoat::view::Unescaped::new_unchecked(..)` / `View::unescaped_unchecked(&'static str)` — trusted markup only.

## Control flow (works in child position AND inside opening tags)

```rust
// if / else if / else
if user.is_some() { <a href="/account">"Account"</a> } else { <a href="/login">"Sign in"</a> }

// for
<ul> for post in posts { <li><a href=(post.url)>(post.title)</a></li> } </ul>

// match — arms comma-separated; one node per arm, use a block for siblings; guards ok
match status {
    Status::Draft => <span>"Draft"</span>,
    Status::Published { title } => <a href="/posts">(title)</a>,
    Status::Archived if show_archived => <span>"Archived"</span>,
    _ => "",                                   // "" is the empty node
}

// let — plain statement, scoped to following nodes
let title = post.title.trim();
<h1>(title)</h1>
```

**Attribute-position control flow** (no React equivalent — this happens inside the opening tag):
```rust
<a href="/posts"
    if current { aria-current="page" class="active" }
>"Posts"</a>

<div for (name, value) in attrs { (name)=(value) }></div>

<article match state {
    State::Open => class="open",
    State::Closed => aria-disabled="true",
}></article>

<a  let href = post.url();
    href=(href) data-slug=(post.slug)
>(post.title)</a>
```

## Calling components

Snake_case function-call syntax with **named parameters**; trailing child nodes need **no commas between them**:

```rust
view! {
    panel(
        title: "Profile",              // named param
        <p>"Account details"</p>       // trailing nodes → `child`
        badge(label: "Active", tone: "success")
    )
}
```
Desugars to `panel(title: "Profile", child: view! { ... }?)`. You can also pass `child:` explicitly.

## Boolean & conditional attributes

- Static known values: prefer literal `disabled=""` (folded into the pre-rendered template) over `disabled=(true)` (evaluated every render).
- Expression attributes **remove themselves**: `false` or `None` → the whole attribute is omitted; `true` → rendered with empty value; `Some(v)` → rendered with `v`.
```rust
<button
    disabled=(is_disabled)                       // omitted when false
    aria-current=(is_current.then_some("page"))  // aria-current="page" or absent
    title=(maybe_title)                          // Option<&str>
>"Save"</button>
```
- GOTCHA: literal `disabled="false"` is **still disabled** (HTML boolean semantics; omission logic only applies to expression attributes).
- GOTCHA: enumerated attributes (`aria-expanded`, `contenteditable`) need literal `"true"`/`"false"` strings, not bools: `aria-expanded=(if expanded { "true" } else { "false" })`.

## `class!` — conditional class lists

```rust
use topcoat::view::{class, view};
<button class=(class!(
    "btn", "btn-lg",
    "active" if is_active,                       // include if cond
    "cursor-pointer" if enabled else "opacity-50", // if/else
    variant,                                     // Option<&str> — None skipped
    sizes,                                       // Vec<String> — all included
))>"Save"</button>
```
- Entries: anything implementing `ClassViewParts` — strings, `Option`s, `Vec`/arrays, another `Class`, or an `AttributeValue` pulled from `Attributes` (this is how class-forwarding works).
- Absent entries leave no stray spaces; **if all entries are absent the entire `class` attribute is omitted**.

## `attributes!` and the `Attributes` runtime map

```rust
use topcoat::view::{attributes, view};
let attrs = attributes! {
    class="button"
    id=(id)
    if id == "submit" { type="submit" } else { type="button" }
    for (name, value) in extra { (name)=(value) }
    match id { "submit" => aria-label="Submit", _ => aria-label="Button", }
};
view! { <button (attrs)>"Save"</button> }        // spread as attribute fragment
```
- Same syntax as attributes inside `view!` opening tags, including control flow, event handlers, binds, spreads. No commas between entries.
- `Attributes` is map-like, **unique keys**, inserting replaces; do not rely on attribute render order.
- Runtime API (from `src/html/attribute/attributes.rs`): `attrs.insert(cx, "data-state", "loading")` (**needs `cx`**), `attrs.remove("class") -> Option<AttributeValue>`, `contains_key`, `clear`, `extend`.
- **Spreading `(attrs)` into an element consumes it** — clone first to reuse.

### The canonical attrs-forwarding component (verbatim pattern from `demos/coffee-shop/src/components/button.rs`)

```rust
#[component]
pub async fn button(
    #[default] variant: ButtonVariant,   // enum with #[derive(Default)] + #[default] variant
    #[default] size: ButtonSize,
    #[default] mut attrs: Attributes,
    #[default] child: View,
) -> Result {
    view! {
        <button
            class=(class!(BASE, variant.classes(), size.classes(), attrs.remove("class")))
            (attrs)
        >
            (child)
        </button>
    }
}
// Caller:
button(variant: ButtonVariant::Destructive, attrs: attributes! { type="submit" }, "Delete")
```
GOTCHA: **class merging is manual**. A caller-supplied `class` inside `attrs` is NOT auto-merged — the component must `attrs.remove("class")` and feed it into `class!` before spreading `(attrs)`, otherwise the spread's `class` key would fight the computed one. Every vendored component (card, button, input, badge, label) does exactly this.

Also from the components: `button_variants(variant, size) -> String` / `badge_variants(variant) -> String` helpers exist so a plain `<a>` can look like a button: `<a href="/login" class=(button_variants(ButtonVariant::Outline, ButtonSize::Md))>"Sign in"</a>`.

## Concurrent rendering (breaks React/Rails intuition)

Components inside a `view!` render **concurrently**: siblings, `for` iterations, taken branches, a component and its children — all start at once; output is stitched in source order. A component awaiting a DB query does not block its siblings (no request waterfalls). Consequences:
- Execution order of component bodies is unspecified and may change per render.
- No side effects; never communicate between components via shared mutable state; never assume another component ran first.
- Plain Rust in the body (interpolations, `let`, loop iterators, conditions) still runs in source order — only components are concurrent.
- Pair with `#[memoize]` (topcoat-core) for per-request dedup of shared queries (the demo's `drinks(cx)` is memoized and called from both layout footer and pages).

## Status codes & headers as view nodes

```rust
use topcoat::router::{StatusCode, HeaderValue, header};
view! {
    (StatusCode::NOT_FOUND)
    ((header::CACHE_CONTROL, HeaderValue::from_static("no-store"))) // note double parens: tuple node
    <h1>"Page not found"</h1>
}
```
- First status rendered wins; first mention of a header name wins. Layout placement decides precedence: declaration **before** `(slot?)` overrides pages, **after** it is a fallback pages can override.
- A `StatusCode` node renders no text; display via `(status.as_u16())`.
- Requires the `router` feature; rendering to a plain string discards them.

## Rendering outside a component

Inside `#[component]`/`#[page]`/`#[layout]`/`#[shard]`, `cx` is implicit. In a plain fn, pass it at the start: `view! { cx => greeting(name: "World") }`. `View::render(self, cx) -> String` and `View::render_response(self, cx)` exist on the runtime type.

## `#[derive(Props)]` (separate from `#[component]` params)

Typestate builder for standalone props structs — `build()` only compiles once all non-`#[default]` fields are set (missing prop = compile error naming the field). Supports the same `#[default]`/`#[default(expr)]`/`#[into]` field attributes. You do NOT need this for ordinary components; `#[component]` fn params already behave like props.

## Adjacent syntax you'll see in `view!` bodies (topcoat-runtime, not templating)

From the demo (`app/menu.rs`, `app/menu/drink.rs`) so you can recognize it:
- `signal query = String::new();` — client-side signal declared in a view body.
- `$(expr)` — reactive runtime expression as a text node or component argument: `drink_grid(query: $(query.get()))`.
- `:value=$(query.get())` — bind attribute; `@click=$(|_e: Event| ...)` or `@input="(e) => console.log(e)"` — event handlers (Rust-ish closure via `$()` or raw JS string).
- `#[shard]` components re-render on the server when their `$()` args change; `#[procedure]` fns are server functions callable from handlers.
These need `topcoat::runtime::script()` in the layout `<head>`. Don't confuse `$(...)` (runtime expr) with `(...)` (server-side interpolation).

## Layout/page skeleton (from `demos/coffee-shop/src/app.rs`)

```rust
#[layout]                       // root-module layout wraps every page
async fn shell(cx: &Cx, slot: Result) -> Result {
    view! {
        <!DOCTYPE html>
        <html>
            <head>
                <title>"Leaderboard"</title>
                <link rel="stylesheet" href=(tailwind::stylesheet!())>
            </head>
            <body>
                <main>(slot?)</main>       // slot is Result — `?` it in place
            </body>
        </html>
    }
}

#[page]                          // renders at the module's path
async fn home(cx: &Cx) -> Result { view! { <h1>"Hi"</h1> } }
```
Routing is module-driven (`module_router!()`, `path_param!(slug)` then `path_param::<Slug>(cx)`), pages/layouts/routes discovered via `.discover()`. Forms: `#[route(POST)] async fn f(cx: &Cx, Form(form): Form<T>) -> Result<SeeOther>` + `see_other("/")` for Post/Redirect/Get.

## Applying this to the leaderboard app

- **Leaderboard table**: `for (rank, entry) in ranked.iter().enumerate() { ... }` with row highlight `class=(class!("row", "bg-primary/10" if entry.user_id == me))`. Remember: iteration is plain Rust (ordered), but any components rendered per-row execute concurrently — fetch scores once before the loop, don't query per-row component unless memoized.
- **Rank/status badges**: mirror `roast_badge` — a tiny component `match status { InviteStatus::Pending => badge(variant: BadgeVariant::Secondary, "Pending"), InviteStatus::Accepted => badge(variant: BadgeVariant::Primary, "Accepted"), ... }`.
- **Admin CRUD forms**: plain `<form method="post" action="/admin/orgs">` wrapping vendored `label(attrs: attributes! { for="name" }, "Name")` + `input(attrs: attributes! { id="name" name="name" required="" })` + `button(attrs: attributes! { type="submit" }, "Create")`. Note `required=""` literal form for static boolean attrs.
- **Conditional admin UI**: `if is_admin(cx).await? { button(...) }` in child position; `aria-current=(is_current.then_some("page"))` for nav.
- **Org links**: tuple concat `href=(("/orgs/", &org.slug))`.
- **404 for unknown org**: either `.ok_or_not_found()?` (from `topcoat::router::error::RouterErrorExt`, as the demo does after a Toasty query) or render `(StatusCode::NOT_FOUND)` in a view.
- **Bearer-token JSON ingest API**: not a `view!` concern — use `#[route(POST)]` handlers returning JSON (`topcoat-router` content docs); `view!` is only for HTML responses.
- **Reusable card shells** for leaderboard/org panels: copy the `card`/`card_header`/`card_title`/`card_content`/`card_footer` composition pattern; every wrapper takes `#[default] mut attrs: Attributes, #[default] child: View` and does the `attrs.remove("class")` merge.

## Gotcha checklist (things that WILL bite a Rails/Next dev)

1. Text nodes must be quoted; interpolation is `(expr)`, never `{expr}`.
2. Components are snake_case calls `button(...)`, not `<Button/>`; args are `name: value` (colon, comma-separated); children trail with no commas.
3. `view!` evaluates to `Result<View>` — no `?` on a component's final `view!`; `?` when you need a `View` (e.g., explicit `child:` values, `(slot?)` in layouts).
4. Sibling components run concurrently in unspecified order — pure functions only, no shared mutable state, memoize shared queries.
5. Caller `class` in forwarded `Attributes` is not auto-merged; components must `attrs.remove("class")` into `class!`.
6. `Attributes.insert` needs `cx`; spreading `(attrs)` consumes the value; keys are unique (last insert wins) and render order is unspecified.
7. Expression attrs vanish on `false`/`None`; literal `disabled="false"` stays disabled; enumerated ARIA attrs want string `"true"`/`"false"`.
8. Prefer literal `disabled=""` over `(true)` for static markup folding.
9. `match` arms are one node each — brace-block for siblings; `_ => ""` for nothing.
10. Recursive components: `#[component(boxed)]` or it won't compile.
11. `$( )` is client-side reactive (runtime crate); `( )` is server-side — different worlds.
12. Everything is escaped; `Unescaped::new_unchecked` is the only escape hatch — trusted content only.



# Topcoat v0.5 Sessions & Cookies: BYO-Storage Auth, Cookie Jar, CookieStore<T> — Cheat-Sheet

# Topcoat Sessions & Cookies Cheat-Sheet (verified against source)

Source of truth: `crates/topcoat/docs/session.md`, `crates/topcoat/docs/cookie.md`, `crates/topcoat-session/src/*`, `crates/topcoat-cookie/src/*`, `examples/session/`, `examples/cookie/`, `demos/coffee-shop/`.

## 1. The mental model (violates Rails/Next intuition)

- **There is NO server-side session bag.** No `session[:user_id]`, no `req.session.foo`. Topcoat sessions only do: mint a 32-byte random token, carry it in a hardened cookie, hand YOU the SHA-256 hash (`TokenHash`) + expiry to persist in YOUR database (Toasty, here). Resolving "who is logged in" is 100% your DB lookup.
- **No auth middleware.** Philosophy is "functions, not middlewares" (`crates/topcoat/docs/functions_not_middlewares.md`): write `current_user(cx)` / `require_admin(cx)` functions and call them at the top of each handler.
- If you want small structured per-visitor state (Rails session-bag-like), that's `CookieStore<T>` over a signed/private jar — a separate feature from sessions.
- The session cookie is **not** signed/encrypted (doesn't need to be — the value is pure randomness). `Key` / signed / private cookies are unrelated to sessions.

## 2. Router setup

```rust
use topcoat::{
    cookie::RouterBuilderCookieExt,                      // .cookies()
    router::{Router, RouterBuilderDiscoverExt},
    session::{RouterBuilderSessionExt, SessionConfig},   // .sessions(...)
};

topcoat::start(
    Router::builder()
        .cookies()                              // REQUIRED for default CookieTokenStore
        .sessions(SessionConfig::default())     // registers config on app_context + a root layer
        .app_context(db)                        // toasty::Db handle (Clone-cheap)
        .discover()
        .build(),
).await.unwrap();
```

- `.sessions(config)` = `app_context(config)` + `SessionLayer` (inserts a per-request `SessionState` cell). **Calling any `session::*` function without `.sessions()` registered panics** (missing app/request context), same for `.cookies()`.
- Config (`topcoat::session::{SessionConfig, cookie::CookieTokenStore}`):

```rust
use std::time::Duration;
use topcoat::session::{SessionConfig, cookie::CookieTokenStore};

let config = SessionConfig::builder()
    .token_store(CookieTokenStore::new().name("id"))   // default name: "session"
    .lifetime(Duration::from_hours(24 * 14))           // default: 30 days (DEFAULT_LIFETIME)
    .build();
```

- Default cookie is maximally hardened via `override_*`: `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` (see `CookieTokenStore` in `topcoat-session/src/token/store.rs`). On the wire it's `__Host-session`; in code you never see the prefix.
- `lifetime` becomes both the cookie `Max-Age` and the `expires_at` handed to you, so client cookie and DB record expire together.

## 3. Session lifecycle API (all in `topcoat::session`, all take `cx: &Cx`)

```rust
pub struct Session   { pub token_hash: TokenHash, pub expires_at: SystemTime }  // web_time::SystemTime = std on native
pub struct Rotation  { pub revoked: TokenHash, pub session: Session }

session::start(cx)      -> Result<Session>            // login: ALWAYS fresh token (fixation-safe). Persist hash+expiry.
session::token_hash(cx) -> Result<Option<TokenHash>>  // per-request hash to look up; None if absent/malformed
session::stop(cx)       -> Result<Option<TokenHash>>  // logout: expire cookie; returns hash so you delete the row
session::refresh(cx)    -> Result<Option<Session>>    // sliding expiration: same token, new expiry; update your row
session::rotate(cx)     -> Result<Option<Rotation>>   // new token, same session: delete/rekey `revoked`, store `session`
```

- Token read is cached per request; `start`/`stop`/`rotate` update the cached view, so a page rendered after login in the same request sees the new session.
- `TokenHash`: `Debug, Clone, PartialEq, Eq, Hash`, `Deref<Target = [u8; 32]>`, `TokenHash::new([u8; 32])`. **NOT Serialize/Display** — to persist in Toasty, encode yourself (hex into a `String` column is the safe bet; the repo's Toasty examples only show `String`/`f64`/`i64`/embedded-enum columns):

```rust
fn hash_hex(h: &topcoat::session::TokenHash) -> String {
    h.iter().map(|b| format!("{b:02x}")).collect()
}
```

- `stop` only ends the presented session. "Sign out everywhere" = delete the other rows; their tokens die instantly.
- Calling `start` while already logged in issues a new token but leaves the OLD row in your DB — delete it (via `token_hash(cx)` first) or let it expire.

## 4. Admin login for the leaderboard app (Toasty-backed)

Toasty session model (adapt column types to what Toasty v0.7 actually supports — repo shows `#[key]`, `#[auto]`):

```rust
#[derive(Debug, toasty::Model)]
struct AdminSession {
    #[key]
    token_hash: String,   // hex of the 32-byte hash
    admin_id: i64,
    expires_at: i64,      // unix seconds; SystemTime isn't shown as a Toasty column type in this repo
}
```

Handlers (lifted from `examples/session/src/main.rs` + docs):

```rust
use serde::Deserialize;
use topcoat::{
    Result,
    context::{Cx, app_context, memoize},
    router::{
        content::Form,
        error::{RouterErrorExt, SeeOther, see_other},
        page, route,
    },
    session,
    view::view,
};

#[derive(Deserialize)]
struct LoginForm { email: String, password: String }

#[route(POST "/admin/login")]
async fn login(cx: &Cx, Form(form): Form<LoginForm>) -> Result<SeeOther> {
    let admin = verify_credentials(cx, &form.email, &form.password).await?; // your code
    let session = session::start(cx).await?;                                // sets Set-Cookie
    // persist: key = hex(session.token_hash), admin_id, session.expires_at
    persist_admin_session(cx, &admin, &session).await?;
    Ok(see_other("/admin"))
}

#[route(POST "/admin/logout")]
async fn logout(cx: &Cx) -> Result<SeeOther> {
    if let Some(hash) = session::stop(cx).await? {
        delete_admin_session(cx, &hash).await?;
    }
    Ok(see_other("/"))
}
```

### `current_user(cx)` helper — the canonical pattern

```rust
use topcoat::{context::{Cx, memoize}, session};

// #[memoize] dedupes the DB hit when layout + page + components all call it.
// GOTCHAS: param must be LITERALLY named `cx`; `as_ref` makes it return Option<&Admin>
// (without as_ref you'd get &Result<...>/&Option<...>). Return type must be Send+Sync+'static.
#[memoize(as_ref)]
async fn current_admin(cx: &Cx) -> Option<Admin> {
    let hash = session::token_hash(cx).await.ok()??;
    // YOUR contract: unknown hash OR expired row => not authenticated.
    load_admin_by_session(cx, &hash).await   // must filter expires_at > now
}

// Guard: plain function call, no middleware. RouterErrorExt gives Option/Result adapters.
#[page("/admin")]
async fn admin_home(cx: &Cx) -> Result {
    let admin = current_admin(cx).await.ok_or_redirect("/admin/login")?;
    view! { <h1>"Hi " (&admin.name)</h1> }
}
```

`RouterErrorExt` adapters (from `topcoat::router::error`): `.ok_or_redirect(uri)`, `.ok_or_redirect_permanent(uri)`, `.ok_or_not_found()`, `.ok_or_unauthorized()`, `.ok_or_forbidden()` — on both `Option` and `Result`.

In-memory expiry check reference (`examples/session/src/main.rs`): `.filter(|record| record.expires_at > SystemTime::now())` — replicate in your Toasty query/filter.

## 5. Bearer-token JSON ingest API (orgs posting scores)

Two supported shapes; **`SessionConfig` holds exactly ONE `TokenStore`**, so you cannot have cookie sessions AND bearer sessions from one `.sessions()` call unless you write a store that tries both.

**Recommended for this app: skip sessions for the API entirely; reuse the `Token` type as an API-key primitive.** All public: `Token::random()`, `.encode()` / `Token::decode(&str)` (URL-safe base64, exactly 32 bytes, `DecodeError` on anything else), `.hash() -> TokenHash`.

```rust
use topcoat::{router::request::headers, session::Token};

// Minting (admin creates org / invite): show `token.encode()` ONCE, store hex(token.hash()) on the org row.
let token = Token::random();
let secret_for_client = token.encode();
let db_key = hash_hex(&token.hash());

// Ingest handler:
#[route(POST "/api/ingest")]
async fn ingest(cx: &Cx, topcoat::router::content::Json(payload): topcoat::router::content::Json<IngestBody>) -> Result<...> {
    let bearer = headers(cx).get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_unauthorized()?;
    let token = Token::decode(bearer).ok().ok_or_unauthorized()?;
    let org = find_org_by_key(cx, &hash_hex(&token.hash())).await.ok_or_unauthorized()?;
    // ...score, insert
}
```

(Verify the `Json` extractor path in `topcoat-router/docs/content.md` — the extractor pattern `Form(form): Form<T>` is confirmed in source; JSON follows the same `FromRequest` shape.)

Alternative (verbatim from `session.md`) if you DO want the session machinery over a header — custom `TokenStore`:

```rust
use std::{pin::Pin, time::Duration};
use topcoat::{context::Cx, router::request::headers,
    session::{Token, TokenStore, TokenStoreFuture}};

struct BearerTokenStore;
impl TokenStore for BearerTokenStore {
    fn read<'a>(&'a self, cx: &'a Cx) -> TokenStoreFuture<'a, Option<Token>> {
        Box::pin(async move {
            let Some(b) = headers(cx).get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer ")) else { return Ok(None) };
            Ok(Token::decode(b).ok())
        })
    }
    fn write<'a>(&'a self, _cx: &'a Cx, _t: Token, _max_age: Duration) -> TokenStoreFuture<'a, ()> {
        Box::pin(async move { Ok(()) })   // API clients get tokens out of band
    }
    fn delete<'a>(&'a self, _cx: &'a Cx) -> TokenStoreFuture<'a, ()> {
        Box::pin(async move { Ok(()) })
    }
}
```

Invite links: same primitive — `Token::random()`, email `token.encode()` in the URL, store hex of `token.hash()` + expiry on the invite row, look up on GET, consume on POST accept.

## 6. Cookie jar (`topcoat::cookie`)

```rust
use topcoat::cookie::{Cookie, Cookies, SameSite, cookie, cookies, time::Duration};
// `Cookies` TRAIT must be in scope for get/add/remove — forgetting it = confusing errors.

let jar = cookies(cx);                       // &CookieJar; header parsed once, memoized per request
jar.get("theme");                            // Option<Cookie> from the request
jar.add(Cookie::build(("theme", "dark")).path("/").build());
jar.add(("theme", "dark"));                  // Into<Cookie>: bare tuple works
jar.remove(Cookie::build(("session", "")).path("/").build()); // MUST match original Path/Domain
```

- **Writes auto-flush**: anything added/removed becomes `Set-Cookie` when the handler returns. Never touch headers.
- `cookie!` macro mirrors the Set-Cookie header:

```rust
let c: Cookie = cookie! {
    "session" = "abc123";
    Path = "/"; Secure; HttpOnly; SameSite = Lax;
    MaxAge = Duration::hours(1)     // topcoat::cookie::time::Duration (the `time` crate), NOT std!
};
```

- **Two Duration types**: `cookie!`'s `MaxAge` and `override_max_age` use `topcoat::cookie::time::Duration` (`Duration::hours(1)`, `Duration::days(30)`); `SessionConfig::lifetime` uses `std::time::Duration`.
- Combinators (Iterator-adapter style, consume + return the jar): `default_secure/http_only/same_site/path/domain/max_age` (fill if unset) and `override_*` (force). Prefixes: `default_prefix_host`/`override_prefix_host` (`__Host-`), `*_prefix_secure` (`__Secure-`) — prefix + required attrs applied on write, stripped on read (you keep using the bare name). `.map(|c| ...)` is the escape hatch.
- **Idiomatic**: shadow `cookies` with your own defaults helper (exact pattern from `examples/cookie/src/main.rs`):

```rust
fn cookies(cx: &Cx) -> impl Cookies {
    topcoat::cookie::cookies(cx)
        .default_path("/")
        .default_http_only(true)
        .default_same_site(SameSite::Lax)
        .override_secure(true)
}
```

## 7. Signed / private cookies + Key

```rust
use topcoat::cookie::{Cookies, Key, cookie, cookies, signed_cookies, private_cookies};

// Manual: cookies(cx).signed(&key)  |  cookies(cx).private(&key)
// signed  = tamper-proof, client-readable (HMAC).  Reads return None on bad signature.
// private = AES-256-GCM encrypted; name is bound into the ciphertext. None on decrypt failure.

// App-wide: register the key once, then zero plumbing:
Router::builder().discover().cookies().app_context(Key::generate()).build();
signed_cookies(cx);   // SignedJar over app-context Key — PANICS if no Key registered
private_cookies(cx);  // PrivateJar — same panic rule
```

- `Key` is re-exported from the underlying `cookie` crate (`pub use cookie::{Cookie, Expiration, Key, SameSite, time}`). **`Key::generate()` on every boot invalidates every signed/private cookie in the wild — load a persisted key in production** (the `cookie` crate's `Key::from(bytes)` / `Key::derive_from(bytes)`; not demonstrated in this repo).

## 8. `CookieStore<T>` — typed JSON cookies

```rust
use serde::{Deserialize, Serialize};
use topcoat::cookie::{CookieStore, Cookies, cookie_store, signed_cookies};

#[derive(Default, Clone, Serialize, Deserialize)]
struct Prefs { theme: String }

// Helper-per-store is the idiomatic pattern:
fn prefs(cx: &Cx) -> CookieStore<Prefs, impl Cookies> {
    cookie_store(signed_cookies(cx), "prefs").parse_or_default()
}

// Usage:
let p = prefs(cx).update(|p| p.theme = "dark".into()).commit()?;  // commit returns the value
```

- `cookie_store::<T, _>(jar, name)` returns `UnparsedCookieStore`. Parse step is explicit: `parse()` (Ok(None)=absent, Err=present-but-malformed), `parse_or(v)`, `parse_or_else(f)`, `parse_or_default()` (the `_or*` forms treat malformed == missing — deliberate, since old cookies can't be migrated after you change `T`).
- Parsed store: `read()` borrows, `get()` clones, `set(v)` / `update(f)` chainable.
- **NOTHING is written until `.commit()?`** — unlike the raw jar's immediate `add`. Dropping without commit (or `.rollback()`) discards changes. Do fallible work first, commit last. `UnparsedCookieStore::set(v)` skips parsing; `.remove()` exists on both parsed/unparsed (e.g. logout) and reapplies Path/prefix attrs so the browser matches.
- Value stored as JSON; `T: Serialize + DeserializeOwned` (+ `Default` for `parse_or_default`, `Clone` for `get`). Composes with signing/encryption/prefixes through whichever jar you hand it.

## 9. Security & CSRF (as documented in source)

- Keep every state-changing route on `POST` (`#[route(POST "...")]`). `SameSite=Lax` still sends the cookie on top-level cross-site navigations, but the router's default `OriginPolicy` (applied before any layer/handler) rejects state-changing cross-origin browser requests with 403. **Safe methods (GET) are deliberately unchecked — a state-changing GET is unprotected.** Override via `Router::builder().origin_policy(...)`.
- Never store or log the raw token server-side; compare by hash lookup only. `Token`'s `Debug` impl prints nothing. Raw bytes only via `dangerous_as_array()` (for custom TokenStores).
- `__Host-`/`Secure` in local dev over http is not addressed anywhere in this repo — modern browsers generally accept Secure cookies on `http://localhost`, but verify with `cargo topcoat dev` before assuming.

## 10. Quick gotcha list

1. `Cookies` trait must be imported for `get/add/remove` on any jar.
2. Jar `add` queues immediately; `CookieStore` needs explicit `.commit()?`.
3. `#[memoize]` requires a param literally named `cx: &Cx`; rewrites return `T -> &T`; use `#[memoize(as_ref)]` for `Option<&T>` / `Result<&T, &E>`; recursing with identical args panics.
4. `session::*` / `cookies(cx)` / `signed_cookies` / `private_cookies` panic if their router registration (`.sessions()`, `.cookies()`, `app_context(Key)`) is missing — startup bugs, not runtime errors.
5. `TokenHash` has no serde/Display — hex-encode for the DB; `TokenHash::new(bytes)` to rebuild.
6. One `TokenStore` per `SessionConfig` — cookie web sessions + bearer API auth means either a dual store or (simpler) manual bearer checks reusing `Token`.
7. `toasty::Db` is a cheap-clone handle; register with `.app_context(db)`, fetch with `app_context::<Db>(cx).clone()`; Toasty statements need `&mut db`.
8. `topcoat::Result` defaults to `Result<View, Error>`; handlers returning redirects use `Result<SeeOther>` with `see_other("/path")` (303).
9. `Duration::from_hours` (std) is used by the framework itself — needs a recent Rust toolchain.



# Topcoat 0.5.0 Project Scaffolding & Build Pipeline Cheat-Sheet (Cargo, build.rs, Tailwind, assets, fonts, CLI, dev server)

# Topcoat 0.5.0 — Scaffolding & Build Pipeline (verified against source at `.reference/topcoat`)

## 0. Mental model (violates Rails/Next intuition)

- **No Node, npm, Vite, or PostCSS anywhere.** Tailwind runs as a *standalone binary* that Topcoat's build script auto-downloads (pinned to Tailwind CLI **4.3.2**, i.e. Tailwind **v4** syntax: `@import "tailwindcss"`, `@source`, `@theme`, `@custom-variant`). Cache: `<cargo-target>/topcoat/cache/tailwind`. First build needs network unless you point at a preinstalled binary.
- **Assets are declared in Rust code** (`asset!("...")`) and discovered by *scanning the compiled binary*. Bundling is a separate step (`topcoat dev` does it for you; `topcoat asset bundle` manually). The binary and the asset bundle **must come from the same build/profile** — asset IDs embed `OUT_DIR` paths which include profile + build hash.
- **No HMR.** `topcoat dev` recompiles, rebundles, restarts the process, then live-reloads the browser via the `topcoat::dev::script()` component (a no-op unless `TOPCOAT_DEV_URL` is set by the dev server, so it's safe in prod).
- **UI components are vendored source** (shadcn-style), not a library: `topcoat ui add button` copies `button.rs` into `src/components/`.

## 1. Cargo.toml — exact deps for our leaderboard app

Adapted from `demos/coffee-shop/Cargo.toml` and `examples/ui/Cargo.toml`:

```toml
[package]
name = "leaderboard"
version = "0.1.0"
edition = "2024"

[dependencies]
serde = { version = "1", features = ["derive"] }
toasty = { version = "0.7", features = ["sqlite"] }   # only "sqlite" is used anywhere in this repo
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
topcoat = { version = "0.5.0", features = ["font-fontsource", "tailwind", "ui"] }

[build-dependencies]
# MUST be default-features = false + only "tailwind": otherwise the whole
# server framework compiles for build.rs. (In the topcoat workspace they note
# `workspace = true` cannot be combined with `default-features = false`.)
topcoat = { version = "0.5.0", default-features = false, features = ["tailwind"] }
```

**Default features** (already on, don't re-list): `asset, compression, cookie, font, icon, router, runtime, serve, session, view, discover`. So sessions/cookies for admin auth and JSON routes for the bearer-token ingest API need **no extra features**.

**Opt-in features you might add**: `tailwind`, `ui`, `font-fontsource`, `icon-iconify`, `sse`, `websocket`, `multipart`, `mail` + `mail-smtp` (for invite emails!), `htmx`, `alpine-ajax`, `datastar`, `tower`, `full` (everything). `datastar` implies `sse`; `websocket` implies `serve`.

## 2. build.rs

With the `topcoat ui` theme (recommended — our app uses UI components):

```rust
fn main() {
    // styles.css (installed by `topcoat ui init`) is the Tailwind input:
    // it carries `@import "tailwindcss"` and the theme's design tokens.
    topcoat::tailwind::BuildConfig::new()
        .input("styles.css")
        .render()
        .unwrap();
}
```

Without a theme, bare default is `topcoat::tailwind::BuildConfig::new().render().unwrap();` (generates an input containing only `@import "tailwindcss";`).

Output always lands at `$OUT_DIR/tailwind.css`. `BuildConfig` knobs (all verified in `crates/topcoat/docs/tailwind.md`): `.version("4.3.2")`, `.version_checksum("4.3.2", "sha256:...")`, `.executable("tailwindcss")` (PATH or path relative to package root; disables download — use for offline/sandboxed builds), `.executable_env("TAILWIND_CLI")`, `.input(path)`, `.cwd(path)`.

**Rebuild gotchas**: `render()` prints NO `cargo:rerun-if-*` directives → Cargo's default applies (rerun on any non-.gitignored package file change; this is what picks up new Tailwind classes). If YOU print any `rerun-if-*` directive, that default is *replaced* by exactly what you list. Never point a directory directive at anything containing `target/`. If you use `.executable_env`, print `cargo:rerun-if-env-changed=TAILWIND_CLI` yourself.

**Class scanning**: delegated to the Tailwind CLI with `--cwd $CARGO_MANIFEST_DIR`; finds literal `class="..."` in `.rs` files, respects `.gitignore` (no ignore file → it scans `target/` — bad; scope with `.cwd("src")`). **Runtime-assembled class strings are invisible to Tailwind** — write full literal class strings (matters for leaderboard rank styling: use `class!`/match arms with complete literals, not string concat).

## 3. topcoat CLI

```sh
cargo install topcoat-cli          # installs a single `topcoat` binary (also works as `cargo topcoat ...`)
```

CLI version must match the project's `topcoat` version (it checks Cargo.lock and warns; silence with `TOPCOAT_NO_VERSION_CHECK=1`; fix with `cargo install topcoat-cli@<ver> --locked`).

Subcommands (from `crates/topcoat-cli/src/lib.rs`):

| Command | What it does |
|---|---|
| `topcoat dev` | build → bundle assets → run; watches sources; press `r` to force rebuild; live-reloads pages containing `topcoat::dev::script()` |
| `topcoat fmt [paths…]` | formats Topcoat macro bodies (`view!`, `class!`, `font!`, …) in place; `--stdin` for editors; `--macros view,class` to restrict. Run alongside `rustfmt`, not instead of it. Renamed macro imports are NOT formatted. Editor integration keys off a `Topcoat.toml` marker file (just `touch Topcoat.toml`). |
| `topcoat asset list \| bundle \| clean` | scan the built binary; `bundle` writes `<target>/<profile>/assets`; `--out dist/assets` to redirect |
| `topcoat ui init \| add \| list \| remove` | vendored component management (below) |

`dev`, `asset list`, `asset bundle` all take cargo target flags: `--bin <name>`, `-p/--package <name>`, `-r/--release`, `--profile <NAME>`.

**Dev server**: `HOST` / `PORT` env vars override bind address (defaults `127.0.0.1:3000`, from `crates/topcoat/src/serve.rs`): `HOST=0.0.0.0 PORT=8080 topcoat dev`. In a workspace: `topcoat dev -p leaderboard`.

## 4. main.rs + router (with Toasty) — lifted from coffee-shop demo

`src/main.rs`:
```rust
mod app;
mod components;
mod models;

use toasty::Db;

#[tokio::main]
async fn main() {
    let mut db = Db::builder()
        .models(toasty::models!(crate::*))       // collects #[toasty::model] types crate-wide
        .connect("sqlite::memory:")              // use a file path / env var for real persistence
        .await
        .unwrap();

    db.push_schema().await.unwrap();

    topcoat::start(app::router(db)).await.unwrap();
}
```

`src/app.rs` router builder (order: extensions before `.build()`):
```rust
use toasty::Db;
use topcoat::{
    Result,
    asset::{AssetBundle, RouterBuilderAssetExt, asset},
    context::Cx,
    cookie::RouterBuilderCookieExt,
    font::{Font, fontsource::fontsource_font},
    router::{Router, RouterBuilderDiscoverExt, layout, module_router, page, route},
    tailwind,
    view::{attributes, view},
};

const GEIST: Font = fontsource_font!(GEIST, host: Asset); // theme font, self-hosted as an asset

pub fn router(db: Db) -> Router {
    module_router!()                       // routes derived from the module tree (or Router::builder())
        .discover()                        // link-time collection of #[page]/fonts/shards/procedures
        .assets(AssetBundle::load().unwrap()) // loads <dir-of-exe>/assets; panics if never bundled!
        .app_context(db)                   // read later with app_context::<Db>(cx)
        .cookies()                         // request cookie jar (admin sessions need this)
        .build()
}
```

**Gotcha**: `AssetBundle::load()` looks *next to the executable* — plain `cargo run` fails at startup until `topcoat asset bundle` (or one `topcoat dev`) has run for that profile. `AssetBundle::load_dir("dist/assets")` for custom locations.

## 5. Root layout — wiring dev reload, runtime, font, Tailwind

```rust
#[layout]
async fn shell(cx: &Cx, slot: Result) -> Result {
    view! {
        <!DOCTYPE html>
        <html>                              // add class="dark" (or on any subtree) for dark mode
            <head>
                <title>"Leaderboard"</title>
                topcoat::dev::script()      // live reload; renders nothing outside `topcoat dev`
                topcoat::runtime::script()  // ONLY if you use signals/shards/procedures
                topcoat::font::link(font: GEIST)
                <link rel="stylesheet" href=(tailwind::stylesheet!())>
            </head>
            <body class="flex min-h-screen flex-col">
                <main class="mx-auto w-full max-w-3xl flex-1 px-6 py-10">(slot?)</main>
            </body>
        </html>
    }
}
```

`tailwind::stylesheet!()` literally expands to `::topcoat::asset::asset!(concat!(env!("OUT_DIR"), "/tailwind.css"))` — the generated CSS is just another content-hashed asset served from `/_topcoat/assets/...`.

## 6. Assets (`asset!`)

```rust
use topcoat::asset::{Asset, asset};
const LOGO: Asset = asset!("./logo.svg");      // relative to THIS source file
// asset!("assets/logo.png")                    → relative to CARGO_MANIFEST_DIR
// asset!("/abs/path.png")                      → absolute
// asset!("https://cdn.example.com/x.js")       → downloaded + cached at build/bundle time
// Options: rename: "x", extension: "css", checksum: "sha256:<hex>", content_type: "text/css"
view! { <img src=(LOGO) alt="Logo"> }           // renders /_topcoat/assets/logo-<hash>.svg
```

- An asset whose handle is never used can be optimized out of the binary → skipped by the bundler.
- Rendering an `Asset` not in the loaded bundle **panics** → always means binary/bundle build mismatch.
- CDN hosting: `.assets(AssetConfig::hosted_at("https://cdn.example.com/assets", AssetBundle::load().unwrap()))` — router serves no asset routes; you upload `dist/assets` yourself.

## 7. Fonts (`font-fontsource`)

```rust
use topcoat::font::{Font, fontsource::fontsource_font};
const GEIST: Font = fontsource_font!(GEIST, host: Asset);   // self-host via asset bundle
// narrow the files: fontsource_font!(ROBOTO, weight: [400, 700], style: Normal, subset: Latin)
// default (no host:): browser loads from jsDelivr CDN
```
Family/weight/style/subset are checked against the Fontsource catalog **at compile time**. Register via `.discover()` (automatic) or `.font(GEIST)`. Render `topcoat::font::link(font: GEIST)` in `<head>`. The built-in UI theme sets `--font-sans: "Geist"` but does NOT bundle the font — you must provide it exactly like this.

## 8. topcoat ui workflow

```sh
topcoat ui init            # creates components.toml (check into git!) + styles.css at package root
topcoat ui add button      # copies src/components/button.rs, adds `pub mod button;` to src/components.rs
topcoat ui list            # all registry components + install status; --installed to filter
topcoat ui add button --overwrite   # pull registry update (diff first — clobbers your edits)
topcoat ui remove button
# every subcommand takes -p/--package in a workspace; init takes --components-dir, --theme
```

- Built-in registry components (only these exist, from `crates/topcoat-ui/registry/src/components/`): **badge, button, card, checkbox, dropdown_menu, input, label, progress, select, spinner, switch, textarea**. **No table component** — build the leaderboard table by hand with Tailwind classes (`border-border`, `text-muted-foreground`, etc.).
- Only theme: **neutral**. `styles.css` = Tailwind input + design tokens on `:root`/`.dark` (`--background, --foreground, --muted-foreground, --primary, --primary-foreground, --destructive, --destructive-foreground, --border, --ring, --shadow-xs, --shadow-sm`) + `@custom-variant dark (&:is(.dark *))` + `@source "./src/**/*.rs"` + `@layer base { body { @apply bg-background font-sans text-foreground; } }`. Installed once, never touched by tooling again — edit freely to rebrand.
- Components take `attrs: attributes! { ... }` (a `class` inside is *merged*, not replaced), variants as enums (`button(variant: ButtonVariant::Destructive, size: ButtonSize::Sm, ...)`), children as content. `button_variants(ButtonVariant::Outline, ButtonSize::Md)` returns the class string for styling an `<a>` as a button.
- If both `src/components.rs` and `src/components/mod.rs` exist, `ui add` **errors** rather than guessing.
- Keep `mod components;` in main.rs; the vendored files are ordinary crate modules.

Usage (from `docs/ui.md` / coffee-shop):
```rust
use crate::components::{
    button::{ButtonSize, ButtonVariant, button, button_variants},
    card::{card, card_content, card_description, card_footer, card_header, card_title},
    input::input,
    label::label,
};
use topcoat::view::{attributes, view};

view! {
    card(
        card_header(card_title("Sign in") card_description("Use your work email."))
        card_content(
            <form method="post" action="/" class="flex flex-col gap-2">
                label(attrs: attributes! { for="email" }, "Email")
                input(attrs: attributes! { id="email" name="email" type="email" required="" })
            </form>
        )
        card_footer(button(attrs: attributes! { type="submit" class="w-full" }, "Sign in"))
    )
}
```

## 9. Scaffold sequence for the leaderboard app (exact order)

```sh
cargo new leaderboard && cd leaderboard
# edit Cargo.toml as in §1 (incl. [build-dependencies]); add build.rs as in §2
cargo install topcoat-cli
topcoat ui init                                   # → components.toml + styles.css
topcoat ui add button card input label badge select checkbox   # what the app needs
touch Topcoat.toml                                # opt-in marker for editor `topcoat fmt`
# write src/main.rs, src/app.rs (layout + pages), src/models.rs, src/components.rs
topcoat dev                                       # http://127.0.0.1:3000
```

## 10. Production build

```sh
cargo build --release
topcoat asset bundle --release          # writes target/release/assets — SAME build as the binary
# deploy the binary with the assets/ dir NEXT TO IT (AssetBundle::load()), then:
HOST=0.0.0.0 PORT=8080 ./leaderboard
```
Or `topcoat asset bundle --release --out dist/assets` + `AssetBundle::load_dir("dist/assets")`. Graceful shutdown on Ctrl+C/SIGTERM is built into `topcoat::start`. Unix-socket serving: `topcoat::serve(tokio::net::UnixListener::bind(path)?, router)`.

## 11. Gotcha round-up

1. Build-deps `topcoat` must be `default-features = false, features = ["tailwind"]` — the docs show this in every example.
2. A dev-profile asset bundle does not describe a release binary; re-bundle per profile, per checkout.
3. Tailwind can't see dynamically-built class names; keep full literal class strings in `.rs` source.
4. Missing `.gitignore` (with `target/` ignored) makes Tailwind scan build artifacts — slow, resurrects dead classes.
5. `view!` text nodes are quoted string literals (`"Sign in"`), interpolation is `(expr)` — not `{}`.
6. `topcoat::dev::script()` and `topcoat::runtime::script()` are components *called inside* `view!` head, not `<script>` tags you write.
7. Bearer-token JSON ingest API needs zero extra features/scaffolding — `#[route(POST)]` handlers are covered by default features (`router`/`serve`); see `crates/topcoat-router/docs/content.md` for JSON extractors (outside this sheet's focus).
8. CLI ↔ crate versions are lockstep; a mismatched `topcoat-cli` prints a warning telling you the exact `cargo install topcoat-cli@<ver> --locked` to run.
9. `topcoat fmt` only formats bodies of macros it recognizes *by name at the call site* — re-exporting `view!` under another name disables formatting.
10. This repo pins Toasty at `0.7` and only ever enables its `sqlite` feature; other backends are unverified here.

Key source files: `crates/topcoat/docs/{getting_started,tailwind,asset,ui,font}.md`, `crates/topcoat/Cargo.toml` (feature graph), `crates/topcoat/src/{serve.rs,dev.rs}`, `crates/topcoat-cli/src/{lib.rs,ui.rs,common/cargo/build.rs}`, `demos/coffee-shop/{Cargo.toml,build.rs,styles.css,components.toml,src/main.rs,src/app.rs}`.


# Topcoat 0.5 Routing Cheat-Sheet: module_router!, layouts, params, POST routes, and real app wiring

# Topcoat v0.5.0 Routing — verified against source at `.reference/topcoat`

Toasty ORM is `0.7`, workspace rust-version `1.95`. Facade crate is `topcoat`; the `discover` and `serve` cargo features are on by default. Coffee-shop deps: `topcoat = { features = ["font-fontsource", "tailwind"] }`, `toasty = { features = ["sqlite"] }`, `tokio` with `rt-multi-thread, macros`, `serde` with `derive`.

## 1. The two wiring styles

**Manual** — chain registrations by function name:
```rust
use topcoat::router::Router;
Router::builder().layout(root_layout).layer(timing).page(home).route(health).build()
```

**Discovery** — link-time collection of every `#[page]/#[layout]/#[layer]/#[route]` across your crate AND dependencies (needs `discover` feature, default-on):
```rust
use topcoat::router::{Router, RouterBuilderDiscoverExt};
Router::builder().discover().build()
```

**`module_router!` (recommended)** — derives URLs from the Rust module tree. It registers *module-derived handlers only* (those whose attribute has no path string) and returns a `RouterBuilder`. Chain `.discover()` to also pick up explicit-path handlers, fonts, procedures, shards. Registration is additive.
```rust
// must be called from the ROOT module of the route tree (that module = "/")
pub fn router() -> topcoat::router::Router {
    topcoat::router::module_router!().discover().build()
}
```

**GOTCHA (vs Next.js):** no filesystem scanning. Every route module must be compiled via a real `mod foo;` declaration (inline `mod foo { ... }` works too — see `examples/module-router/src/app.rs`). Forget the `mod` line → route silently absent.

**GOTCHA:** value-based registrations are never discovered — `.assets(...)`, `.app_context(...)`, `.cookies()`, `.sessions(...)` are always manual. A missing one is NOT a compile error; it panics at the first request that renders the item ("type not registered for the application context" names the missing type).

## 2. How coffee-shop assembles `app::router(db)` (exact source)

```rust
// demos/coffee-shop/src/main.rs
mod app; mod components; mod customer; mod models;
use toasty::Db;

#[tokio::main]
async fn main() {
    let mut db = Db::builder()
        .models(toasty::models!(crate::*))
        .connect("sqlite::memory:").await.unwrap();
    db.push_schema().await.unwrap();
    models::seed(&mut db).await.unwrap();
    topcoat::start(app::router(db)).await.unwrap();  // binds HOST/PORT, default 127.0.0.1:3000
}
```
```rust
// demos/coffee-shop/src/app.rs
use toasty::Db;
use topcoat::{
    Result,
    asset::{AssetBundle, RouterBuilderAssetExt, asset},
    context::Cx,
    cookie::RouterBuilderCookieExt,
    router::{Router, RouterBuilderDiscoverExt, content::Form,
             error::{SeeOther, see_other}, layout, module_router, page, route},
    view::{attributes, view},
};

pub fn router(db: Db) -> Router {
    module_router!()
        .discover()                          // fonts, shards, procedures, explicit-path handlers
        .assets(AssetBundle::load().unwrap())
        .app_context(db)                     // read back via app_context::<Db>(cx)
        .cookies()
        .build()
}
```
```rust
// demos/coffee-shop/src/models.rs — the canonical Db accessor
use toasty::Db;
use topcoat::context::{Cx, app_context};
pub(crate) fn db(cx: &Cx) -> Db { app_context::<Db>(cx).clone() }
```
Session example adds: `.cookies().sessions(SessionConfig::default())` (imports `topcoat::session::{self, RouterBuilderSessionExt, SessionConfig}`).

## 3. Path syntax (explicit paths)
- `/users` static; `/users/{id}` one non-empty segment; `/docs/{*path}` catch-all (≥1 segment, must be last); `/(marketing)/pricing` group — participates in layout/layer matching but stripped from served URL (serves `/pricing`).
- Root is `/`; non-root paths start with `/`, no empty segments; param/group names: ASCII letter or `_` first, then letters/digits/underscores.

## 4. Module → URL mapping (`module_router!`)
| Module | URL |
|---|---|
| `app` (root) | `/` |
| `app::about` | `/about` |
| `app::blog_posts` | `/blog-posts` (**kebab-cased!**) |
| `app::orgs::org_id` (with `path_param!(org_id: i64)`) | `/orgs/{org_id}` |
| `app::_marketing::pricing` (`_` prefix = group) | `/pricing` |

- Function names never affect the URL; two handlers in one module share its path (different methods OK — overlapping methods at one path are rejected at `.build()`; a specific method beats a `*` route).
- `segment!` overrides (top of a non-root module, each key at most once): `segment!(rename = "articles")` (used as-is, NOT kebab-cased), `segment!(kind = Group)`, `kind = Static` (turn `_foo` back into `/foo`), `kind = Param`, `kind = CatchAll`. A module holds at most ONE `path_param!` OR one `segment!` — `path_param!` already emits the segment override, don't combine.
- `module_router!` rejects two module-derived layouts (or two layers) at the same logical path — discovery order is unstable. Stack same-path layers via explicit `.layer()` calls instead (last registered = outermost).

## 5. Pages
```rust
use topcoat::{Result, router::page, view::view};

#[page]                    // module-derived path, GET
async fn home(cx: &Cx) -> Result { view! { <h1>"Home"</h1> } }

#[page("/users/{id}")]     // explicit path (register via .page(user_profile) or .discover())
async fn user_profile() -> Result { view! { <h1>"User"</h1> } }

#[page(POST "/signup")]    // POST answered with a rendered view
async fn signup(Form(input): Form<Signup>) -> Result { view! { <h1>(input.email)</h1> } }
```
- Signature: `async`, returns `Result` (= `Result<View>`). Optional `cx: &Cx`, optional ONE body param implementing `FromRequest` (destructuring like `Json(x): Json<T>` OK), either order — one body max (body is a one-shot stream).
- Methods: `#[page(POST)]`, `#[page([GET, POST])]`, `#[page(*)]` — same forms as `#[route]`.
- Pages double as `view!` components: `contact(body: Form(query))` renders inline, taking the parsed body as a prop.

## 6. Layouts (nesting)
```rust
use topcoat::{Result, context::Cx, router::layout, view::view};

#[layout]   // in root module: wraps EVERY page
async fn shell(cx: &Cx, slot: Result) -> Result {
    view! {
        <!DOCTYPE html>
        <html>
            <head>
                <title>"Little Crema"</title>
                topcoat::dev::script()          // dev reload
                topcoat::runtime::script()      // only if using signals/shards/procedures
                <link rel="stylesheet" href=(tailwind::stylesheet!())>
            </head>
            <body>
                <main>(slot?)</main>
            </body>
        </html>
    }
}
```
- A layout wraps every page whose path starts with the layout's path (`/` wraps all; `/settings` wraps `/settings`, `/settings/profile`, ...). Multiple matches nest least-specific (outermost) → most-specific (innermost).
- Signature: `slot: Result` (that is `Result<View>`) + optional `cx: &Cx`, **recognized by parameter NAME**, no other params allowed.
- Because `slot` is a `Result`, the layout sees page errors before they become responses — a branded 404/403:
```rust
use topcoat::router::{StatusCode, error::NotFoundError};
let content = match slot {
    Err(e) if e.downcast_ref::<NotFoundError>().is_some() => view! {
        (StatusCode::NOT_FOUND)          // keep the 404 status; without it you'd serve 200
        <h1>"Page not found"</h1>
    },
    content => content,
}?;
```
- Layouts also work as components: `root_layout(slot: Ok(content))` inside `view!`.

## 7. Layers (middleware-ish, but NOT Rack/Express)
```rust
use topcoat::{Result, context::Cx, router::{Body, Next, layer, response::Response}};

#[layer]   // in src/app/api.rs → wraps everything under /api
async fn bearer_auth(cx: &mut Cx, body: Body, next: Next<'_>) -> Result<Response> {
    // return early without next.run(...) to short-circuit
    next.run(cx, body).await
}
```
- Prefix rule same as layouts, BUT matching compares the layer's path against each handler's **registered path segments at build time**, never the request URL: a layer at `/docs/admin` wraps neither `/docs/{x}` nor `/docs/{*p}`; a param segment matches only a same-named param; group segments count (layer at `/dashboard` does NOT wrap `/(auth)/dashboard`).
- **Layers only run for matched handlers.** An unmatched 404 runs NO layers and NO layout (405 does run them). Use `not_found!` to make unmatched URLs dispatch normally.
- Discovered layers need unique paths; explicit `.layer()` stacking: last registered = outermost.

## 8. API routes + POST pages (form handling, PRG)
```rust
use topcoat::router::{content::{Json, Form}, route, error::{SeeOther, see_other}};

#[route(GET)]                     // src/app/api/health.rs → GET /api/health
async fn health() -> Result<&'static str> { Ok("ok") }

#[route(POST "/api/users")]       // explicit; needs .route(create_user) or .discover()
async fn create_user(cx: &Cx, Json(input): Json<CreateUser>) -> Result<Json<User>> { ... }
```
- Method is REQUIRED and comes first: `GET`, `[GET, POST]`, or `*` (specific method beats `*` at same path). Returns `Result<T: IntoResponse>` — strings, `StatusCode`, bytes, `(headers, body)` tuples, `Json<T>`. **NOT auto-JSON** — wrap in `Json<T>` explicitly.
- Coffee-shop's form pattern — `#[page]` (GET) and `#[route(POST)]` in the SAME module serve the same path with different methods; Post/Redirect/Get via 303:
```rust
// src/app.rs (root module) — serves POST /
#[derive(serde::Deserialize)] struct SignIn { name: String }

#[route(POST)]
async fn sign_in(cx: &Cx, Form(form): Form<SignIn>) -> Result<SeeOther> {
    match form.name.trim() { "" => forget_customer(cx), name => remember_customer(cx, name) }
    Ok(see_other("/"))   // 303; reload won't resubmit
}
```
- **No `_method` override anywhere in the source** — HTML forms are GET/POST only, so admin CRUD update/delete = POST routes (no PATCH/DELETE from forms).

## 9. Path params — read from `cx`, NOT handler args (violates axum/Next intuition)
```rust
use topcoat::router::{page, path_param};

path_param!(post_id: u64, error = bad_request);   // generates `struct PostId(u64)` (PascalCased)

#[page("/posts/{post_id}")]                        // or module-derived: declare inside the module
async fn post(cx: &Cx) -> Result {
    let post_id: &u64 = path_param::<PostId>(cx)?;  // memoized per request
    ...
}
```
- Under `module_router!`, `path_param!` inside a module turns that module's URL segment into the parameter. **The param name comes from the declaration, not the filename** (`app/menu/drink.rs` with `path_param!(slug)` serves `/menu/{slug}` — real coffee-shop code).
- Untyped: `path_param!(slug)` → `path_param::<Slug>(cx)` returns decoded `&str`, infallible (generates `struct Slug<T: AsRef<str> = String>(T)`).
- Typed without `error =`: returns `Result<&T, &<T as FromStr>::Err>`; pick a response with `RouterErrorExt` (`.ok_or_not_found()?`).
- `error =` forms: `not_found | unauthorized | forbidden | bad_request | bad_request("msg") | redirect("/p") | redirect_permanent("/p")`.
- Catch-all: `path_param!(*doc_path)` → `CatchAllSegments<'_>` (iterator of decoded `&str`, encoded `/` stays inside a segment); typed `path_param!(*ids: u32, error = bad_request)` → `&[u32]`, error names the failing segment index.
- One `path_param!` per module; nest modules for multiples: `app::orgs::org_id::users::user_id` → `/orgs/{org_id}/users/{user_id}`. Descendant modules can read ancestor params (mind Rust visibility: `path_param!(pub(crate) org_id: i64, ...)`).
- Types need `FromStr` + `Send + Sync + 'static` (uuid works: `path_param!(post_id: uuid::Uuid, error = bad_request)` — from `docs/context.md`).
- Reading a name the matched route didn't capture **panics**.
- Coffee-shop drink page pattern (untyped slug + Toasty):
```rust
// src/app/menu/drink.rs → /menu/{slug}
use topcoat::router::{error::RouterErrorExt, page, path_param};
path_param!(slug);

#[page]
async fn drink_page(cx: &Cx) -> Result {
    let slug = path_param::<Slug>(cx);
    let drink = Drink::filter_by_slug(slug).first().exec(&mut db(cx)).await?.ok_or_not_found()?;
    ...
}
```

## 10. Query params
```rust
use topcoat::router::{page, query_params};

#[query_params(error = bad_request)]   // derives serde::Deserialize itself
struct PostsQuery { page: Option<u32>, q: Option<String> }

#[page("/posts")]
async fn posts(cx: &Cx) -> Result {
    let query = query_params::<PostsQuery>(cx)?;   // &PostsQuery, memoized per request
    ...
}
```
- Parsed with `serde_urlencoded`; **`#[serde(default)]` is NOT applied** — any non-`Option` field is required or parsing fails. Use `Option<T>`.
- Query structs are route-independent: any handler/layout/helper with `cx: &Cx` can read one. Query never affects module-derived paths.
- Neat trick from `examples/path-query-params`: `#[query_params(error = redirect("?"))]` — bad query reloads the page with the query string cleared (requires all-`Option` fields, else it loops).

## 11. not_found! (branded 404s)
```rust
use topcoat::router::not_found;
not_found!("/");            // site-wide catch-all; register .page(not_found) or via .discover()
not_found!("/admin");       // subtree only
// or module-derived, inside src/app/admin.rs: topcoat::router::not_found!();
```
Turns unmatched URLs into normal dispatches raising `NotFoundError`, so layouts/layers run and a root layout can render the branded page (Section 6). The prefix URL itself isn't covered (catch-all needs ≥1 segment) — `/` needs its own page.

## 12. Errors
- `topcoat::router::error`: `not_found()`, `unauthorized()`, `forbidden()`, `bad_request(desc)`, `redirect(uri)` (307, an Err), `redirect_permanent(uri)`, `see_other(uri)` (**303, returned as `Ok(SeeOther)`**, not an error), `too_many_requests(secs)`, `service_unavailable(secs)`, `internal_server_error(err)` (wrap to log a source while keeping the opaque 500).
- `RouterErrorExt` on `Option`/`Result`: `.ok_or_not_found()?`, `.ok_or_unauthorized()?`, `.ok_or_forbidden()?`, `.ok_or_redirect(...)?`, ...
- Any non-router error → 500, message never leaked to the client.

## 13. Reading headers / auth (functions, not middleware — Topcoat's stated philosophy)
```rust
use topcoat::router::request::{headers, method, uri, parts, content_type, extensions};

fn bearer_token(cx: &Cx) -> Option<&str> {
    headers(cx).get("authorization")?.to_str().ok()?.strip_prefix("Bearer ")
}
```
Prefer plain `cx: &Cx` guard functions called from handlers (see `docs/functions_not_middlewares.md` and `customer.rs`, which does cookie identity with zero router plumbing). `#[memoize]` / `#[memoize(as_ref)]` (`topcoat::context::memoize`) caches a cx-function per request — coffee-shop uses it so layout + pages share one menu query.

## 14. OriginPolicy — matters for your ingest API
Default policy rejects state-changing **cross-origin browser** requests (403). Requests **without ambient browser credentials — curl, server-to-server, anything with no `Origin` header — always pass**, so a bearer-token JSON ingest endpoint called from scripts works with zero config. GET/HEAD/OPTIONS always pass (except WebSocket upgrades). If browsers on other origins must POST:
```rust
use topcoat::router::OriginPolicy;
.origin_policy(OriginPolicy::new()
    .trust_origins(["https://accounts.example.com"])   // full origin, no trailing slash
    .exempt_paths(["/api/ingest"]))                    // route-path syntax, {param}/{*rest} OK
```

## 15. Leaderboard app: concrete module tree
```
src/
  main.rs                    # Db::builder().models(toasty::models!(crate::*)).connect(...); topcoat::start(app::router(db))
  app.rs                     # module_router!().discover().assets(...).app_context(db).cookies().build()
                             # + root #[layout] shell + #[page] home (public leaderboard)
                             # + not_found!("/") for a branded 404 (register via discover)
  app/
    api.rs                   # `mod ingest;` + #[layer] bearer_auth wrapping all of /api
    api/
      ingest.rs              # #[route(POST)] → POST /api/ingest
                             #   async fn ingest(cx: &Cx, Json(batch): Json<PostBatch>) -> Result<Json<IngestAck>>
    orgs.rs                  # `mod org_id;` — #[page] org list
    orgs/
      org_id.rs              # path_param!(pub(crate) org_id: i64, error = not_found);
                             # #[page] org leaderboard → /orgs/{org_id}; `mod invites;`
      org_id/
        invites.rs           # #[page] GET /orgs/{org_id}/invites + #[route(POST)] create invite → Ok(see_other(...))
    admin.rs                 # #[layout] admin shell that checks auth: match on cx, return Err(forbidden().into())
                             # or downcast in slot; not_found!(); `mod orgs;` etc.
    admin/
      orgs.rs                # #[page] list + #[route(POST)] create; edits/deletes are POST routes (no _method)
```
Key applications of the source patterns:
- **Bearer layer**: `#[layer]` in `app/api.rs` matches `/api` handlers by registered-path prefix; return `Err(unauthorized().into())` before `next.run` to short-circuit. Since layer matching ignores request URLs, keep ingest routes as static-segment modules under `api` (params are fine as long as they're descendants of the `api` segment).
- **Admin guard**: layouts take `cx: &Cx`, so the admin `#[layout]` can call a `current_admin(cx)` helper and short-circuit with an error — but note a layout runs around the *page render*; POST `#[route]`s under `/admin` are NOT wrapped by layouts (layouts wrap pages), so guard POST handlers with the same `cx` helper function, or use a `#[layer]` on the admin subtree for both.
- **Scoring/leaderboard queries**: wrap in `#[memoize(as_ref)] async fn standings(cx: &Cx) -> Result<Vec<Row>>` so the layout badge and the page share one query per request.
- **Invite accept links**: `app/invites/token.rs` with `path_param!(token)` (untyped `&str`, infallible) → `/invites/{token}`.

## 16. Top gotchas vs Rails/Next/React intuition
1. Params come from `cx` via generated marker types (`path_param::<OrgId>(cx)`), never as handler arguments.
2. Route files need `mod` declarations; module names are **kebab-cased** into URLs (`blog_posts` → `/blog-posts`); `segment!(rename=...)` is used verbatim (not kebab-cased).
3. Param name = the `path_param!` declaration, not the filename (no `[id].rs` semantics).
4. `.app_context`/`.assets`/`.cookies` are hand-registered values; forgetting one is a **first-request panic**, not a compile error.
5. Layers skip unmatched 404s entirely, and match by registered handler path segments — not request URLs.
6. Layouts wrap *pages* only (not `#[route]` API handlers) and receive the child as `Result<View>` — error interception happens by matching on `slot`, with an explicit `(StatusCode::...)` in the replacement view to keep the status.
7. JSON responses are opt-in (`Json<T>`); returning a struct is a compile error, not implicit serialization.
8. `see_other("/")` is an **Ok** value (`Result<SeeOther>`); `redirect(...)` (307) is an Err — both exist, use `see_other` for PRG.
9. Query structs: missing non-`Option` field = 400-style parse error; no serde defaults.
10. CSRF is on by default via `OriginPolicy` (403 on cross-origin browser POSTs); non-browser API clients are unaffected.
11. `topcoat::start` reads `HOST`/`PORT` env vars, default `127.0.0.1:3000`.

Source files verified: `crates/topcoat/docs/router.md`, `crates/topcoat/docs/context.md`, `crates/topcoat-router/docs/{module_router,error}.md`, `crates/topcoat-router/macro/docs/{page,layout,layer,route,path_param,query_params,segment,not_found}.md`, `crates/topcoat-router/src/origin.rs`, `demos/coffee-shop/src/{main,app,models,customer}.rs`, `demos/coffee-shop/src/app/{menu.rs,menu/drink.rs}`, `examples/{module-router,path-query-params,session}`.

Unverified/unsupported (don't assume): no `_method` form override found; no built-in per-route rate limiting; layout-wrapping of `#[route]` handlers is not a thing in the docs (layouts explicitly "wrap pages").


# Topcoat 0.5.0: Cx, app_context, #[memoize], functions-not-middlewares auth, and JSON/Form content (verified against source)

# Topcoat cheat-sheet: context, memoize, auth-as-functions, JSON/Form content

Verified against source at `.reference/topcoat` (workspace version **0.5.0**, `toasty = "0.7"`). Key files: `crates/topcoat/docs/{context,app_context,functions_not_middlewares}.md`, `crates/topcoat-core/macro/docs/memoize.md`, `crates/topcoat-router/docs/{content,error}.md`, `crates/topcoat-router/src/content/{json,form}.rs`, `examples/{request-response,app-context,toasty-todo,session}/src/main.rs`, `demos/coffee-shop/src/`.

## 0. `topcoat::Result` — the one type everything returns

```rust
// crates/topcoat/src/lib.rs
pub type Result<T = view::View, E = topcoat_core::error::Error> = ...;
```
- Bare `Result` (pages/layouts/components) means `Result<View, Error>`. Routes use `Result<T>` for any `T: IntoResponse`.
- `topcoat::Error` wraps `anyhow::Error` with a blanket `impl<T: Into<anyhow::Error>> From<T>` — `?` works on toasty errors, serde errors, `std::io::Error`, everything. Errors keep their type: `error.downcast_ref::<ForbiddenError>()` works on the way out.

## 1. Cx + app_context — storing the Toasty `Db` and config

`Cx` is the per-request context. Any page/layout/component/route/helper may take `cx: &Cx` as a parameter — Topcoat injects it when present, and it's fine to omit. There is NO global state, NO `req` object threading, NO DI container.

### Startup: register long-lived values on the router (this is where `Db` lives)

```rust
// exactly as in examples/toasty-todo/src/main.rs
use toasty::Db;
use topcoat::router::{Router, RouterBuilderDiscoverExt};

#[tokio::main]
async fn main() {
    let db = Db::builder()
        .models(toasty::models!(crate::*))
        .connect("sqlite::memory:")   // or "sqlite:app.db" to persist
        .await
        .unwrap();
    db.push_schema().await.unwrap();

    topcoat::start(Router::builder().discover().app_context(db).build())
        .await
        .unwrap();
}
```

- `.app_context(value)` stores by **concrete TypeId**. One value per type; registering the same type twice **panics**. Use newtypes for two of the same underlying type (`struct PrimaryDb(Db); struct ReplicaDb(Db);`).
- Requirement: `T: Any + Send + Sync` (no explicit `'static` needed; `Any` implies it). Values are shared by reference across all requests — put `Arc`-internal handles (Db pool, reqwest client) or a plain config struct here.
- For the leaderboard app: `.app_context(db).app_context(AppConfig { admin_email, invite_base_url, .. })` — one call per type.

### Reading: `app_context::<T>(cx)` and the canonical `db(cx)` helper

```rust
use toasty::Db;
use topcoat::context::{Cx, app_context};

// Toasty statements take &mut Db; cloning Db is cheap (pool handle).
// This exact helper appears in examples/toasty-todo AND demos/coffee-shop.
fn db(cx: &Cx) -> Db {
    app_context::<Db>(cx).clone()
}
// usage: Todo::all().exec(&mut db(cx)).await?
```

- `app_context::<T>(cx) -> &T` **panics** if `T` wasn't registered (startup bug by design). `try_app_context::<T>(cx) -> Option<&T>` for optional values. Wrap lookups in small named fns (`db(cx)`, `config(cx)`).
- Request-scoped analogue: `request_context::<T>(cx)` / `try_request_context::<T>(cx)` read typed values attached to the current request by lower layers/integrations. **No public app-facing API to write request context was found in the source** (only `CxTestBuilder::request_context(...)` for tests; layers register before `next.run`). Don't plan on writing it yourself — use `#[memoize]` functions instead (that's the intended pattern).

### Request read helpers (all take `cx`)

```rust
use topcoat::router::request::{parts, method, uri, version, headers, content_type, extensions};

let ua = headers(cx).get("user-agent").and_then(|v| v.to_str().ok());
let path = uri(cx).path();
```

### Path params & query params (NOT function arguments — read from cx)

```rust
use topcoat::router::{page, path_param, query_params, route};

path_param!(org_id: uuid::Uuid, error = bad_request);   // generates type `OrgId`
// PascalCased declaration name is the type you pass to the reader:

#[query_params(error = bad_request)]
struct LeaderboardQuery { week: Option<u32> }

#[route(GET "/api/orgs/{org_id}")]
async fn show(cx: &Cx) -> Result<String> {
    let org_id = path_param::<OrgId>(cx)?;          // Result; *deref for Copy types
    let q = query_params::<LeaderboardQuery>(cx)?;  // parsed lazily, memoized per request
    Ok(format!("{} week {:?}", *org_id, q.week))
}
```
Rails/Next intuition violation: params are not handler arguments; any function holding `&Cx` can read them.

### `Cx::detach` for work that outlives the response

```rust
let cx = cx.detach();            // owned handle, same app/request context
tokio::spawn(async move { let db = app_context::<Db>(&cx).clone(); /* ... */ });
```
Gotchas: while a detached handle is alive the request context is frozen (writing panics); cookie/response writes from detached work are silently dropped.

## 2. `#[memoize]` — per-request cache (React `cache`, not Redis)

```rust
use topcoat::context::{Cx, memoize};

#[memoize]
async fn get_user(cx: &Cx, id: i64) -> User { db::load_user(id).await }
// call: let user: &User = get_user(cx, 42).await;
```

- Caches for **one request only**, keyed by every arg except `cx`. Works on sync and async fns. Concurrent same-arg async callers share one in-flight future (dedupes parallel component fetches).
- **Return type is rewritten to `&T`** (borrow tied to `cx`). Deref Copy results: `*factorial(cx, 5)`.
- `#[memoize(as_ref)]` borrows contents instead: `Option<T>` → `Option<&T>`, `Result<T, E>` → `Result<&T, &E>` (via `MemoizeAsRef`; implementable for your own types).
- Compile-time requirements: param literally named `cx: &Cx`; no `self`; owned args `Clone + Hash + Eq + Send + Sync + 'static`; borrowed `&P` args need `P: ToOwned` with `P::Owned: Hash + Eq + Send + Sync + 'static` (cloned into the cache once on miss); return `Send + Sync + 'static`.
- Recursion with identical args **panics** (would deadlock); different args fine.

**Gotcha — memoized `Result` gives `&Error`, which does not `?` into `topcoat::Result`.** Real workaround from `demos/coffee-shop/src/models/drink.rs`:

```rust
#[memoize(as_ref)]
async fn query_drinks(cx: &Cx) -> topcoat::Result<Vec<Drink>> {
    Ok(Drink::all().order_by(Drink::fields().menu_order().asc())
        .exec(&mut db(cx)).await?)
}

pub async fn drinks(cx: &Cx) -> topcoat::Result<&Vec<Drink>> {
    query_drinks(cx).await                                  // Result<&Vec<Drink>, &Error>
        .map_err(|error| std::io::Error::other(error.to_string()).into())  // re-own the error
}
```

Leaderboard use: memoize `current_user`, `current_org`, `leaderboard_rows(cx, week)` — layout nav, page, and nested components can each call them; the DB is hit once per request.

## 3. Functions, not middlewares — auth for the leaderboard

Topcoat's philosophy (`functions_not_middlewares.md`): no auth middleware, no extractor-in-signature. Auth = small `cx` functions called wherever the requirement lives. A component that calls `require_auth(cx).await?` is guarded on every page that renders it.

### Canonical stack (adapted from the doc, shaped for this app)

```rust
use topcoat::{
    Result,
    context::{Cx, app_context, memoize},
    router::{
        error::{RouterErrorExt, UnauthorizedError, unauthorized},
        request::headers,
    },
};

fn db(cx: &Cx) -> toasty::Db { app_context::<toasty::Db>(cx).clone() }

#[memoize(as_ref)]
async fn fetch_user(cx: &Cx, user_id: &str) -> Option<User> {
    User::fetch_by_id(user_id).exec(db(cx)).await   // your Toasty query
}

fn session_cookie(cx: &Cx) -> Option<&str> { /* read cookie / session token */ None }

async fn fetch_current_user(cx: &Cx) -> Option<&User> {
    let user_id = session_cookie(cx)?;
    fetch_user(cx, user_id).await
}

async fn require_auth(cx: &Cx) -> Result<&User, UnauthorizedError> {
    fetch_current_user(cx).await.ok_or_unauthorized()
}

async fn require_admin(cx: &Cx) -> Result<&User> {
    let user = require_auth(cx).await?;
    Ok(user.is_admin().then_some(user).ok_or_forbidden()?)   // 403 for non-admins
}
```

`RouterErrorExt` (on both `Option` and `Result`): `ok_or_unauthorized`, `ok_or_forbidden`, `ok_or_not_found`, `ok_or_bad_request(desc)`, `ok_or_redirect(uri)`, `ok_or_redirect_permanent(uri)`.

### Bearer-token auth for the extension sync/ingest API (adapted — no bearer example exists in the repo, but every piece is the documented pattern)

```rust
fn bearer_token(cx: &Cx) -> Option<&str> {
    headers(cx).get("authorization")?
        .to_str().ok()?
        .strip_prefix("Bearer ")
}

#[memoize(as_ref)]
async fn fetch_org_by_token(cx: &Cx, token: &str) -> Option<Org> {
    // look up hashed token in DB via db(cx)
    todo!()
}

async fn require_api_org(cx: &Cx) -> Result<&Org, UnauthorizedError> {
    let token = bearer_token(cx).ok_or_unauthorized()?;
    fetch_org_by_token(cx, token).await.ok_or_unauthorized()
}

// In the ingest route: let org = require_api_org(cx).await?;
```

`UnauthorizedError` responds `401` with plain-text body `"unauthorized"` (`src/error/unauthorized.rs`). There is **no built-in JSON error body**; if the extension needs structured errors, return `Ok((StatusCode::UNAUTHORIZED, Json(ErrBody{..})))` manually instead of the error path.

### Session-based login for the web UI (from `examples/session/src/main.rs`)

```rust
use topcoat::{cookie::RouterBuilderCookieExt, session::{self, RouterBuilderSessionExt, SessionConfig, TokenHash}};

Router::builder()
    .cookies()                                  // required before .sessions
    .sessions(SessionConfig::default())
    .app_context(db)
    .discover()
    .build();

// login route:  let session = session::start(cx).await?;  store (session -> user) yourself
// logout route: if let Some(hash) = session::stop(cx).await? { delete record }
// current user: let Some(hash) = session::token_hash(cx).await? else { return Ok(None) };
```
Sessions are bring-your-own-storage: Topcoat only issues/carries the token; you persist `TokenHash -> user` (in Toasty for this app).

## 4. Content: JSON in / JSON out (the extension sync API), plus Form

Imports (all real, from `examples/request-response/src/main.rs`):

```rust
use topcoat::{
    Result,
    context::Cx,
    router::{
        Body, StatusCode, body_limit, to_bytes,
        content::{Form, Json, RawForm},
        error::bad_request,
        request::{Bytes, FromRequest, headers},
        response::{IntoResponse, Response},
        route,
    },
};
```

### Handler shape rules (`#[route]` macro)

- `#[route(POST "/api/posts")]` — method first (`GET`, `[GET, POST]`, or `*`), optional path string; path omitted = derived from module path under `module_router!()`.
- Signature: async, returns `Result<T: IntoResponse>`. May take `cx: &Cx`, **at most ONE body parameter** (`T: FromRequest` — body is a stream, consumed once), both, or neither; **any order**; destructuring patterns allowed (`Json(input): Json<CreatePost>`).

### JSON request body → JSON response

```rust
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct SyncPayload { posts: Vec<PostStat> }

#[derive(Serialize)]
struct SyncResult { accepted: usize }

#[route(POST "/api/sync")]
async fn sync(cx: &Cx, Json(payload): Json<SyncPayload>) -> Result<(StatusCode, Json<SyncResult>)> {
    let org = require_api_org(cx).await?;                 // bearer auth, see §3
    // ... write payload.posts via db(cx) ...
    Ok((StatusCode::CREATED, Json(SyncResult { accepted: payload.posts.len() })))
}
```

Json facts (from `src/content/json.rs`):
- **Extractor requires `Content-Type: application/json`** (or any `application/*+json`, params/case ignored) — a valid JSON body with `text/plain` or no header is rejected **400**. Make the extension set the header.
- Trailing garbage after the JSON value → 400. Type mismatches → 400 with a `serde_path_to_error` path (e.g. `[1]`) in the description.
- `Option<Json<T>>` → `None` only when the request has **no Content-Type header at all**; a present-but-malformed body still errors (via separate `OptionalFromRequest` trait).
- `Json::<T>::from_bytes(&bytes)` parses without Content-Type checks (useful in custom extractors).
- **Responses are NOT auto-JSON.** `Result<MyStruct>` won't compile/serialize — wrap in `Json(value)`. `Json<T: Serialize>` as return sets `Content-Type: application/json`.

### Tuple responses

Last element = body; leading `StatusCode` sets status; middle elements are `IntoResponseParts` (header arrays, `HeaderMap`, `Extensions`):
```rust
Ok((StatusCode::CREATED, Json(user)))
Ok(([(CONTENT_TYPE, HeaderValue::from_static("text/csv"))], csv_string))
```

### Body limit

Buffering extractors (`Json`, `Form`, `Bytes`, `String`) cap at **2 MiB default**, reject larger with **413**. Raise it per-path (for big sync payloads):
```rust
use topcoat::router::BodyLimit;
Router::builder()
    .layer(BodyLimit::max(32 * 1024 * 1024).at("/api/sync"))
    .build();
```
Raw `Body` parameter bypasses the limit (streaming); reapply manually: `to_bytes(body, body_limit(cx)).await?`.

### Form — doubles as the query-string extractor (Rails intuition violation)

From `src/content/form.rs`: for **GET/HEAD**, `Form<T>` deserializes the **URI query string** (no body, no Content-Type needed); for other methods it reads the body and **requires `Content-Type: application/x-www-form-urlencoded`** (else 400).

```rust
#[derive(Deserialize)] struct Search { q: String, limit: Option<u8> }

#[route(GET "/api/search")]
async fn search(Form(input): Form<Search>) -> Result<Json<SearchResult>> { ... }

// Classic HTML admin-CRUD form + Post/Redirect/Get (from examples/toasty-todo):
use topcoat::router::error::{SeeOther, see_other};

#[derive(Deserialize)] struct NewOrg { name: String }

#[route(POST "/admin/orgs")]
async fn create_org(cx: &Cx, Form(new_org): Form<NewOrg>) -> Result<SeeOther> {
    require_admin(cx).await?;
    toasty::create!(Org { name: new_org.name.trim() }).exec(&mut db(cx)).await?;
    Ok(see_other("/admin/orgs"))     // 303, so reload doesn't resubmit
}
```
`Option<Form<T>>` on GET/HEAD → `None` only when no query string; other methods → `None` when no Content-Type. `RawForm(bytes)` gives the urlencoded bytes unparsed. `Form<T: Serialize>` also works as a response wrapper (urlencoded body).

### Custom FromRequest (e.g. signature-verified webhook)

```rust
struct SignedJson<T>(T);

impl<T: serde::de::DeserializeOwned> FromRequest for SignedJson<T> {
    async fn from_request(cx: &Cx, body: Body) -> Result<Self> {
        let sig = headers(cx).get("x-signature")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| bad_request("missing x-signature header"))?;
        if sig != expected { return Err(bad_request("invalid x-signature header").into()); }
        // Delegate buffering to Bytes so the body limit stays applied:
        let bytes = Bytes::from_request(cx, body).await?;
        Ok(Self(serde_json::from_slice(&bytes)?))
    }
}
```
Trait signature (src/request.rs): `trait FromRequest: Sized { fn from_request(cx: &Cx, body: Body) -> impl Future<Output = Result<Self>> + Send; }` — plain `async fn` in the impl works.

### Custom IntoResponse (note: takes `cx`, returns `Result` — unlike axum)

```rust
struct Csv(String);
impl IntoResponse for Csv {
    fn into_response(self, _cx: &Cx) -> Result<Response> {
        Ok(Response::builder()
            .header("Content-Type", "text/csv; charset=utf-8")
            .body(Body::from(self.0))?)
    }
}
```
Built-in `IntoResponse`: `()`, `StatusCode`, `&'static str`/`String`/`Cow<str>`, byte types, `Bytes`, `Body`, `HeaderMap`, `Extensions`, `Json<T>`, `Form<T>`, tuples, plus `Js`/`Wasm` (response-only media-type wrappers).

## 5. Errors → HTTP (`topcoat::router::error`)

Constructors (each returns a concrete error type convertible into `topcoat::Error`): `bad_request(desc)` 400 (desc IS sent to the client — keep it safe), `unauthorized()` 401, `forbidden()` 403, `not_found()` 404, `redirect(uri)` 307, `redirect_permanent(uri)`, `see_other(uri)` 303 (returned as the **Ok** value `SeeOther`, despite living in `error`), `too_many_requests(secs)` 429 + Retry-After, `service_unavailable(secs)` 503, `internal_server_error(err)` 500 (records the source, hides it from the client). Any other error → 500, message never leaked.

```rust
return Err(not_found().into());                       // explicit
let row = maybe_row.ok_or_not_found()?;               // via RouterErrorExt
```

Catch downstream errors in a layout (branded 403 page, status preserved by putting `StatusCode` inside `view!`):
```rust
#[layout("/")]
async fn root_layout(slot: Result) -> Result {
    let content = match slot {
        Err(e) if e.downcast_ref::<ForbiddenError>().is_some() =>
            view! { (StatusCode::FORBIDDEN) <h1>"Access denied"</h1> },
        content => content,
    }?;
    view! { <html><body>(content)</body></html> }
}
```
Gotcha: a URL matching **no route** is answered directly by the router — no layouts/layers run. Register `not_found!("/");` to route unmatched URLs through your layouts as a `NotFoundError`.

## 6. Things that will surprise a Rails/Next dev

1. Handlers don't get `req`/`params` objects — everything request-scoped comes from `cx` free functions (`headers(cx)`, `path_param::<T>(cx)`, `query_params::<T>(cx)`, `cookies(cx)`).
2. No middleware for auth by design; guards live in the components/routes that need them and memoization dedupes the DB hits. Layers exist but are reserved for transport concerns (compression, tracing, body limits).
3. `app_context` lookups panic when the type is missing — deliberate; wrap in named helpers.
4. Toasty `Db` is cloned per use (`app_context::<Db>(cx).clone()`) because queries take `&mut Db`.
5. JSON is strict: Content-Type mandatory on requests, no auto-serialization of responses, trailing-data rejected.
6. `Form` on GET reads the query string — it is the query extractor for routes (pages have `#[query_params]` instead).
7. `#[memoize]` changes your return type to a reference; memoized `Result`s yield `&Error`, which needs re-owning before `?` (see the coffee-shop `map_err` workaround).
8. Views can `await` and run statements inside `view! { }` (see toasty-todo's `home`), so pages often query inline.
9. Router assembly: `Router::builder().discover()` collects `#[page]/#[route]/#[layout]` at link time, or `module_router!()` derives paths from the module tree; both then `.app_context(..).cookies().sessions(..).build()`.

Unsupported / not found in source: bearer-token examples (pattern above is adapted from documented pieces), a public API for writing request context from app code, built-in JSON error responses, and any cross-request cache — all confirmed absent, plan accordingly.


# Topcoat 0.5.0 Interactive Runtime Cheat-Sheet: signals, shards, procedures, expr!, SSE (for a live leaderboard)

# Topcoat 0.5.0 interactive runtime — verified against source

Workspace facts: `topcoat = "0.5.0"`, `rust-version = "1.95"` (uses `use<>` capture syntax), `toasty = "0.7"`. The runtime guide itself says it is **"highly experimental and fairly limited today"** (`crates/topcoat/docs/runtime.md:3`). Default features already include `runtime`, `router`, `asset`, `discover`; **`sse` is NOT a default feature** (`topcoat = { workspace = true, features = ["sse"] }`), and `datastar` implies `sse`.

## 0. Mandatory page setup (no build step, no wasm)

```rust
use topcoat::{
    Result,
    asset::{AssetBundle, RouterBuilderAssetExt},
    router::{Router, RouterBuilderDiscoverExt, page},
    view::{component, view},
};

#[tokio::main]
async fn main() {
    topcoat::start(
        Router::builder()
            .assets(AssetBundle::load().unwrap()) // REQUIRED: runtime JS is served as an asset
            .discover()                           // registers pages + shards + procedures via inventory
            .build(),
    ).await.unwrap();
}

#[page("/")]
async fn home() -> Result {
    view! {
        <!DOCTYPE html>
        <html>
            <head>
                topcoat::dev::script()      // dev reload script (examples include it)
                topcoat::runtime::script()  // REQUIRED for signals/handlers/shards/procedures
            </head>
            <body> /* ... */ </body>
        </html>
    }
}
```

`topcoat::runtime::script()` is a component rendering `<script type="module" src=(topcoat::runtime::SCRIPT)>`; `SCRIPT` is `asset!("browser/dist/index.js", rename: "topcoat")`. Forget `.assets(AssetBundle::load()...)` and nothing hydrates.

## 1. Signals — browser-only state declared inside `view!`

```rust
view! {
    signal count = 0.0;              // statement INSIDE view! body; initial value is ordinary
    signal query = String::new();    // Rust, evaluated once on the server, serialized into an
    signal open  = false;            // HTML comment: <!-- ::topcoat::signal({"t":"signal","id":<uuid>,"v":...}) -->

    <p>"Count: " $(count.get())</p>
}
```

- Reads/writes only inside `$(...)` runtime expressions: `.get()`, `.set(v)`, plus shorthands `toggle()` (bool), `increment()`/`decrement()` (f64), `push_str(s)` (String).
- **Anti-React gotcha**: a signal write evaluated on the server panics — `"expressions in which a signal is written to cannot be run server-side"` (`surrogate/signal.rs`). Writes must sit inside event-handler closures, which never run during server render.
- The value type must be in the shared vocabulary (f64/bool/String/&str/Option/Result/tuples). No structs.
- Signal IDs are fresh UUIDv4 per server render → signals declared inside a shard **reset on every shard re-render** (documented in `shard.md`: state that must survive lives outside and flows in through arguments).

## 2. `$(...)` / `expr!` — one expression, compiled to Rust AND JavaScript

Server evaluates once for initial HTML; equivalent JS ships in HTML comments (`<!-- ::topcoat::expr::start("js") -->value<!-- ::topcoat::expr::end -->`) and re-runs whenever a signal it read changes (maverick-js/signals effect under the hood).

Supported vocabulary (exact, from `expr.md` + `surrogate/`):
- `f64`: `+ - * /`, comparisons, negation. **All numbers are f64; integer literals are a compile error — write `1.0`, never `1`.** Numbers render with Rust `Display` semantics (`inf`, `-inf`, `-0`, never scientific notation) — the JS side reimplements Rust float formatting.
- `bool`: `!`, `==`/`!=`, `then`, `then_some`.
- `String`/`&str`: `len` (**UTF-8 bytes, not JS UTF-16 units**), `is_empty`, `trim`/`trim_start`/`trim_end` (Unicode `White_Space`, deviates from JS), `starts_with`, `ends_with`, `contains`, `to_owned`, comparisons (by code point).
- `Option<T>`: `is_some`, `is_none`, `unwrap`, `expect`. `Result<T,E>`: `is_ok`, `is_err`, `ok`, `err`, `unwrap`, `expect`, `unwrap_err`, `expect_err`. Tuples of vocabulary types.
- Syntax: literals (string/f64/bool), method calls, field access, indexing, blocks with `let` of plain idents, `if/else` as expression, closures (opt. `async`) + `.await`, `loop`/`while`/`break`/`continue`/`return`. **Rejected: `match`, integer literals, struct expressions, multi-segment paths.**
- Captured outer variables are **serialized snapshots from the server render** — later server changes never reach the browser. Must be vocabulary types.

Escape hatch:
```rust
$({
    let n = name.get();
    raw!("${n}.toUpperCase()", n.to_uppercase())  // JS source, then optional Rust equivalent
})
```
Without the second (Rust) arg the expression can no longer run server-side — usable only in positions that never render on the server. Equivalence between the two sides is on you.

## 3. `@event` handlers

```rust
use topcoat::runtime::Event;

<button @click=$(|_e| count.increment())>"+1"</button>
<input @input=$(|e: Event| query.set(e.target.value))>
<button @click=$(async |_e| {          // async closure to await procedures
    let doubled = double(count.get()).await;
    count.set(doubled);
})>"double"</button>
```

- Value is a runtime expression evaluating to a closure; rendered as `data-topcoat-on:<event>="<js>"`, hydrated with `el.addEventListener(name, e => handler(new Event(e)))`.
- **Any event name works** — the scanner registers whatever follows the prefix, so custom DOM events (`@score-changed=...`) dispatched from hand-written JS are a legit bridge into signals. (This is the only sanctioned-by-source way for outside JS to touch topcoat signals: there is **no global `window.topcoat` API**.)
- `Event` surrogate fields (`surrogate/event.rs`): `target`/`current_target` (`.value`, `.checked`, `.id`, `.name`, `.text_content`), `key`, `code`, `client_x/y`, `alt_key/ctrl_key/meta_key/shift_key`, `delta_x/y/z`, `input_type`, `data`, `event_type`, etc., plus `prevent_default()`, `stop_propagation()`, `stop_immediate_propagation()`. Missing DOM fields resolve laxly in the browser (0 / "" / false).
- Raw JS string form `@click="alert('hi')"` is documented, **but the shipped browser runtime evaluates the attribute string once at hydration** (`new Function("cx", "return " + value)(ctx)` in `browser/src/event.ts`) and uses the *result* as the handler. A bare statement like `alert('hi')` therefore fires at page load and clicking throws. If you use the string form, make the string a JS function expression: `@click="e => alert('hi')"`. Treat this as a doc/runtime discrepancy.
- Coffee-shop demo pattern for components: forward handlers via `attrs: attributes! { @click=$(...) }`.

## 4. `:bind` attributes

```rust
<p :hidden=$(!open.get())>"..."</p>
<input :value=$(name.get()) @input=$(|e: Event| name.set(e.target.value))>  // two-way sync
```

- Server renders the plain attribute + a `data-topcoat-bind:<name>="<js>"` twin; the browser re-applies on signal change.
- `value`, `checked`, `selected`, `indeterminate` are set as **DOM properties**, not attributes (`browser/src/binding.ts`).
- `false`/`None` removes the attribute; `true` sets an empty attribute.

## 5. `#[procedure]` — browser-callable async server fn

```rust
use topcoat::{Result, context::Cx, runtime::procedure};

#[procedure]
async fn place_order(cx: &Cx, drink: String, quantity: f64) -> Result<String> {
    // cx is filled from the request; NOT part of the client call signature
    Ok(format!("{quantity} x {drink}"))
}
// call site, inside a runtime expression, cx omitted:
// let msg = place_order(name.to_owned(), quantity.get()).await;
```

Facts from `grammar/src/procedure.rs` + `src/procedure.rs`:
- Must be `async`, must have a return type, no `self`. Arg types and the `Ok` type must be vocabulary types. Return type is `Result<T>`.
- Expands to a `const` of `Procedure<(Args,), T>` — the fn name becomes a value you can pass to `Router::builder().procedure(place_order)` (or rely on `.discover()`; `inventory` submits it).
- Served as `POST /_topcoat/procedures/<uuid>` with a JSON array body. **The UUID is generated at macro expansion, i.e. changes every compile — never treat a procedure as a stable public API endpoint.** For your bearer-token ingest API use `#[route(POST "/api/sync")]` + `topcoat::router::content::Json<T>` + `topcoat::router::request::headers(cx)` for the `Authorization` header instead.
- Calling a procedure **on the server panics** (`"procedures cannot be executed on the server"`) — the call must sit inside a closure body that only runs in the browser. The type-check still happens server-side.
- Errors: an `Err` becomes an HTTP error; in the browser the awaiting expression just throws (`Procedure call failed: <status>`) and **the error is not observable from the expression**. If the client must react, encode the outcome in the `Ok` type, e.g. `Result<Result<String, String>>`.
- **Security: every procedure is an open endpoint. Args can be spoofed. Re-auth with `cx` inside each procedure** (session check, org membership, etc.). Page/layout guards do NOT apply.

## 6. `#[shard]` — server re-rendered fragment keyed on signal-tracked args

```rust
use topcoat::{Result, context::Cx, runtime::{Event, shard}, view::{component, view}};

#[component]
async fn leaderboard_widget(cx: &Cx, competition_id: String) -> Result {
    view! {
        signal refresh = 0.0;   // bump to force a server re-render

        // custom-event bridge: raw JS (SSE/EventSource) dispatches
        // `new CustomEvent("scores-changed")` on this element
        <div @scores-changed=$(|_e| refresh.increment())>
            leaderboard_rows(competition: $((raw!("undefined", competition_id.as_str())).to_owned()), version: $(refresh.get()))
        </div>
    }
}

#[shard]
async fn leaderboard_rows(cx: &Cx, competition: String, version: f64) -> Result {
    let user = require_auth(cx).await?;          // MUST re-authorize: layout guards never run here
    let rows = top_scores(cx, &user, &competition).await?;
    view! {
        for (rank, row) in rows.into_iter().enumerate() {
            <div>((rank + 1)) ". " (row.name) " — " (row.score)</div>
        }
    }
}
```
(Simpler than the raw! contortion above: capture plain `String` args directly — `leaderboard_rows(competition: $(comp_id_string), version: $(refresh.get()))` works because a captured `String` is a vocabulary snapshot; see `examples/shard/src/main.rs` which passes `combobox_content(input: $(input.get()))`.)

Facts from `shard.md`, `grammar/src/shard.rs`, `browser/src/scope.ts`:
- Call site is component syntax with **named args**, each an `Expr<T>` (`$(...)`). `cx: &Cx` param is implicit at call site. Return type is `Result` (a view).
- Initial page render runs the shard inline (no extra request). Rendered wrapped in `<!-- ::topcoat::scope::start(id, "/_topcoat/shards/<uuid>", ["argJs", ...]) --> ... <!-- ::topcoat::scope::end(id) -->`.
- When any signal read by any arg expression changes: changes in the same tick coalesce (microtask), a `POST /_topcoat/shards/<uuid>` fires with a JSON array of current arg values, **an in-flight request is aborted (latest wins)**, and the returned HTML wholesale replaces the region, then re-scans (nested signals/handlers/shards hydrate).
- **State inside a shard resets on every re-render** (fresh signal UUIDs). Keep durable state outside, pass it in.
- Shard endpoint runs the shard fn alone: **page/layout guards are skipped; do authz inside, covering the argument values too** ("confirm the current user may see the data the arguments select").
- Registration: `.discover()` or `Router::builder().shard(leaderboard_rows)` via `runtime::RouterBuilderShardExt`.
- Shard endpoints are also compile-time-random UUID paths — same "not a public API" caveat.

## 7. SSE (`topcoat-router`, feature `sse` — not default)

```toml
topcoat = { version = "0.5.0", features = ["sse"] }
futures-core = "..."   # for Stream
futures-util = "..."   # stream::unfold etc.
```

```rust
use futures_core::Stream;
use futures_util::stream;
use topcoat::{
    Result, context::Cx,
    router::{content::sse::{Event, KeepAlive, Sse, last_event_id}, route},
};

#[route(GET "/events/scores")]
async fn score_events(cx: &Cx) -> Result<Sse<impl Stream<Item = Result<Event>> + use<>>> {
    let next = last_event_id(cx).and_then(|id| id.parse::<u64>().ok()).map_or(0, |l| l + 1);
    let cx = cx.detach();  // owned handle; the stream MUST NOT borrow cx (hence `use<>`)
    let events = stream::unfold(next, move |seq| { let cx = cx.clone(); async move {
        // await your broadcast/watch channel here
        let ev = Event::new().event("scores-changed").id(seq.to_string()).data("bump");
        Some((Ok(ev), seq + 1))
    }});
    Ok(Sse::new(events).keep_alive(KeepAlive::new()))  // empty comment after 15 idle secs
}
```

- `Event::new()` builders: `.data(str)`, `.json_data(&Serialize)`, `.event(name)`, `.id(str)`, `.retry(Duration)`.
- The `use<>` bound is required (stream must not capture `&Cx`); use `cx.detach()` for an owned `Cx` reading the same app/request context.
- Client disconnect drops the stream → tie cleanup to `Drop`. Reconnect resume via `Last-Event-ID` + `last_event_id(cx)`.
- Client side is plain `EventSource` in hand-written JS (see `examples/sse/src/feed.js`). A stream that ends looks like a dropped connection — the client must `.close()` on a terminal event or the browser reconnects and replays.

## 8. Live-updating leaderboard: what the source actually supports

**There is no built-in SSE→signal/shard bridge.** The browser runtime (`topcoat-runtime/browser/src`) contains zero `EventSource`/`WebSocket`/`setInterval` code, and exposes no global JS API. Verified options, most realistic first:

1. **SSE + custom-event bridge + shard (recommended, all in-source primitives):** an ordinary `<script src=(asset!("./live.js"))>` opens `EventSource("/events/scores")`; on `scores-changed` it does `document.getElementById("lb").dispatchEvent(new CustomEvent("scores-changed"))`. The element carries `@scores-changed=$(|_e| refresh.increment())`; the `refresh` signal is an arg of the leaderboard shard, so each push triggers one coalesced server re-render with fresh DB data. Every piece is verified: arbitrary event names attach via `addEventListener`, shard re-fetch on arg-signal change, SSE route. Server side, publish "changed" ticks from your `/api/sync` ingest route through a `tokio::sync::broadcast` stored in app context.
2. **Datastar integration (feature `datastar`)**: separate client script (CDN or vendored via `asset!`); server pushes `PatchElements::new(view.render(cx)).selector("#leaderboard")` / `PatchSignals` events over the same `Sse` response. Real push-rendering, but it is a second reactive system — Datastar signals are unrelated to topcoat runtime signals; don't mix them on one page region.
3. **Polling**: `live.js` with `setInterval(() => el.dispatchEvent(new CustomEvent("scores-changed")), 15000)` into the same `@scores-changed` handler. Dumb, robust.

**Experimental / avoid for this app:** `raw!` timers inside expressions (server-equivalence is on you and there's no clean "browser-only" position outside handlers); string-literal `@event="js"` handlers (hydration-time evaluation bug above); anything needing `match`, integers, or structs in `$(...)`; signals holding rows/lists (not in the vocabulary — render lists on the server via shards instead).

## 9. App-shaped guidance (orgs, invites, bearer ingest, scoring, admin CRUD)

- **Ingest API** (`POST /api/sync`, bearer token): plain `#[route]`, never a procedure (unstable UUID path, JSON-array protocol). `let auth = topcoat::router::request::headers(cx).get("authorization")...`; body via `topcoat::router::content::Json<Payload>` extractor. After scoring, `broadcast.send(())` to wake SSE streams.
- **DB access anywhere (pages, shards, procedures)**: Toasty `Db` in app context — `Router::builder().app_context(db)`; helper `fn db(cx: &Cx) -> Db { app_context::<Db>(cx).clone() }` (clone is cheap, handles a pool); queries like `Score::filter_by_competition(id).exec(&mut db(cx)).await?` (toasty-todo/coffee-shop pattern). Models: `#[derive(toasty::Model)]` with `#[key] #[auto] id: u64`, schema pushed via `db.push_schema().await`.
- **Leaderboard page**: server-render rows in a shard; scores as `f64` fit the expr vocabulary if you ever surface them client-side; ranks computed server-side (no integers in exprs).
- **Admin CRUD**: procedures are fine for small mutations (`rename_competition(id_as_string, name)` returning `Result<String>`), but every procedure must re-check the admin session via `cx` — guards don't run. For forms-heavy CRUD, classic `#[route(POST ...)]` + `Form` + redirect (toasty-todo pattern) is less experimental than procedures.
- **Search/filter UIs** (member pickers, invite lists): the shard-as-combobox pattern from `examples/shard/src/main.rs` — input signal → `results(query: $(q.get()))`.
- **IDs across the wire**: pass entity ids as `String` (vocabulary); parse/authorize server-side.

## 10. Rails/Next intuition violations, condensed

1. Signals ≠ server state: browser-only, initialized from one server snapshot; captured vars are frozen at render.
2. Two panics lurk on the server: signal writes and procedure calls in positions that execute during server render.
3. Component-level "props drilling" for shard state: shard-internal state resets wholesale on each re-render.
4. Guards/middleware don't wrap shard/procedure endpoints — authorization is per-function, by hand, every time (this is the framework's stated philosophy: functions on `cx`, not middleware).
5. `$(...)` is a different language: no ints, no `match`, no structs, f64 everywhere, Rust string semantics in JS.
6. No client build, no npm — but also no ecosystem: any client behavior beyond the vocabulary is hand-written JS in an `asset!`.
7. Procedure/shard URLs are compile-time UUIDs — public APIs must be `#[route]`s.
8. Procedure errors are invisible to the caller; model fallible outcomes in the Ok type.
9. SSE needs `features = ["sse"]`, `use<>` on the stream type, and `cx.detach()` — three things a Rails dev would not guess.



# Toasty ORM 0.7 in Topcoat 0.5 — Complete Cheat-Sheet (models, relations, queries, macros, sqlite, seeding)

# Toasty ORM 0.7 Cheat-Sheet (as used by Topcoat 0.5.0)

Verified against: `demos/coffee-shop`, `examples/toasty-todo` in the topcoat repo, and the exact `toasty-0.7.0` / `toasty-macros-0.7.0` / `toasty-driver-sqlite-0.7.0` sources pinned in the repo's Cargo.lock. Topcoat does NOT re-export toasty — it is a separate dependency.

## 1. Dependencies (exact, from the demos)

```toml
[dependencies]
serde = { version = "1", features = ["derive"] }
toasty = { version = "0.7", features = ["sqlite"] }   # add "jiff" for timestamps, "serde" for toasty::Json<T>
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
topcoat = "0.5"
```

Toasty has **no default features**. Drivers: `sqlite`, `postgresql`, `mysql`, `dynamodb`, `turso`. Extras: `jiff` (timestamps), `serde` (Json<T>), `migration`, `rust_decimal`, `bigdecimal`.

## 2. Boot sequence (real code from `examples/toasty-todo/src/main.rs`)

```rust
use toasty::Db;
use topcoat::{Result, context::{Cx, app_context}, router::{Router, RouterBuilderDiscoverExt}};

#[tokio::main]
async fn main() {
    let mut db = Db::builder()
        .models(toasty::models!(crate::*))     // link-time discovery of ALL #[derive(Model)] in this crate
        .connect("sqlite::memory:")            // or "sqlite:todos.db" for a file
        .await
        .unwrap();

    db.push_schema().await.unwrap();           // creates tables + indices (dev-style; not a migration system)
    models::seed(&mut db).await.unwrap();      // optional seeding — see §12

    topcoat::start(Router::builder().discover().app_context(db).build())
        .await
        .unwrap();
}

// THE canonical per-request Db accessor. Cloning Db is cheap (Arc'd pool handle).
// Needed because every .exec() takes `&mut dyn Executor`.
fn db(cx: &Cx) -> Db {
    app_context::<Db>(cx).clone()
}
```

### SQLite URL forms (from `toasty-driver-sqlite-0.7.0/src/lib.rs`)
- In-memory: `"sqlite::memory:"` (scheme `sqlite`, path `:memory:`). Both demos use this.
- File: `"sqlite:todos.db"` or `"sqlite:/abs/path.db"` — **single colon, no `//`**. `sqlite://foo.db` parses `foo.db` as URL *host*, not path — do not use double-slash.
- Alternatively build the driver yourself: `Db::builder().models(...).build(toasty_driver_sqlite::Sqlite::open("app.db")).await` / `Sqlite::in_memory()`.
- Gotcha: in-memory SQLite forces the pool to **1 connection** (a warning is emitted if you asked for more); each fresh connect to `:memory:` is a brand-new DB.
- `db.reset_db()` drops and recreates an empty DB (file is deleted). `push_schema()` only creates — it does not ALTER existing tables when your models change; for a file DB during dev, delete the file or `reset_db()`.

## 3. `#[derive(Model)]` — full attribute reference (toasty-macros 0.7.0)

```rust
#[derive(Debug, toasty::Model)]
// #[table = "legacy_users"]            // optional; default = pluralized snake_case ("User" -> "users")
struct User {
    #[key]                              // primary key (field-level)
    #[auto]                             // i8..i64/u8..u64 => AUTOINCREMENT; uuid::Uuid => UUIDv7; #[auto(uuid(v4))] for v4
    id: i64,

    #[unique]                           // unique index; generates filter_by_email / get_by_email / etc.
    email: String,

    #[index]                            // non-unique index; ALSO required to get filter_by_* methods
    org_id: i64,

    #[default(0)]                       // applied on create when omitted
    view_count: i64,

    // requires toasty feature "jiff":
    #[default(jiff::Timestamp::now())]
    created_at: jiff::Timestamp,
    #[update(jiff::Timestamp::now())]   // (re)applied on every create AND update unless set explicitly
    updated_at: jiff::Timestamp,
    // MAGIC: `#[auto]` on a field literally named created_at/updated_at expands to the two lines above.

    #[column("user_email")]             // rename column; #[column(type = varchar(255))] to set DB type; both combinable
    alias: String,
}
```

- Composite PK (struct-level, mutually exclusive with field-level `#[key]`): `#[key(name)]`, `#[key(partition = user_id, local = id)]`, `#[key(partition = [tenant, org], local = [id])]`. On SQL backends partition/local is just a composite PK.
- `#[version]` field attr exists for optimistic locking (update/delete gain a version condition; failure = `is_condition_failed()`).
- Constraints: named fields only, no generics, exactly one PK definition style. `#[auto]` can't combine with `#[default]`/`#[update]`.
- **There is NO struct-level composite secondary index syntax.** Composite `filter_by_a_and_b` methods only exist for composite PKs. For a composite unique (e.g. member+post URN), make it the composite PK or synthesize a single unique string column.
- Field types with built-in support: `String`, `bool`, `i8..i64`, `u8..u64`, `f32`, `f64`, `isize`, `usize`, `uuid::Uuid`, `Vec<u8>` (blob), `Option<T>` of these, `Vec<T>` collection fields (list semantics with `stmt::push` etc.), jiff types (`Timestamp`, `Zoned`, `civil::Date/Time/DateTime`) behind `jiff` feature, `toasty::Json<T>` behind `serde` feature (`Option<Json<T>>` = nullable column; `Json<Option<T>>` = JSON `"null"`).

## 4. Relations

FK column lives explicitly on the child, alongside the relation field:

```rust
#[derive(Debug, toasty::Model)]
struct Org {
    #[key] #[auto] id: i64,
    name: String,
    #[has_many]
    members: toasty::Deferred<Vec<Member>>,   // Deferred = lazy (default queries skip it)
}

#[derive(Debug, toasty::Model)]
struct Member {
    #[key] #[auto] id: i64,
    #[index]                                   // index the FK yourself — not automatic
    org_id: i64,
    #[belongs_to(key = org_id, references = id)]
    org: toasty::Deferred<Org>,
}
```

- Lazy vs eager: `Deferred<T>` / `Deferred<Option<T>>` / `Deferred<Vec<T>>` = lazy; bare `T` / `Option<T>` / `Vec<T>` = eager (loaded on every query). **Eager cycles are a compile error** — at least one side of a bidirectional pair must be `Deferred`.
- `Deferred` API: `.get() -> &T` (**panics if not loaded**), `.is_unloaded()`, `.into_inner()`, `.unload()`. Load with `.include(...)`: `Org::filter_by_id(id).include(Org::fields().members()).get(&mut db).await?`.
- Optional FK: `#[index] manager_id: Option<i64>` + `#[belongs_to(key = manager_id, references = id)] manager: toasty::Deferred<Option<User>>`.
- Composite FK: `#[belongs_to(key = [a, b], references = [x, y])]`.
- `#[has_one]` mirrors has_many for 1:1 (target still holds the belongs_to).
- Disambiguation: `#[has_many(pair = parent)]` when target has multiple belongs_to to the same model / self-referential (`Self` allowed as relation type).
- Multi-hop: `#[has_many(via = comments.article)]` — read-only, distinct targets, no pair.
- Instance accessors (generated): `org.members()` returns a scope with `.exec(&mut db) -> Vec<Member>`, `.filter(expr)`, `.create()` (FK auto-set), `.insert(&mut db, item)`, `.remove(&mut db, item)`, plus all `filter_by_*`/`get_by_*` of the target. `member.org()` returns a One scope: `.exec(&mut db) -> Org`.
- Scoped create via macro: `toasty::create!(in org.members() { display_name: "..." }).exec(&mut db).await?` — FK set automatically.

## 5. `#[derive(Embed)]` — embedded structs & enums (no own table)

```rust
#[derive(Debug, Clone, Copy, toasty::Embed)]     // real example: Roast in coffee-shop
pub enum Roast { Light, Medium, Dark }
```

- Coffee-shop omits `#[column(variant = N)]` — in 0.7.0 omitted discriminants default to the **snake_case variant name stored as a string** (`"light"`, ...). Explicit `#[column(variant = 1)]` stores an i64 instead. (The rustdoc says "required" — the parser in `model/schema/model.rs` says otherwise; the coffee-shop demo compiles without it.) Renaming a variant without an explicit discriminant changes stored data meaning.
- Embedded struct fields flatten to prefixed columns (`address_street`); nesting chains prefixes. Query through parent: `User::filter(User::fields().address().city().eq("Seattle"))`.
- Enum Fields get `is_<variant>()`, `eq`, `ne`, `in_list`; data variants get `.matches(closure)` handles.
- Partial update of an embed: `update!(doc { meta: { version: 2 } })` or `stmt::patch(Metadata::fields().version(), 2)` inside `stmt::apply([...])`.

## 6. Generated API per model (what `#[derive(Model)]` gives you)

Statics: `User::all() -> UserQuery`, `User::filter(expr)`, `User::create() -> UserCreate`, `User::create_many()`, `User::fields()` (typed paths), `User::delete(self) -> stmt::Delete<()>` (consumes instance), `user.update() -> UserUpdate`.

Per indexed field-chain (PK, `#[unique]`, `#[index]`; composite only for composite PK, named `_and_`):
- `User::filter_by_id(v) -> UserQuery`
- `User::get_by_id(&mut db, v).await? -> User` (errors `RecordNotFound` if missing)
- `User::update_by_id(v) -> UserUpdateQuery`
- `User::delete_by_id(&mut db, v).await? -> ()`

Real usage from toasty-todo:
```rust
let mut todo = Todo::get_by_id(&mut db, *path_param::<TodoId>(cx)?).await?;
Todo::delete_by_id(&mut db(cx), *path_param::<TodoId>(cx)?).await?;
```

## 7. Query builder

```rust
let todos = Todo::all()
    .order_by(Todo::fields().id().asc())      // .desc() too; runs INSIDE view! bodies fine
    .exec(&mut db(cx))                        // -> Vec<Todo>
    .await?;
```

Query methods: `.filter(Expr<bool>)` (ANDs onto existing), `.order_by(path.asc()/desc())`, `.limit(n)`, `.offset(n)`, `.include(path)`, `.first() -> Query<Option<M>>`, `.one() -> Query<M>`, `.get(&mut db) -> M` (= `.one().exec()`), `.count() -> Query<u64>`, `.select(projection)`, `.delete() -> Delete<()>`, `.update() -> UpdateQuery`, `.paginate(per_page) -> Paginate` (cursor: `.after(key)` / `.before(key)`, exec -> `Page` with `.has_next()`, `.next(&mut db)`), `.latest_by(path)`, plus relation hops (`OrgQuery::members() -> MemberQuery`) and all `filter_by_*`.

**Gotcha: `.offset(n)` PANICS unless `.limit(n)` was called first** (and offset is incompatible with cursor pagination).

Field expression ops (`User::fields().name()...`): `eq ne gt ge lt le`, `in_list`, `in_query`, `asc desc`; strings: `starts_with`, `like`, `ilike`; Options: `is_none is_some`; lists: `contains is_superset intersects len is_empty any all`. Combine: `.and()`, `.or()`, `.not()`, `toasty::stmt::Expr::and_all([...])`.

### `toasty::query!` macro (equivalent sugar)
```rust
toasty::query!(User FILTER .active == true AND .age >= #min_age ORDER BY .name ASC OFFSET 20 LIMIT 10)
// clause order fixed: FILTER, ORDER BY, OFFSET, LIMIT (keywords case-insensitive)
// #var = capture variable, #(expr) = arbitrary Rust expr, .field = User::fields().field()
```
Returns a builder — still needs `.exec(&mut db).await?`.

## 8. `create!`

```rust
// single — returns builder; NOTHING happens until .exec
let todo = toasty::create!(Todo { title, done: false }).exec(&mut db).await?;   // shorthand `title` = title: title

// batch (seed style, from coffee-shop models.rs) -> Vec<Drink>
toasty::create!(Drink::[
    { slug: "espresso", name: "Espresso", price: 3.0, roast: Roast::Dark, menu_order: 0 },
    { slug: "cold-brew", name: "Cold Brew", price: 4.0, roast: Roast::Dark, menu_order: 1 },
]).exec(db).await?;

// tuple -> (User, Post); mixed with batches ok
let (user, post) = toasty::create!((User { name: "A" }, Post { title: "Hi" })).exec(&mut db).await?;

// scoped through a relation (FK auto-set)
toasty::create!(in user.todos() { title: "buy milk" }).exec(&mut db).await?;

// nested relations, NO type prefix on the nested literal:
toasty::create!(Todo { title: "x", user: { name: "Alice" } });           // belongs_to/has_one
toasty::create!(User { name: "A", todos: [{ title: "1" }, { title: "2" }] }); // has_many
```

Omittable fields: `#[auto]`, `Option<T>` (-> NULL), `#[default]`, `#[update]`, relations. **Missing required fields are NOT a compile error — they fail at runtime as a DB constraint violation.** `&str` works wherever `String` is expected (`impl IntoExpr`).

## 9. `update!` (and builders)

```rust
// instance target — auto-borrows &mut, and RELOADS the instance fields after exec
let mut todo = Todo::get_by_id(&mut db, id).await?;
let done = !todo.done;
toasty::update!(todo { done }).exec(&mut db).await?;      // real code from toasty-todo

// query target (no fetch round-trip)
toasty::update!(Todo::filter_by_id(id) { done: true }).exec(&mut db).await?;

// chain form equivalent:
todo.update().done(true).exec(&mut db).await?;

// list-field combinator shorthand: field.push(x) == field: toasty::stmt::push(x)
toasty::update!(article { tags.push("rust") }).exec(&mut db).await?;
// embed patch: meta: { version: 2 }  — partial; has_many insert: todos: [{ title: "new" }]
```
`toasty::stmt` combinators: `set`, `push`, `insert`, `remove`, `remove_at`, `patch`, `apply`.

## 10. Delete — there is NO `delete!` macro

```rust
Todo::delete_by_id(&mut db, id).await?;                       // by PK/unique/index
todo.delete().exec(&mut db).await?;                           // consumes instance
Post::filter(Post::fields().member_id().eq(mid)).delete().exec(&mut db).await?;  // bulk
```

## 11. Transactions & raw SQL

```rust
let mut tx = db.transaction().await?;      // takes &mut Db — clone the Db first if you need another handle
toasty::create!(User { name: "A" }).exec(&mut tx).await?;   // Transaction implements Executor
tx.commit().await?;                        // or tx.rollback(); auto-rollback on drop
```

Raw SQL (the escape hatch you WILL need for leaderboard aggregates — the builder only has `.count()`, no SUM/GROUP BY):
```rust
// SQLite placeholders are ?1, ?2 ... (Postgres $1, MySQL ?)
let rows: Vec<toasty_core::stmt::Value> = toasty::sql::query(
    "SELECT member_id, SUM(reactions + 2*comments + 3*reshares) AS score \
     FROM posts GROUP BY member_id ORDER BY score DESC LIMIT ?1",
).bind(50_i64).exec(&mut db).await?;
for row in rows {
    let rec = row.into_record();           // fields in selected-column order; Value::I64/String/...
}
let n: u64 = toasty::sql::statement("DELETE FROM posts WHERE member_id = ?1").bind(mid).exec(&mut db).await?;
```
Raw SQL is backend SQL verbatim: no identifier quoting, no model hydration; table names are the pluralized snake_case defaults (`Post` -> `posts`) unless `#[table]`/`table_name_prefix` used. Use `.column_types([...])` when SQLite type inference is ambiguous (bools, uuids).

## 12. Seeding (real pattern from coffee-shop)

```rust
// models.rs
pub async fn seed(db: &mut Db) -> toasty::Result<()> {
    toasty::create!(Drink::[ { ... }, { ... } ]).exec(db).await?;
    Ok(())
}
// main.rs: db.push_schema().await.unwrap(); models::seed(&mut db).await.unwrap();
```
The demos seed unconditionally because the DB is in-memory (fresh each boot). On a file DB, guard it: `if Drink::all().count().exec(&mut db).await? == 0 { seed(...) }` — there is no upsert/idempotent-seed helper.

## 13. Topcoat integration patterns

```rust
// per-request memoized query (coffee-shop drink.rs) — caches for the request
use topcoat::context::{Cx, memoize};
#[memoize(as_ref)]
async fn query_drinks(cx: &Cx) -> topcoat::Result<Vec<Drink>> {
    Ok(Drink::all().order_by(Drink::fields().menu_order().asc()).exec(&mut db(cx)).await?)
}
pub async fn drinks(cx: &Cx) -> topcoat::Result<&Vec<Drink>> {
    // memoize(as_ref) returns Result<&T, &E>; &Error can't move out, so re-wrap:
    query_drinks(cx).await.map_err(|error| std::io::Error::other(error.to_string()).into())
}
```
- `topcoat::Error` wraps `anyhow::Error` with a blanket `From<T: Into<anyhow::Error>>`, so `?` on `toasty::Result` inside handlers Just Works.
- Queries can be awaited inside `view!` bodies (statements are allowed there).
- Handler shape (toasty-todo): `#[route(POST "/todos")] async fn create(cx: &Cx, Form(new): Form<NewTodo>) -> Result<SeeOther> { ...; Ok(see_other("/")) }` with `path_param!(todo_id: u64, error = bad_request);` then `*path_param::<TodoId>(cx)?`.

## 14. Errors

`toasty::Error` predicates: `is_record_not_found()` (from `.get()`/`get_by_*` on zero rows — prefer `.first()` -> `Option` for expected-missing like bearer-token lookup), `is_condition_failed()` (`#[version]` conflicts), `is_connection_lost()`, `is_validation()`, etc. **No unique-violation predicate** — duplicate-key inserts surface as `DriverOperationFailed`; check-first or treat driver errors on your unique columns as conflicts.

## 15. Applied to the leaderboard app (orgs / invites / bearer-token ingest / scoring / admin CRUD)

```rust
#[derive(Debug, toasty::Model)]
struct Org {
    #[key] #[auto] id: i64,
    #[unique] slug: String,
    name: String,
    #[has_many] members: toasty::Deferred<Vec<Member>>,
    #[has_many] invites: toasty::Deferred<Vec<Invite>>,
}

#[derive(Debug, toasty::Model)]
struct Member {
    #[key] #[auto] id: i64,
    #[index] org_id: i64,
    #[belongs_to(key = org_id, references = id)] org: toasty::Deferred<Org>,
    display_name: String,
    #[unique] linkedin_urn: String,
    #[unique] api_token: String,          // bearer token — unique gives get_by_api_token/filter_by_api_token
    is_admin: bool,
    #[has_many] posts: toasty::Deferred<Vec<Post>>,
}

#[derive(Debug, toasty::Model)]
struct Invite {
    #[key] #[auto] id: uuid::Uuid,        // UUIDv7, sortable
    #[index] org_id: i64,
    #[belongs_to(key = org_id, references = id)] org: toasty::Deferred<Org>,
    #[unique] code: String,
    redeemed: bool,
}

#[derive(Debug, toasty::Model)]
struct Post {
    #[key] #[auto] id: i64,
    #[index] member_id: i64,
    #[belongs_to(key = member_id, references = id)] member: toasty::Deferred<Member>,
    #[unique] linkedin_post_urn: String,  // dedupe key for ingest
    reactions: i64,
    comments: i64,
    reshares: i64,
    posted_at: String,                    // or jiff::Timestamp with the "jiff" feature
}
```

Bearer auth (expected-missing => `.first()`, not `.get()`):
```rust
let Some(member) = Member::filter_by_api_token(token).first().exec(&mut db).await? else {
    return Err(topcoat::router::error::unauthorized().into());  // (router error API — verify in router docs)
};
```

Ingest upsert (no native upsert — select-then-insert/update; wrap in a transaction for safety):
```rust
match Post::filter_by_linkedin_post_urn(&urn).first().exec(&mut db).await? {
    Some(mut post) => { toasty::update!(post { reactions, comments, reshares }).exec(&mut db).await?; }
    None => { toasty::create!(Post { member_id: member.id, linkedin_post_urn: urn, reactions, comments, reshares, posted_at }).exec(&mut db).await?; }
}
```

Leaderboard: use `toasty::sql::query` (§11) for GROUP BY/SUM, or fetch org members' posts and fold in Rust. Admin CRUD maps directly to `create!` / `update!(Model::filter_by_id(id) {...})` / `Model::delete_by_id`. Invite redeem: `toasty::update!(Invite::filter_by_code(code) { redeemed: true })`.

## 16. Anti-Rails/Next intuition summary

1. Everything is explicit two-phase: builders/macros produce statements; **nothing touches the DB until `.exec(&mut db).await?`**.
2. `.exec` needs `&mut dyn Executor` — hence the `fn db(cx) -> Db` clone helper everywhere; `&mut Db` coerces.
3. Schema = your structs + `push_schema()`. No migrations run implicitly; changing a model does not alter an existing file DB (a `migration` feature/module exists but the demos never use it).
4. FKs are plain fields you declare AND index yourself; the relation field is separate and typed `Deferred<...>` unless you want eager loading. `Deferred::get()` panics when unloaded.
5. `filter_by_*` / `get_by_*` only exist for indexed fields — an un-indexed field gets no finder (use `Model::filter(Model::fields().f().eq(v))`).
6. Missing required create! fields = runtime DB error, not compile error.
7. `offset` panics without `limit`. No `sum`/`group_by` in the builder — raw SQL.
8. No `delete!` macro; no upsert; no unique-violation error type.
9. Instance `update!`/`.update()` refreshes the struct's fields in place after exec (target is `&mut self`).
10. Embed enums silently store snake_case string discriminants unless you pin `#[column(variant = N)]`.

