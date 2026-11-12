// Thin wrapper over chrome.storage.local for the extension's own config + status.
// NOTE: we never store LinkedIn credentials here. The only secret is the sync token
// for OUR server. LinkedIn auth stays in the browser's own cookie jar.
const DEFAULTS = {
  syncToken: null,       // set after linking; presence => "linked"
  orgName: null,
  displayName: null,
  memberUrn: null,
  publicIdentifier: null,
  lastSyncAt: null,      // ISO timestamp of last successful sync
  lastError: null,       // human-readable last error, or null
  lastPostsIngested: 0,
  syncJitterMinutes: null, // per-install offset added to the 12h floor, fixed at first sync
  // { memberUrn, urns }: the posts on the latest feed page that the server has accepted from this
  // install. Lets a sync skip re-reading posts past the refresh window (see refresh.js) while
  // still recording an old post it has never delivered. At most one feed page of URNs.
  recordedPosts: null,
};

export async function getState() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export async function setState(patch) {
  await chrome.storage.local.set(patch);
  return getState();
}

export async function isLinked() {
  const { syncToken } = await getState();
  return Boolean(syncToken);
}
