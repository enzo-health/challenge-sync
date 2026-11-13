import { useAcceptChallengeInvite, useGetMe, useGetMyInvites, getGetChallengesQueryKey } from "@linkedin-challenge/client/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { fmtDate } from "../../components/format";
import { EXTENSION_STORE_URL } from "../../components/links";

export default function AccountPage() {
  const me = useGetMe();
  const account = me.data?.status === 200 ? me.data.data : undefined;
  // Challenges, and so their invitations, are open to admins only for now
  // (`auth::can_use_challenges`); the invitations API refuses everyone else.
  const challenges = Boolean(account?.isSystemAdmin);
  const { data, isLoading, refetch } = useGetMyInvites({ query: { enabled: challenges } });
  const accept = useAcceptChallengeInvite();
  const queryClient = useQueryClient();

  if (me.isLoading || (challenges && isLoading)) return <div className="spinner">Loading account…</div>;
  if (!account?.signedIn || (challenges && data?.status !== 200)) return <div className="empty">Your session expired. <a href="/auth/login">Log in again</a>.</div>;

  return (
    <>
      <h1>{account.displayName}</h1>
      <p className="lede">{challenges ? "Your account and challenge invitations." : "Your account."}</p>

      <h2>Syncing</h2>
      <p>
        Your LinkedIn stats reach this site through the Challenge Sync Chrome extension. Install it
        on any browser where you&rsquo;re signed in here and on LinkedIn, and it connects by itself.
        Several browsers can sync the same account.
      </p>
      <p>
        <a className="btn" href={EXTENSION_STORE_URL} target="_blank" rel="noreferrer">
          Get the extension from the Chrome Web Store
        </a>
      </p>

      {challenges && data?.status === 200 && <>
      <h2>Challenge invitations</h2>
      {data.data.invites.length === 0 ? (
        <div className="empty">You don&rsquo;t have any pending invitations.</div>
      ) : data.data.invites.map((invite) => (
        <div className="panel" key={invite.code}>
          <div className="week-head" style={{ marginTop: 0 }}>
            <h3>{invite.challengeName}</h3>
          </div>
          <p className="muted">Invited by {invite.invitedBy} · {fmtDate(invite.startAt)} → {fmtDate(invite.endAt)}</p>
          <div className="notice" style={{ marginBottom: 16 }}>
            If you accept, this challenge can read and score the LinkedIn posts and analytics synced to your account for its challenge period. Your posts remain owned by your account.
          </div>
          <button
            type="button"
            disabled={accept.isPending}
            onClick={() => accept.mutate({ code: invite.code }, {
              onSuccess: (response) => {
                if (response.status !== 200) return;
                void refetch();
                void queryClient.invalidateQueries({ queryKey: getGetChallengesQueryKey() });
              },
            })}
          >
            {accept.isPending ? "Accepting…" : "Accept and share my challenge-period data"}
          </button>
        </div>
      ))}
      </>}
    </>
  );
}
