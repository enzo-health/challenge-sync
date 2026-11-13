// Content script, run only on the Challenge Sync website (see `content_scripts` in manifest.json).
//
// The site has no password form: its get-started page asks "is the extension here, and is this
// person logged in to LinkedIn?". A page cannot talk to an extension directly, so it posts a
// hello to its own window and this script relays it to the service worker and posts the answer
// back. Answering at all is what tells the page the extension is installed.
//
// The relay carries status flags only. Tokens never pass through the page: the worker writes the
// session cookie into the browser's jar itself.
const PAGE = "challenge-sync-page";
const EXTENSION = "challenge-sync-extension";

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!event.data || event.data.source !== PAGE || event.data.type !== "HELLO") return;
  // Since 0.1.4: say "I'm here" at once. The full answer waits for linking and the web session,
  // which can take several seconds, and a page waiting that long would think the extension is
  // off. A bridge left behind in this tab by an extension that has since been switched off or
  // updated has no runtime id, and must not claim to be here.
  if (!chrome.runtime?.id) return;
  window.postMessage({ source: EXTENSION, type: "PRESENT" }, window.location.origin);
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type: "PAGE_HELLO", signedIn: event.data.signedIn === true });
  } catch (err) {
    // The worker was reloaded under this tab (an extension update); the next hello reaches it.
    // Said to the page, so it isn't left believing a "present" with no answer behind it.
    window.postMessage(
      { source: EXTENSION, type: "UNAVAILABLE", errorCode: "extension-unavailable", error: String(err?.message || err) },
      window.location.origin,
    );
    return;
  }
  if (!reply) return;
  window.postMessage(
    {
      source: EXTENSION,
      linkedInSignedIn: Boolean(reply.linkedInSignedIn),
      linked: Boolean(reply.linked),
      needsInvite: Boolean(reply.needsInvite),
      // Since 0.1.4: the server refused the join code (as opposed to there being none), and a
      // short code naming any other failure. The page reads `inviteRefused` being present at all
      // as "this extension tells the invite cases apart"; 0.1.3 lumped them into needsInvite.
      inviteRefused: Boolean(reply.inviteRefused),
      error: reply.error || null,
      errorCode: reply.errorCode || null,
      // Since 0.1.4, for the signed-in banner (see background.js PAGE_HELLO).
      sync: reply.sync || null,
      lastSyncAt: reply.lastSyncAt || null,
      syncError: reply.syncError || null,
      syncErrorCode: reply.syncErrorCode || null,
    },
    window.location.origin,
  );
});
