#!/usr/bin/env node
// Checks the extension's refresh-window decision (extension/refresh.js) with plain node: which
// posts a sync re-reads, and that the posts it skips can never look deleted to either an old or a
// new server. No browser, no LinkedIn, no server.
import assert from "node:assert/strict";
import { REFRESH_WINDOW_DAYS } from "../extension/config.js";
import { isPastRefreshWindow, planRefresh, recordedUrnsFor } from "../extension/refresh.js";

const DAY = 86_400_000;
const now = Date.parse("2026-11-12T12:00:00Z");
const daysAgo = (days) => new Date(now - days * DAY).toISOString();
const post = (urn, days) => ({ urn, createdAt: days == null ? null : daysAgo(days), metrics: {} });

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log("PASS:", name);
}

// The lottery needs reach kept current for at least 30 days after a post goes up.
check("the window is 45 days, comfortably over the 30 the lottery needs", () => {
  assert.equal(REFRESH_WINDOW_DAYS, 45);
  assert.ok(REFRESH_WINDOW_DAYS >= 30);
});

check("age is measured from creation time at sync time", () => {
  assert.equal(isPastRefreshWindow(daysAgo(10), now), false);
  assert.equal(isPastRefreshWindow(daysAgo(30), now), false);
  assert.equal(isPastRefreshWindow(daysAgo(44.9), now), false);
  assert.equal(isPastRefreshWindow(daysAgo(45.1), now), true);
  assert.equal(isPastRefreshWindow(daysAgo(60), now), true);
});

check("a post with no readable creation time is always refreshed", () => {
  assert.equal(isPastRefreshWindow(null, now), false);
  assert.equal(isPastRefreshWindow("not a date", now), false);
});

const feed = {
  posts: [post("urn:li:activity:young", 10), post("urn:li:activity:old", 60), post("urn:li:activity:undated", null)],
  postFeedComplete: true,
};

check("an old post already delivered is left out; young and undated posts are refreshed", () => {
  const plan = planRefresh(feed, new Set(feed.posts.map((p) => p.urn)), now);
  assert.deepEqual(plan.posts.map((p) => p.urn), ["urn:li:activity:young", "urn:li:activity:undated"]);
  assert.deepEqual(plan.unrefreshedPostUrns, ["urn:li:activity:old"]);
});

check("an old post never delivered is still recorded once", () => {
  const plan = planRefresh(feed, new Set(["urn:li:activity:young"]), now);
  assert.deepEqual(plan.posts.map((p) => p.urn), feed.posts.map((p) => p.urn));
  assert.deepEqual(plan.unrefreshedPostUrns, []);
});

check("leaving a post out turns the old completeness flag off so an old server deletes nothing", () => {
  const plan = planRefresh(feed, new Set(feed.posts.map((p) => p.urn)), now);
  assert.equal(plan.postFeedComplete, false);
  // ...while a new server still gets the whole page, left-out posts included.
  assert.deepEqual(plan.completePostFeedUrns, feed.posts.map((p) => p.urn));
});

check("with nothing left out the old flag is unchanged", () => {
  const plan = planRefresh(feed, new Set(), now);
  assert.equal(plan.postFeedComplete, true);
  assert.deepEqual(plan.completePostFeedUrns, feed.posts.map((p) => p.urn));
});

check("a full page claims nothing about deletion", () => {
  const plan = planRefresh({ ...feed, postFeedComplete: false }, new Set(feed.posts.map((p) => p.urn)), now);
  assert.equal(plan.postFeedComplete, false);
  assert.equal(plan.completePostFeedUrns, undefined);
  assert.equal(JSON.stringify({ x: plan.completePostFeedUrns }), "{}"); // field absent on the wire
});

check("recorded URNs belong to one LinkedIn member", () => {
  const recorded = { memberUrn: "urn:li:fsd_profile:A", urns: ["urn:li:activity:old"] };
  assert.deepEqual([...recordedUrnsFor(recorded, "urn:li:fsd_profile:A")], ["urn:li:activity:old"]);
  assert.equal(recordedUrnsFor(recorded, "urn:li:fsd_profile:B").size, 0);
  assert.equal(recordedUrnsFor(null, "urn:li:fsd_profile:A").size, 0);
});

console.log(JSON.stringify({ result: "PASS", checks: passed }));
