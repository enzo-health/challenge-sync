// The product operator's panel: every user and impersonation — the support tool for
// "what is this user actually seeing?". Reachable only with the system-admin flag.
import {
  getGetSystemOverviewQueryKey,
  useGetSystemOverview,
  useImpersonate,
  useRegenerateJoinLink,
  useSetMemberAdmin,
} from "@linkedin-challenge/client/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fmtDate, fmtInt, initials } from "../../components/format";

export default function SystemPanel() {
  const { data, isLoading } = useGetSystemOverview();
  const impersonate = useImpersonate();
  const setAdmin = useSetMemberAdmin();
  const regenerate = useRegenerateJoinLink();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [linkError, setLinkError] = useState(false);

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

  // Makes the first link, or replaces the current one. The old code stops working on the server
  // as soon as this succeeds, so the overview is reloaded to show the new link.
  const generateLink = () => {
    setLinkError(false);
    regenerate.mutate(undefined, {
      onSuccess: (res) => {
        if (res.status !== 200) {
          setLinkError(true);
          return;
        }
        setCopied(false);
        queryClient.invalidateQueries({ queryKey: getGetSystemOverviewQueryKey() });
      },
      onError: () => setLinkError(true),
    });
  };

  return (
    <>
      <h1>All users</h1>
      <p className="lede">
        Every account on the platform. Admins can see this page, share the invite link, and make other people admins. &ldquo;View as&rdquo; swaps your session for theirs — you
        see exactly what they see, with a banner in the sidebar until you stop.
      </p>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Company invite link</h2>
        {linkError && <div className="notice err">The link could not be generated. Try again.</div>}
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
                onClick={() => {
                  if (
                    window.confirm(
                      "Make a new invite link? The current link will stop working for anyone who has not joined yet. Anyone who already joined stays signed in.",
                    )
                  ) {
                    generateLink();
                  }
                }}
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
              <button className="btn sm" type="button" disabled={regenerate.isPending} onClick={generateLink}>
                Generate invite link
              </button>
            </p>
          </>
        )}
      </div>
      <div className="panel" style={{ padding: 0, overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th className="num">Followers</th>
                  <th>Last sync</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <span className="who">
                        <span className="avatar">{initials(m.displayName)}</span>
                        <span>{m.displayName}</span>
                      </span>
                    </td>
                    <td className="small muted">{m.email ?? "—"}</td>
                    <td className="small">
                      {m.isSystemAdmin ? (
                        <span className="badge">admin</span>
                      ) : m.ownsChallenge ? (
                        <span className="badge ok">challenge owner</span>
                      ) : (
                        <span className="muted">user</span>
                      )}
                    </td>
                    <td className="num">{m.followerCount == null ? "Not synced" : fmtInt(m.followerCount)}</td>
                    <td className="small muted">
                      {m.lastSyncedAt ? fmtDate(m.lastSyncedAt) : "never"}
                    </td>
                    <td className="num">
                      <button
                        className="btn ghost sm"
                        type="button"
                        disabled={setAdmin.isPending}
                        onClick={() =>
                          setAdmin.mutate(
                            { id: m.id, data: { isAdmin: !m.isSystemAdmin } },
                            {
                              onSuccess: () =>
                                queryClient.invalidateQueries({ queryKey: getGetSystemOverviewQueryKey() }),
                            },
                          )
                        }
                      >
                        {m.isSystemAdmin ? "Remove admin" : "Make admin"}
                      </button>{" "}
                      {!m.isSystemAdmin && (
                        <button
                          className="btn ghost sm"
                          type="button"
                          disabled={impersonate.isPending}
                          onClick={() =>
                            impersonate.mutate(
                              { data: { memberId: m.id } },
                              {
                                // Full document load: the cookie changed, so every cached query
                                // is answering as the wrong user.
                                onSuccess: (res) => {
                                  if (res.status === 200) window.location.href = "/";
                                },
                              },
                            )
                          }
                        >
                          View as
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
      </div>
    </>
  );
}
