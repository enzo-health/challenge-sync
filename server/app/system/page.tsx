// The product operator's panel: every user and impersonation — the support tool for
// "what is this user actually seeing?". Reachable only with the system-admin flag.
import {
  getGetSystemOverviewQueryKey,
  useDeleteMember,
  useGetMe,
  useGetSystemOverview,
  useImpersonate,
  useRegenerateJoinLink,
  useRestoreMember,
  useSetMemberAdmin,
} from "@linkedin-challenge/client/react-query";
import type { SystemMemberRow } from "@linkedin-challenge/client";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActionMenu, type MenuAction } from "../../components/action-menu";
import { ConfirmModal } from "../../components/confirm-modal";
import { fmtAgo, fmtInt, fmtLocalDate, initials } from "../../components/format";

// What the confirmation dialog is asking about. One dialog at a time, so one piece of state.
type Pending =
  | { kind: "admin"; member: SystemMemberRow }
  | { kind: "delete"; member: SystemMemberRow }
  | { kind: "restore"; member: SystemMemberRow }
  | { kind: "regenerate" };

// "Not in the last N days" counts people who never synced too: the point is finding whom to
// contact, and never having synced is the most stale of all.
const SYNC_FILTERS = [
  { value: "any", label: "Any" },
  { value: "2", label: "Not in the last 2 days" },
  { value: "7", label: "Not in the last 7 days" },
  { value: "30", label: "Not in the last 30 days" },
  { value: "never", label: "Never synced" },
] as const;
type SyncFilter = (typeof SYNC_FILTERS)[number]["value"];

function syncMatches(filter: SyncFilter, lastSyncedAt: number | null | undefined, nowSecs: number): boolean {
  if (filter === "any") return true;
  if (lastSyncedAt == null) return true;
  if (filter === "never") return false;
  return lastSyncedAt < nowSecs - Number(filter) * 86400;
}

