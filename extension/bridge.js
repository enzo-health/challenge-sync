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
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type: "PAGE_HELLO" });
  } catch {
    // The worker was reloaded under this tab (an extension update); the next hello reaches it.
    return;
  }
  if (!reply) return;
  window.postMessage(
    {
      source: EXTENSION,
      linkedInSignedIn: Boolean(reply.linkedInSignedIn),
      linked: Boolean(reply.linked),
      needsInvite: Boolean(reply.needsInvite),
      error: reply.error || null,
    },
    window.location.origin,
  );
});
