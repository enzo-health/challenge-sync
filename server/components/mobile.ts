// Is the visitor on a phone? The site is a desktop tool (the extension installs only on desktop
// Chrome, and the 3D pages are built for a keyboard), so the shell shows a phone a short notice
// instead of the app (components/mobile-notice.tsx).
//
// Phones only, by what the browser says it is, never by window size: a narrow desktop window is
// still a desktop. Tablets are let through (an Android tablet's browser leaves "Mobile" out of its
// user agent and reports `mobile: false`; iPadOS Safari reports itself as a Mac).
//
// Plain TypeScript with no imports, so scripts/test-mobile-detection.mjs runs it under node.

/** The parts of `navigator` this reads; `navigator` itself fits. */
export interface BrowserIdentity {
  userAgent?: string;
  /** User-Agent Client Hints (Chromium browsers); absent in Safari and Firefox. */
  userAgentData?: { mobile?: boolean } | null;
}

// Phone markers in a user agent: iOS phones, Android phones (Android tablets omit "Mobile"), and
// the older phone platforms. iPads are left out on purpose.
const PHONE_USER_AGENT = /iPhone|iPod|Android.*Mobile|Windows Phone|IEMobile|BlackBerry|BB10|Opera Mini/i;

export function isPhone(browser: BrowserIdentity): boolean {
  // The browser's own answer, when it gives one, beats parsing the user agent string.
  const mobile = browser.userAgentData?.mobile;
  if (typeof mobile === "boolean") return mobile;
  return PHONE_USER_AGENT.test(browser.userAgent ?? "");
}

// Pages a phone may still read. /privacy: the Chrome Web Store listing links to it.
const OPEN_ON_PHONES = new Set(["/privacy"]);

export function isOpenOnPhones(pathname: string): boolean {
  return OPEN_ON_PHONES.has(pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname);
}
