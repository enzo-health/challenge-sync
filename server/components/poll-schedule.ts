// How often the signed-out get-started page (get-started.tsx) asks the extension, and the site,
// whether the person is signed in yet. Plain data, so scripts/test-signin-polling.mjs can read
// the same numbers it checks the page against.
//
// It used to be every 3 seconds, forever, including in a background tab: a /api/auth/me request
// and an extension hello (which itself can call the server and LinkedIn) 20 times a minute. That
// is what Vercel's DDoS mitigation took for a bot and challenged.
//
// Now: quick while someone is likely acting on the page (installing the extension, logging in to
// LinkedIn in another tab), then slower, capped at 30 seconds; nothing at all while the tab is
// hidden; and straight back to quick, with an immediate check, when they return to the tab or
// the extension reports something new.

/** Gaps between extension hellos: the n-th gap is HELLO_DELAYS_MS[n], then the last one forever. */
export const HELLO_DELAYS_MS = [3_000, 3_000, 3_000, 5_000, 5_000, 10_000, 10_000, 30_000];

export function helloDelay(step: number): number {
  return HELLO_DELAYS_MS[Math.min(step, HELLO_DELAYS_MS.length - 1)];
}

/**
 * The site itself (`/api/auth/me`) is asked when the page opens or comes back into view, right
 * after the extension says it is linked (it has just put a session cookie in the browser), and
 * otherwise only this often: the fallback for a sign-in the hello cannot report, such as an
 * extension installed after this tab was opened (Chrome injects its bridge into new pages only).
 */
export const ME_FALLBACK_MS = 60_000;

/**
 * How long the extension may stay silent before a page says it is switched off. Extension 0.1.3
 * answers a hello only after linking and minting a web session (several round trips to our server
 * and possibly LinkedIn), which can take seconds; 0.1.4 says "present" at once. Until this has
 * passed, pages say they are still looking rather than "Chrome paused it".
 */
export const NO_ANSWER_MS = 10_000;

/**
 * While the signed-in "hasn't synced" banner is up (sync-paused.tsx), it asks /api/auth/me again
 * after these gaps (the last one repeating), only while the tab is visible, so the banner clears
 * soon after a sync lands without waiting for a focus change or a reload.
 */
export const BANNER_ME_DELAYS_MS = [30_000, 60_000];

export function bannerMeDelay(step: number): number {
  return BANNER_ME_DELAYS_MS[Math.min(step, BANNER_ME_DELAYS_MS.length - 1)];
}
