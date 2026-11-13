// The generated nextrs client, pointed at the user's configured server.
//
// `client.js` is generated from the Rust routes by `cargo nextrs client generate` (see
// server/client/nextrs.client.json). Never edit it — regenerate instead.
//
// It is generated with an empty baseUrl, so its URL builders return root-relative paths like
// `/api/sync`. Inside an MV3 service worker a relative fetch resolves against
// `chrome-extension://<id>/`, which is not our server.
//
// So we install one narrow rewrite: a string URL beginning with `/api/` is resolved against
// `SERVER_URL`. Absolute URLs pass through untouched, which is what keeps the LinkedIn Voyager
// calls in linkedin.js unaffected.
import { SERVER_URL } from "./config.js";
import { BLOCKED_MESSAGE, BlockedError, ServerUnreachableError } from "./errors.js";

export { BLOCKED_MESSAGE, BlockedError };

// How long a request to our server may take before it counts as "the server didn't answer".
// Generous: a cold serverless start plus a slow network is well inside it.
const API_TIMEOUT_MS = 30_000;

export {
  getSyncStatus,
  linkIdentity,
  pushSync,
  signInDeviceWithSession,
} from "./generated/nextrs-client/client.js";

let installed = false;

export function installApiBaseUrl() {
  if (installed) return;
  installed = true;

  const nativeFetch = globalThis.fetch.bind(globalThis);
  const base = SERVER_URL.replace(/\/$/, "");
  globalThis.fetch = async (input, init) => {
    const isApi = typeof input === "string" && input.startsWith("/api/");
    if (!isApi) return nativeFetch(input, init);
    // A fetch that throws never reached anything that could answer: offline, DNS, a refused
    // connection, or no answer in time. That is "can't reach the server", said as such.
    let response;
    try {
      response = await nativeFetch(base + input, { ...init, signal: init?.signal ?? AbortSignal.timeout(API_TIMEOUT_MS) });
    } catch (err) {
      throw new ServerUnreachableError({ timeout: err?.name === "TimeoutError", cause: err });
    }

    // The generated client assumes every response body is JSON. Framework-level failures can be
    // plain text (for example "Failed to ..."), which used to hide the real problem behind
    // "Unexpected token ... is not valid JSON". Normalize only our API responses at this seam.
    //
    // That rewrite would also hide the one signal that tells a host's block page (Vercel's bot
    // challenge: 403, text/html) from our own JSON 403s, so a non-JSON body is marked with
    // NON_JSON_HEADER for `isBlocked` below.
    let body;
    try {
      body = await response.text();
    } catch (err) {
      // The connection dropped (or timed out) partway through the answer.
      throw new ServerUnreachableError({ timeout: err?.name === "TimeoutError", cause: err });
    }
    if (body) {
      try {
        JSON.parse(body);
        return new Response(body, response);
      } catch {
        // falls through to the rewrite below
      }
    }
    const headers = new Headers(response.headers);
    headers.set(NON_JSON_HEADER, "1");
    // Kept for the error message ("status 502, text/html"), since the rewrite below replaces it.
    headers.set(ORIGINAL_TYPE_HEADER, response.headers.get("content-type") || "no content type");
    if (!body) return new Response(null, { status: response.status, statusText: response.statusText, headers });
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify({ error: body }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

// Set by the rewrite above on an API response whose body was empty or not JSON. Our server answers
// every error with a JSON body, so a 403 without one did not come from us.
const NON_JSON_HEADER = "x-challenge-sync-non-json";
const ORIGINAL_TYPE_HEADER = "x-challenge-sync-original-content-type";

/** The content type the server (or whatever answered) really sent, for error messages. */
export function contentTypeOf(headers) {
  return headers?.get?.(ORIGINAL_TYPE_HEADER) || headers?.get?.("content-type") || null;
}

/**
 * Whether a response was stopped before it reached our server: Vercel's firewall or automatic
 * DDoS mitigation answering with a challenge (403, an HTML page, `x-vercel-mitigated: challenge`)
 * or a rate limit. A service worker cannot solve a browser challenge, so this is a temporary
 * failure to wait out, never an answer from the server ("wrong join code", "token rejected").
 *
 * Takes a fetch `Response` or the generated client's `{ status, headers }`.
 */
export function isBlocked({ status, headers }) {
  if (headers?.get?.("x-vercel-mitigated")) return true;
  if (status === 429) return true; // our server never rate-limits; something in front of it did
  return status === 403 && headers?.get?.(NON_JSON_HEADER) === "1";
}

/** Bearer auth for the endpoints that take a sync token, as a `RequestInit` for the client. */
export function bearer(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}
