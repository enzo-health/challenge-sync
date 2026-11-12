// Which posts a sync re-reads, and what it tells the server about the ones it doesn't.
//
// Pure functions with no `chrome` or network access, so scripts/test-refresh-window.mjs can check
// them with plain node.
import { REFRESH_WINDOW_DAYS } from "./config.js";

const DAY_MS = 86_400_000;

// True when a post is older than the refresh window. A post with no readable creation time is
// never "old": refreshing it costs a request, skipping it could leave it unrecorded.
export function isPastRefreshWindow(createdAt, now = Date.now()) {
  const created = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(created)) return false;
  return now - created > REFRESH_WINDOW_DAYS * DAY_MS;
}

// The URNs this install has already delivered to the server for this LinkedIn member. Stored per
// member so signing in to LinkedIn as someone else starts from nothing rather than skipping their
// posts.
export function recordedUrnsFor(recordedPosts, memberUrn) {
  if (!recordedPosts || !memberUrn || recordedPosts.memberUrn !== memberUrn) return new Set();
  return new Set(Array.isArray(recordedPosts.urns) ? recordedPosts.urns : []);
}

// Split the feed page into posts to refresh and posts to leave alone.
//
// A post is left alone only when it is past the refresh window AND this install has already
// delivered it, so a member who joins with months of history still gets every post on the page
// recorded once. Unknown means refresh: a second device or a reinstall re-reads old posts once,
// which costs requests but never loses anything.
//
// Left-out posts are not in `posts`, so nothing new is written for them and their last full
// reading stays the one scoring reads. They are still on the page, though, so they must not look
// deleted:
//   - `postFeedComplete` (the old flag) is only true when nothing was left out. A server that
//     predates `completePostFeedUrns` treats anything missing from `posts` as deleted.
//   - `completePostFeedUrns` lists every post on an under-full page, left out or not, for a server
//     that understands it.
export function planRefresh({ posts, postFeedComplete }, recordedUrns, now = Date.now()) {
  const refresh = [];
  const unrefreshedPostUrns = [];
  for (const post of posts) {
    if (recordedUrns.has(post.urn) && isPastRefreshWindow(post.createdAt, now)) {
      unrefreshedPostUrns.push(post.urn);
    } else {
      refresh.push(post);
    }
  }
  return {
    posts: refresh,
    unrefreshedPostUrns,
    postFeedComplete: Boolean(postFeedComplete) && unrefreshedPostUrns.length === 0,
    completePostFeedUrns: postFeedComplete ? posts.map((post) => post.urn) : undefined,
  };
}
