// The page's half of the conversation with the Challenge Sync extension's content script
// (extension/bridge.js). Shared by the signed-out get-started page and the signed-in "hasn't
// synced" banner, so both send the same hello and read answers the same way.
//
// A page posts a hello to its own window; the bridge relays it to the extension and posts the
// answer back. What can come back:
//   * "present"     (0.1.4 and later) at once: the extension is on and has the hello. The full
//                   answer follows when linking and the web session are done, which can take
//                   seconds.
//   * "unavailable" (0.1.4 and later) the bridge is here but the extension's worker did not take
//                   the message (it was just updated or reloaded under this tab).
//   * "status"      the full answer. Extension 0.1.3 sends only this, and only after linking and
//                   the web session are done.
// No answer at all means the extension is not installed, is switched off, or was switched on after
// this page loaded (Chrome runs the bridge only in pages loaded after that).

export const PAGE_SOURCE = "challenge-sync-page";
export const EXTENSION_SOURCE = "challenge-sync-extension";

export type ExtensionStatus = {
  linkedInSignedIn: boolean;
  linked: boolean;
  /** No join code in this browser (or the server said `join_code_required`). */
  needsInvite: boolean;
  /**
   * The server refused the join code (`join_code_invalid`). Undefined from extensions before
   * 0.1.4, whose bridge did not tell this apart from needsInvite (or from a request the host
   * blocked).
   */
  inviteRefused: boolean | undefined;
  /** A sentence saying what failed, from the extension (errors.js since 0.1.4). */
  error: string | null;
  /** Its short code: "unreachable", "blocked", "server-500", "account_deleted", ... Null before 0.1.4. */
  errorCode: string | null;
  /**
   * Since 0.1.4: what this hello did about syncing ("running", "not-due", "recently-tried",
   * "not-linked"); undefined from 0.1.3, which never syncs because of a hello.
   */
  sync: string | null | undefined;
  lastSyncAt: string | null;
  syncError: string | null;
  syncErrorCode: string | null;
};

export type ExtensionReply =
  | { type: "present" }
  | { type: "unavailable"; error: string | null; errorCode: string }
  | { type: "status"; status: ExtensionStatus };

/** Ask the extension, if it is here, what it can see. `signedIn` pages keep their session. */
export function sayHello({ signedIn = false }: { signedIn?: boolean } = {}): void {
  window.postMessage({ source: PAGE_SOURCE, type: "HELLO", signedIn }, window.location.origin);
}

const str = (value: unknown) => (typeof value === "string" ? value : null);

/** The extension's answer in a window message event, or null when it is something else. */
export function readReply(event: MessageEvent): ExtensionReply | null {
  if (event.source !== window || event.origin !== window.location.origin) return null;
  const data = event.data;
  if (!data || data.source !== EXTENSION_SOURCE) return null;
  if (data.type === "PRESENT") return { type: "present" };
  if (data.type === "UNAVAILABLE") {
    return { type: "unavailable", error: str(data.error), errorCode: str(data.errorCode) ?? "extension-unavailable" };
  }
  return {
    type: "status",
    status: {
      linkedInSignedIn: Boolean(data.linkedInSignedIn),
      linked: Boolean(data.linked),
      needsInvite: Boolean(data.needsInvite),
      inviteRefused: "inviteRefused" in data ? Boolean(data.inviteRefused) : undefined,
      error: str(data.error),
      errorCode: str(data.errorCode),
      sync: "sync" in data ? str(data.sync) : undefined,
      lastSyncAt: str(data.lastSyncAt),
      syncError: str(data.syncError),
      syncErrorCode: str(data.syncErrorCode),
    },
  };
}
