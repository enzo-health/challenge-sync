// Off-site destinations shared by more than one page.

/** The Challenge Sync extension's Chrome Web Store listing — the one install link for everyone. */
export const EXTENSION_STORE_URL =
  "https://chromewebstore.google.com/detail/challenge-sync-%E2%80%94-linkedin/lipnimkomknkipidfloeigpojfilgjfh";

/**
 * Where the "Chrome paused Challenge Sync" banner sends people to switch the extension back on
 * after Chrome disabled it over the new site permissions (extension 0.1.3). The one place to change
 * it. For now it is the Web Store listing, which shows an "Enable now" button to anyone whose copy
 * is disabled.
 */
export const EXTENSION_REENABLE_URL = EXTENSION_STORE_URL;

export const WRITE_POST_URL = "https://www.linkedin.com/feed/?shareActive=true";
