// Admin overview: how the current challenge is going across the whole company. Setup and invites
// live on their own pages; this one answers "is it working?".
import { useGetAdminOverview } from "@linkedin-challenge/client/react-query";
import { fmtInt, fmtNum, fmtDate } from "../../components/format";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  );
}

export default function AdminOverviewPage() {
  const { data, isLoading } = useGetAdminOverview();

  if (isLoading) return <div className="spinner">Loading…</div>;
  if (data?.status !== 200) {
    return (
      <div className="empty">
        Your session expired. <a href="/auth/login">Log in again</a>.
      </div>
    );
  }

  const { current, aggregate: a, standings } = data.data;

  return (
    <>
      <h1>My challenge overview</h1>
      <p className="lede">
        {current ? (
          <>
            <strong>{current.name}</strong> · {fmtDate(current.startAt)} →{" "}
            {fmtDate(current.endAt)}
          </>
        ) : (
          <>
            No challenge running. {" "}
            <a href="/challenges/new">Set one up.</a>
          </>
        )}
      </p>

      <div className="grid cols-3">
        <Stat label="Members" value={fmtInt(a.participants)} />
        <Stat
          label="Collecting data"
          value={`${fmtInt(a.scoringParticipants)} of ${fmtInt(a.participants)}`}
        />
        <Stat label="Open invites" value={fmtInt(a.invitesOpen)} />
      </div>

      {current && (
        <>
          <h2>This challenge so far</h2>
          <div className="grid cols-3">
            <Stat label="Posts in window" value={fmtInt(a.totalPosts)} />
            <Stat label="Posts graded" value={fmtInt(a.gradedPosts)} />
            <Stat label="Points awarded" value={fmtNum(a.totalPoints)} />
            <Stat label="Impressions" value={fmtInt(a.totalImpressions)} />
            <Stat label="Reactions" value={fmtInt(a.totalReactions)} />
            <Stat label="Comments" value={fmtInt(a.totalComments)} />
          </div>

          <h2>Top of the board</h2>
          {standings.length === 0 ? (
            <div className="empty">
              Nobody is scoring yet. Standings appear once people connect the extension. Check{" "}
              <a href={`/challenges/${current.id}/invites`}>invites</a> if the team hasn&rsquo;t joined.
            </div>
          ) : (
            <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Participant</th>
                    <th className="num">Followers</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.slice(0, 5).map((row) => (
                    <tr key={row.memberId}>
                      <td className={`rank r${row.rank}`}>{row.rank}</td>
                      <td>
                        <a href={`/members/${row.memberId}?challengeId=${current.id}`}>{row.displayName}</a>
                      </td>
                      <td className="num">{row.followersUnknown ? "Not synced" : fmtInt(row.followerCount)}</td>
                      <td className="num">
                        <strong>{fmtNum(row.total)}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted">
            The <a href={current ? `/challenges/${current.id}` : "/challenges"}>leaderboard</a> has the full board and the organiser strip.
          </p>
        </>
      )}
    </>
  );
}