export default function SystemPanel() {
  const { data, isLoading } = useGetSystemOverview();
  const impersonate = useImpersonate();
  const setAdmin = useSetMemberAdmin();
  const regenerate = useRegenerateJoinLink();
  const deleteMember = useDeleteMember();
  const restoreMember = useRestoreMember();
  const { data: meData } = useGetMe();
  const myId = meData?.status === 200 ? meData.data.memberId : undefined;
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState("");
  const [syncFilter, setSyncFilter] = useState<SyncFilter>("any");
  // null keeps the server's name order; otherwise the last sync column, either way round.
  const [syncSort, setSyncSort] = useState<"oldest" | "newest" | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [copiedEmails, setCopiedEmails] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  if (isLoading) return <div className="spinner">Loading…</div>;
  if (data?.status !== 200) {
    return (
      <div className="empty">
        Your session expired. <a href="/auth/login">Log in again</a>.
      </div>
    );
  }

  const { members, joinCode } = data.data;
  const joinLink = joinCode ? `${window.location.origin}/join/${encodeURIComponent(joinCode)}` : null;

  const nowSecs = Math.floor(Date.now() / 1000);
  const inScope = members.filter((m) => showDeleted || m.deletedAt == null);
  const needle = search.trim().toLowerCase();
  const shown = inScope.filter(
    (m) =>
      (!needle ||
        m.displayName.toLowerCase().includes(needle) ||
        (m.email ?? "").toLowerCase().includes(needle)) &&
      syncMatches(syncFilter, m.lastSyncedAt, nowSecs),
  );
  if (syncSort) {
    // Never synced counts as the oldest of all. `sort` is stable, so ties keep name order.
    const at = (m: SystemMemberRow) => m.lastSyncedAt ?? -Infinity;
    shown.sort((a, b) => (syncSort === "oldest" ? at(a) - at(b) : at(b) - at(a)));
  }
  const filtering = needle !== "" || syncFilter !== "any";

  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetSystemOverviewQueryKey() });

  const ask = (next: Pending) => {
    setConfirmError(null);
    setPending(next);
  };
  const closeConfirm = () => {
    setPending(null);
    setConfirmError(null);
  };

  // Every confirmed action ends the same way: close and reload the list on success, or keep the
  // dialog open with the server's reason (your own account, a challenge owner, ...).
  const settle = (fallback: string) => ({
    onSuccess: (res: { status: number; data: unknown }) => {
      if (res.status !== 200) {
        const error = (res.data as { error?: string } | undefined)?.error;
        setConfirmError(error || fallback);
        return;
      }
      closeConfirm();
      refresh();
    },
    onError: () => setConfirmError(fallback),
  });

  const confirm = () => {
    if (!pending) return;
    setConfirmError(null);
    switch (pending.kind) {
      case "admin":
        setAdmin.mutate(
          { id: pending.member.id, data: { isAdmin: !pending.member.isSystemAdmin } },
          settle("The admin access could not be changed. Try again."),
        );
        return;
      case "delete":
        deleteMember.mutate({ id: pending.member.id }, settle("The account could not be deleted. Try again."));
        return;
      case "restore":
        restoreMember.mutate({ id: pending.member.id }, settle("The account could not be restored. Try again."));
        return;
      case "regenerate":
        // The old code stops working on the server as soon as this succeeds, so the overview is
        // reloaded to show the new link.
        regenerate.mutate(undefined, {
          onSuccess: (res) => {
            if (res.status !== 200) {
              setConfirmError("The link could not be generated. Try again.");
              return;
            }
            setCopied(false);
            closeConfirm();
            refresh();
          },
          onError: () => setConfirmError("The link could not be generated. Try again."),
        });
        return;
    }
  };

  const viewAs = (m: SystemMemberRow) => {
    setActionError(null);
    impersonate.mutate(
      { data: { memberId: m.id } },
      {
        // Full document load: the cookie changed, so every cached query is answering as the
        // wrong user.
        onSuccess: (res) => {
          if (res.status === 200) window.location.href = "/";
          else setActionError(res.data?.error || `Could not view as ${m.displayName}.`);
        },
        onError: () => setActionError(`Could not view as ${m.displayName}.`),
      },
    );
  };

  const actionsFor = (m: SystemMemberRow): MenuAction[] => {
    if (m.deletedAt != null) {
      return [{ label: "Restore account", onSelect: () => ask({ kind: "restore", member: m }) }];
    }
    const actions: MenuAction[] = [];
    if (!m.isSystemAdmin) {
      actions.push({ label: "View as", onSelect: () => viewAs(m), disabled: impersonate.isPending });
    }
    actions.push({
      label: m.isSystemAdmin ? "Remove admin" : "Make admin",
      onSelect: () => ask({ kind: "admin", member: m }),
    });
    if (myId !== undefined && m.id !== myId) {
      actions.push({ label: "Delete account", danger: true, onSelect: () => ask({ kind: "delete", member: m }) });
    }
    return actions;
  };

  const copyEmails = () => {
    const emails = shown.map((m) => m.email).filter((email): email is string => !!email);
    navigator.clipboard.writeText(emails.join(", ")).then(() => {
      setCopiedEmails(emails.length);
      window.setTimeout(() => setCopiedEmails(null), 2500);
    });
  };

  const busy = setAdmin.isPending || deleteMember.isPending || restoreMember.isPending || regenerate.isPending;
  const dialog = (() => {
    if (!pending) return null;
    switch (pending.kind) {
      case "admin":
        return pending.member.isSystemAdmin
          ? {
              title: "Remove admin access",
              body: <p>Remove {pending.member.displayName}&rsquo;s admin access?</p>,
              confirmLabel: "Remove admin",
            }
          : {
              title: "Make admin",
              body: (
                <p>
                  Make {pending.member.displayName} an admin? Admins can see everyone&rsquo;s data, share the
                  invite link, create API keys, and make or remove other admins.
                </p>
              ),
              confirmLabel: "Make admin",
            };
      case "delete":
        return {
          title: "Delete account",
          body: (
            <p>
              Delete {pending.member.displayName}&rsquo;s account? They will be signed out and will not be able to
              sign in or sync. Their posts and history are kept, and you can restore the account later.
            </p>
          ),
          confirmLabel: "Delete account",
          danger: true,
        };
      case "restore":
        return {
          title: "Restore account",
          body: (
            <p>
              Restore {pending.member.displayName}&rsquo;s account? They can sign in and sync again and are back
              on the leaderboard with their posts. They need to sign in again, and admin access is not restored.
            </p>
          ),
          confirmLabel: "Restore account",
        };
      case "regenerate":
        return {
          title: "Make a new invite link",
          body: (
            <p>
              The current link will stop working for anyone who has not joined yet. Anyone who already joined
              stays signed in.
            </p>
          ),
          confirmLabel: "Make a new link",
        };
    }
  })();

  return (
    <>
      <h1>All users</h1>
      <p className="lede">
        Every account on the platform. Admins can see this page, share the invite link, and make other people admins. &ldquo;View as&rdquo; swaps your session for theirs — you
        see exactly what they see, with a banner in the sidebar until you stop.
      </p>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Company invite link</h2>
        {joinLink ? (
          <>
            <p className="muted">
              Share this one link with everyone. Opening it, installing the extension and being
              logged in to LinkedIn is all it takes to join. Anyone who has the link can join.
            </p>
            <p>
              <span className="code">{joinLink}</span>{" "}
              <button
                className="btn ghost sm"
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(joinLink).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>{" "}
              <button
                className="btn ghost sm"
                type="button"
                disabled={regenerate.isPending}
                onClick={() => ask({ kind: "regenerate" })}
              >
                Generate a new link
              </button>
            </p>
          </>
        ) : (
          <>
            <p className="muted">
              Joining is switched off: there is no invite link yet. Generate one to let people join.
            </p>
            <p>
              <button className="btn sm" type="button" disabled={regenerate.isPending} onClick={() => ask({ kind: "regenerate" })}>
                Generate invite link
              </button>
            </p>
          </>
        )}
      </div>
      <div className="user-filters">
        <label>
          Search
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or email"
          />
        </label>
        <label>
          Last sync
          <select value={syncFilter} onChange={(e) => setSyncFilter(e.target.value as SyncFilter)}>
            {SYNC_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
          Show deleted
        </label>
        <span className="muted small" aria-live="polite">
          {filtering ? `${shown.length} of ${inScope.length} users` : `${inScope.length} users`}
        </span>
        <button className="btn ghost sm" type="button" disabled={shown.length === 0} onClick={copyEmails}>
          {copiedEmails === null ? "Copy emails" : `Copied ${copiedEmails}`}
        </button>
      </div>
      {actionError && <div className="notice err">{actionError}</div>}
      <div className="panel" style={{ padding: 0, overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th className="num">Followers</th>
                  <th aria-sort={syncSort === "oldest" ? "ascending" : syncSort === "newest" ? "descending" : "none"}>
                    <button
                      className="th-sort"
                      type="button"
                      onClick={() => setSyncSort(syncSort === "oldest" ? "newest" : "oldest")}
                      title="Sort by last sync"
                    >
                      Last sync{syncSort === "oldest" ? " ↑" : syncSort === "newest" ? " ↓" : ""}
                    </button>
                  </th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      No users match.
                    </td>
                  </tr>
                )}
                {shown.map((m) => (
                  <tr key={m.id} className={m.deletedAt != null ? "deleted-row" : undefined}>
                    <td>
                      <span className="who">
                        <span className="avatar">{initials(m.displayName)}</span>
                        <span>{m.displayName}</span>
                      </span>
                    </td>
                    <td className="small muted">{m.email ?? "—"}</td>
                    <td className="small">
                      {m.deletedAt != null ? (
                        <>
                          <span className="badge danger">deleted</span>{" "}
                          <span className="muted">{fmtLocalDate(m.deletedAt)}</span>
                        </>
                      ) : m.isSystemAdmin ? (
                        <span className="badge">admin</span>
                      ) : m.ownsChallenge ? (
                        <span className="badge ok">challenge owner</span>
                      ) : (
                        <span className="muted">user</span>
                      )}
                    </td>
                    <td className="num">{m.followerCount == null ? "Not synced" : fmtInt(m.followerCount)}</td>
                    <td className="small muted">
                      {m.lastSyncedAt ? (
                        <>
                          {fmtLocalDate(m.lastSyncedAt)}
                          <br />
                          <span className={m.lastSyncedAt < nowSecs - 7 * 86400 ? "stale" : undefined}>
                            {fmtAgo(m.lastSyncedAt)}
                          </span>
                        </>
                      ) : (
                        <span className="stale">never</span>
                      )}
                    </td>
                    <td className="num">
                      <ActionMenu label={`Actions for ${m.displayName}`} actions={actionsFor(m)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
      </div>
      {dialog && (
        <ConfirmModal
          open
          title={dialog.title}
          confirmLabel={dialog.confirmLabel}
          danger={"danger" in dialog && dialog.danger}
          busy={busy}
          error={confirmError}
          onConfirm={confirm}
          onCancel={closeConfirm}
        >
          {dialog.body}
        </ConfirmModal>
      )}
    </>
  );
}
