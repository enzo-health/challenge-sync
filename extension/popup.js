// Popup controller. All heavy lifting happens in the service worker; the popup just messages it.
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function toast(text, kind) {
  const t = $("toast");
  t.textContent = text;
  t.className = "toast" + (kind ? " " + kind : "");
  t.hidden = false;
  setTimeout(() => (t.hidden = true), 2600);
}

// "Never" is a real answer here, not a placeholder: it is how someone tells a broken link from one
// that just hasn't come round yet. So we always show an absolute date and time alongside the
// relative one — "2h ago" is useless for spotting a sync that silently stopped three days back.
function fmtTime(iso) {
  if (!iso) return "Never";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  const exact = d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  if (diff < 60) return `just now (${exact})`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago (${exact})`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago (${exact})`;
  return `${Math.floor(diff / 86400)}d ago (${exact})`;
}

function fmtDueIn(ms) {
  if (ms <= 0) return "due now";
  const mins = Math.round(ms / 60000);
  return mins < 60 ? `in ${mins}m` : `in about ${Math.round(mins / 60)}h`;
}

// Which prerequisite is missing, so a failure is diagnosed rather than guessed. Linking itself
// is the worker's job and needs no click; this only explains why it hasn't happened yet.
function renderLinkView(link) {
  const set = (id, good, fixId) => {
    const li = $(id);
    li.classList.toggle("ok", good);
    li.classList.toggle("bad", !good);
    li.querySelector(".mark").textContent = good ? "✓" : "✕";
    $(fixId).hidden = good;
  };
  set("check-app", !link.needsInvite, "fix-app");
  set("check-li", !link.needsLinkedIn, "fix-li");
  const failed = Boolean(link.error);
  $("lede-text").textContent = failed
    ? "Couldn't connect this browser."
    : link.needsInvite || link.needsLinkedIn
      ? "Two things to do, then this connects on its own."
      : "Connecting this browser to your challenge account…";
  $("link-error").hidden = !failed;
  $("link-error").textContent = link.error || "";
  $("link-btn").hidden = !failed;
}

// The server sees every device, so its numbers win; local state is the fallback when it can't be
// reached, and the popup says so rather than passing off one device's count as the account's.
function renderStatusView(state, remote, dueInMs) {
  $("display-name").textContent = remote?.displayName || state.displayName || "—";
  const lastSync = remote?.lastSyncAt ? new Date(remote.lastSyncAt * 1000).toISOString() : state.lastSyncAt;
  $("last-sync").textContent = fmtTime(lastSync);
  $("next-sync").textContent = fmtDueIn(dueInMs ?? 0);
  $("posts-count").textContent = remote ? remote.postsCount : (state.lastPostsIngested ?? 0);
  $("scope-line").hidden = Boolean(remote);
  const errLine = $("error-line");
  errLine.hidden = !state.lastError;
  errLine.textContent = state.lastError || "";
  $("diag-btn").classList.toggle("diagnostic-error", Boolean(state.lastError));
  $("diag-btn").textContent = state.lastError ? "Sync failed — open diagnostics" : "Open diagnostics";
}

async function render() {
  const res = await send({ type: "STATUS" });
  const linked = Boolean(res.state.syncToken);
  $("link-view").hidden = linked;
  $("status-view").hidden = !linked;
  if (linked) {
    renderStatusView(res.state, res.remote, res.dueInMs);
  } else {
    renderLinkView(res.link || {});
  }
}

$("fix-app").addEventListener("click", async () => {
  await send({ type: "OPEN_SIGN_IN" });
  window.close();
});

$("fix-li").addEventListener("click", async () => {
  await send({ type: "OPEN_LINKEDIN" });
  window.close();
});

// Only shown after an automatic attempt failed outright — a retry path, not a step.
$("link-btn").addEventListener("click", async () => {
  const btn = $("link-btn");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    const res = await send({ type: "LINK" });
    if (res.ok) toast("Connected — syncing your stats…", "ok");
    else if (res.error) toast(res.error, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Try again";
    render();
  }
});

$("sync-btn").addEventListener("click", async () => {
  const btn = $("sync-btn");
  btn.disabled = true;
  btn.textContent = "Syncing…";
  try {
    const res = await send({ type: "SYNC_NOW" });
    if (!res.ok) throw new Error(res.error);
    toast(`Synced ${res.postsIngested} post(s).`, "ok");
  } catch (e) {
    toast(e.message || "Sync failed.", "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sync now";
    render();
  }
});

// The website owns the full personal results view. Opening it through the worker keeps the
// build-time server origin in one place and uses the same signed-in session as linking.
$("dashboard-btn").addEventListener("click", async () => {
  await send({ type: "OPEN_DASHBOARD" });
  window.close();
});

// Diagnostics get a full extension page: popup clipboards are unreliable and the popup closes as
// soon as it loses focus. The page keeps the report visible, selectable, and copyable.
$("diag-btn").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("diagnostics.html") });
  window.close();
});

render();
