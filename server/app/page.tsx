// The board — the app's landing page, answering "how is everyone doing?" and, first, "how am I
// doing?". Modelled on the LinkedIn Cup page: hero and prizes, the season clock, company totals,
// the viewer's own standing card, their neighbourhood on the board, the week's top posts, and the
// top of the board. Every number here comes from one `getLeaderboard` call; the toggle between
// quarter totals and this week is purely a client-side re-sort.
import { EXTENSION_STORE_URL, WRITE_POST_URL } from "../components/links";
import { useMemo, useState } from "react";
import type { StandingRow, TopPost } from "@linkedin-challenge/client";
import { useGetLeaderboard, useGetChallengeAggregate } from "@linkedin-challenge/client/react-query";
import { fmtInt, fmtNum, fmtDate, initials } from "../components/format";
import { Rules } from "../components/rules";

// Opens LinkedIn with the share box already open — the one action every nudge on this page
// points at.

const money = (n: number) => `$${fmtInt(n)}`;
// Challenge boundaries are stored as UTC midnight, so they are formatted in UTC — otherwise a
// July 13 kickoff reads "July 12" for everyone west of Greenwich.
const shortDate = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const longDate = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
const liveStamp = (unix: number) =>
  new Date(unix * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
const firstName = (name: string) => name.split(/\s+/)[0] ?? name;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${fmtNum(Math.abs(n))}`;

type Mode = "quarter" | "week";

// The rows the board ranks in the chosen mode. Week mode re-ranks by this week's points so the
// "who's moving" question has a real answer, not the quarter order with a different number.
function rankedFor(standings: StandingRow[], mode: Mode): StandingRow[] {
  if (mode === "quarter") return standings;
  return [...standings]
    .sort((a, b) => b.weekPoints - a.weekPoints || a.rank - b.rank)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}
const pointsFor = (row: StandingRow, mode: Mode) => (mode === "quarter" ? row.total : row.weekPoints);

// Avatar hue is a stable function of the name, so the same person is always the same colour.
function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const hues = ["teal", "plum", "moss", "navy"] as const;
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hues[hash % hues.length];
  return (
    <span className={`cup-avatar ${hue}`} style={{ width: size, height: size, fontSize: size * 0.36 }}>
      <span className="star" aria-hidden="true">★</span>
      {initials(name)}
    </span>
  );
}

function Trophy() {
  return (
    <svg className="cup-trophy" viewBox="0 0 120 120" aria-hidden="true">
      <path d="M32 20h56v26c0 18-12 30-28 30S32 64 32 46V20z" fill="#e8c24f" />
      <path d="M32 20h56v8H32z" fill="#f2d576" />
      <path d="M32 26H18c-2 14 6 26 18 28v-8c-6-2-10-8-10-14v-6z" fill="#d9ad3c" />
      <path d="M88 26h14c2 14-6 26-18 28v-8c6-2 10-8 10-14v-6z" fill="#d9ad3c" />
      <rect x="54" y="74" width="12" height="14" fill="#d9ad3c" />
      <path d="M40 88h40l6 10H34z" fill="#e8c24f" />
      <rect x="28" y="98" width="64" height="12" rx="3" fill="#0b2b2b" />
      <rect x="48" y="34" width="24" height="18" rx="4" fill="#0d6b6b" />
      <rect x="53" y="44" width="4" height="5" fill="#d5f79a" />
      <rect x="58" y="41" width="4" height="8" fill="#d5f79a" />
      <rect x="63" y="37" width="4" height="12" fill="#d5f79a" />
      <path d="M16 38l3-6 3 6 6 3-6 3-3 6-3-6-6-3z" fill="#d5f79a" />
      <path d="M104 44l2-4 2 4 4 2-4 2-2 4-2-4-4-2z" fill="#0d7c7c" />
      <path d="M100 76l2-4 2 4 4 2-4 2-2 4-2-4-4-2z" fill="#e8c24f" />
    </svg>
  );
}

function Confetti() {
  const dots = [
    [8, 18, "#d5f79a", 10], [22, 30, "#e8c24f", 9], [4, 46, "#d9ad3c", 10],
    [80, 12, "#0d7c7c", 11], [86, 30, "#d5f79a", 9], [92, 44, "#e8c24f", 8],
    [14, 62, "#0d7c7c", 7], [90, 62, "#d9ad3c", 8],
  ] as const;
  return (
    <div className="cup-confetti" aria-hidden="true">
      {dots.map(([x, y, c, s], i) => (
        <span key={i} style={{ left: `${x}%`, top: `${y}%`, background: c, width: s, height: s, transform: `rotate(${(i * 37) % 90}deg)` }} />
      ))}
    </div>
  );
}

function Chip({ label, value, tone }: { label?: string; value: string; tone?: "up" | "fire" }) {
  return (
    <span className={`cup-chip${tone ? ` ${tone}` : ""}`}>
      {label && <span className="l">{label} </span>}
      <strong>{value}</strong>
    </span>
  );
}

function Row({
  row,
  mode,
  challengeId,
  isMe,
}: {
  row: StandingRow;
  mode: Mode;
  challengeId: number;
  isMe: boolean;
}) {
  return (
    <div className={`cup-row${isMe ? " me" : ""}`}>
      <div className="rank">{row.rank}</div>
      <Avatar name={row.displayName} size={64} />
      <div className="body">
        <div className="name">
          <a href={`/members/${row.memberId}?challengeId=${challengeId}`}>{row.displayName}</a>
          {isMe && <span className="you">YOU</span>}
        </div>
        <div className="sub">
          <span>{row.followersUnknown ? "Followers not synced" : `${fmtInt(row.followerCount)} followers`} · </span>
          <a href={`/members/${row.memberId}?challengeId=${challengeId}`}>See results →</a>
        </div>
        <div className="chips">
          <Chip label="Show up" value={fmtNum(row.showUpPoints)} />
          <Chip label="Consistency" value={fmtNum(row.consistencyPoints)} />
          <Chip label="Engagement" value={fmtNum(row.engagementPoints)} />
          {row.profilePoints > 0 && <Chip label="Profile" value={fmtNum(row.profilePoints)} />}
          <Chip value={`▲ ${signed(row.weekPoints)} wk`} tone="up" />
          {row.streakWeeks >= 2 && <Chip value={`🔥 ${row.streakWeeks}-wk streak`} tone="fire" />}
        </div>
      </div>
      <div className="total">
        <div className="n">{fmtNum(pointsFor(row, mode))}</div>
        <div className="k">{mode === "quarter" ? "TOTAL" : "THIS WEEK"}</div>
      </div>
    </div>
  );
}

function TopPostCard({ post, place }: { post: TopPost; place: number }) {
  return (
    <div className="cup-card cup-top-post">
      <span className={`medal m${place}`}>{place}</span>
      <div className="name">{post.displayName}</div>
      <div className="meta">
        {fmtInt(post.comments)} comment{post.comments === 1 ? "" : "s"} · {fmtInt(post.reactions)} like
        {post.reactions === 1 ? "" : "s"}
      </div>
      {post.textPreview && <p className="excerpt">{post.textPreview}</p>}
      <a href={post.permalink} target="_blank" rel="noreferrer">View the post →</a>
    </div>
  );
}

// The extra numbers an organiser wants while looking at a board.
function AdminStrip({ challengeId, enabled }: { challengeId: number; enabled: boolean }) {
  const { data } = useGetChallengeAggregate({ challengeId }, { query: { enabled } });
  if (!enabled || data?.status !== 200) return null;
  const a = data.data;
  const cells: [string, string][] = [
    ["Members", fmtInt(a.participants)],
    ["Scoring", fmtInt(a.scoringParticipants)],
    ["Posts in window", fmtInt(a.totalPosts)],
    ["Posts graded", fmtInt(a.gradedPosts)],
    ["Impressions", fmtInt(a.totalImpressions)],
    ["Reactions", fmtInt(a.totalReactions)],
    ["Comments", fmtInt(a.totalComments)],
    ["Points awarded", fmtNum(a.totalPoints)],
    ["Invites", `${a.invitesRedeemed} used / ${a.invitesOpen} open`],
  ];
  return (
    <div className="admin-strip">
      <div className="k" style={{ marginBottom: 8 }}>
        Organiser view · <a href={`/challenges/${challengeId}/settings`}>Settings</a> ·{" "}
        <a href={`/challenges/${challengeId}/invites`}>Invites</a>
      </div>
      <div className="metrics">
        {cells.map(([k, v]) => (
          <div className="metric" key={k}>
            <span className="n">{v}</span>
            <span className="k">{k}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChallengeLeaderboard({ fixedChallengeId }: { fixedChallengeId?: number }) {
  // undefined = "whatever the current challenge is"; a number = an explicit pick.
  const [challengeId, setChallengeId] = useState<number | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("quarter");
  const [showAll, setShowAll] = useState(false);
  const selectedChallengeId = fixedChallengeId ?? challengeId;
  const { data, isLoading } = useGetLeaderboard(
    selectedChallengeId !== undefined ? { challengeId: selectedChallengeId } : undefined,
  );

  const board = data?.status === 200 ? data.data : undefined;
  const ranked = useMemo(() => rankedFor(board?.standings ?? [], mode), [board, mode]);

  if (isLoading) return <div className="spinner">Loading leaderboard…</div>;
  if (!board) {
    return (
      <div className="empty">
        Your session expired. <a href="/auth/login">Log in again</a>.
      </div>
    );
  }

  const { competition, challenges, season, company, topPosts, viewerMemberId, viewerName } = board;

  if (!competition) {
    return (
      <>
        <h1>Leaderboard</h1>
        <div className="empty">
          No challenge yet. <a href="/challenges/new">Set one up</a> to start scoring.
        </div>
      </>
    );
  }

  const cfg = competition.config;
  const me = ranked.find((row) => row.memberId === viewerMemberId);
  const myIndex = me ? ranked.indexOf(me) : -1;
  const ahead = myIndex > 0 ? ranked[myIndex - 1] : undefined;
  const gap = me && ahead ? pointsFor(ahead, mode) - pointsFor(me, mode) : 0;
  const neighbourhood =
    myIndex >= 0 ? ranked.slice(Math.max(0, myIndex - 2), Math.min(ranked.length, myIndex + 3)) : [];
  const top = ranked.slice(0, showAll ? ranked.length : 5);
  const members = company?.members ?? ranked.length;
  const notPosting = Math.max(0, members - (company?.membersPosting ?? 0));
  const percentile = me ? Math.max(1, Math.round((1 - (me.rank - 1) / Math.max(1, ranked.length)) * 100)) : 0;
  const posts = me?.totalPosts ?? 0;
  const needed = cfg.participationPosts;
  const locked = needed > 0 && posts >= needed;
  const prizes: [string, string, string][] = [];
  if (cfg.prizeFirst > 0) prizes.push([money(cfg.prizeFirst), "1st place", "gold"]);
  if (cfg.prizeSecond > 0) prizes.push([money(cfg.prizeSecond), "2nd place", "silver"]);
  if (cfg.prizeThird > 0) prizes.push([money(cfg.prizeThird), "3rd place", "bronze"]);
  if (cfg.prizeParticipation > 0) prizes.push([money(cfg.prizeParticipation), `Everyone at ${needed}+ posts`, "lime"]);
  const seasonLabel = new Date(competition.startAt * 1000).toLocaleDateString("en-US", { year: "numeric", timeZone: "UTC" });

  return (
    <div className="cup">
      <div className="cup-live">
        {fixedChallengeId === undefined && challenges.length > 1 && (
          <select value={competition.id} onChange={(e) => setChallengeId(Number(e.target.value))} aria-label="Challenge">
            {challenges.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
        {season && <span>Live as of {liveStamp(season.asOf)}</span>}
      </div>

      <header className="cup-hero">
        <Confetti />
        <Trophy />
        <h1>{competition.name}</h1>
        <p className="tagline">
          {seasonLabel} · {longDate(competition.startAt)} to {longDate(competition.endAt)} · get in, have fun, win money
        </p>
        {prizes.length > 0 && (
          <div className="cup-prizes">
            {prizes.map(([amount, label, tone]) => (
              <div className={`prize ${tone}`} key={label}>
                <div className="amount">{amount}</div>
                <div className="label">{label}</div>
              </div>
            ))}
          </div>
        )}
        <h2 className="welcome">Welcome, {firstName(viewerName)}!</h2>
      </header>

      {season && (
        <section className="cup-card cup-season">
          <div className="eyebrow">The season</div>
          <div className="track">
            <div className="fill" style={{ width: `${Math.round(season.progress * 100)}%` }} />
            <div className="knob" style={{ left: `${Math.round(season.progress * 100)}%` }} />
          </div>
          <div className="marks">
            <span><strong>{shortDate(competition.startAt)}</strong> · kickoff</span>
            <span><strong>Week {season.week} of {season.weeks}</strong></span>
            <span><strong>{shortDate(competition.endAt)}</strong> · final whistle</span>
          </div>
        </section>
      )}

      {company && (
        <section className="cup-company">
          <div className="eyebrow center">As a company so far, we have…</div>
          <div className="cup-stats">
            <div className="cup-card stat">
              <div className="n">{fmtInt(company.membersPosting)} of {fmtInt(company.members)}</div>
              <div className="k">Teammates posting</div>
            </div>
            <div className="cup-card stat">
              <div className="n">{fmtInt(company.commentsSparked)}</div>
              <div className="k">Comments sparked</div>
            </div>
            <div className="cup-card stat">
              <div className="n">{fmtInt(company.followerReach)}</div>
              <div className="k">Combined follower reach</div>
            </div>
          </div>
        </section>
      )}

      <div className="cup-toggle" role="tablist" aria-label="Points shown">
        <button type="button" role="tab" aria-selected={mode === "quarter"} className={mode === "quarter" ? "on" : ""} onClick={() => setMode("quarter")}>
          Season total
        </button>
        <button type="button" role="tab" aria-selected={mode === "week"} className={mode === "week" ? "on" : ""} onClick={() => setMode("week")}>
          This week
        </button>
      </div>

      <section className="cup-card cup-me">
        {me ? (
          <>
            <div className="head">
              <div>
                <h2>
                  You&rsquo;re <span className="accent">#{me.rank}</span> of {ranked.length} on the board
                </h2>
                <p className="muted">
                  Nice work, {firstName(viewerName)}. You&rsquo;re moving{" "}
                  <strong className="accent">▲ {signed(me.weekPoints)}</strong> this week.
                </p>
              </div>
              <div className="points">
                <div className="n">{fmtNum(pointsFor(me, mode))}</div>
                <div className="k">{mode === "quarter" ? "Your points" : "This week"}</div>
              </div>
            </div>

            {cfg.prizeParticipation > 0 && needed > 0 && (
              <div className="guarantee">
                <div className="line">
                  <span>Your guaranteed <strong className="accent">{money(cfg.prizeParticipation)}</strong></span>
                  <span>{locked ? "Locked ✓" : `${posts} of ${needed} posts`}</span>
                </div>
                <div className="bar">
                  {Array.from({ length: needed }, (_, i) => (
                    <span key={i} className={i < posts ? "on" : ""} />
                  ))}
                </div>
              </div>
            )}

            <div className="facts">
              <div><div className="k">Standing</div><div className="v">top <span className="accent">{percentile}%</span></div></div>
              {ahead ? (
                <div><div className="k">To pass {firstName(ahead.displayName)}</div><div className="v">{fmtNum(Math.max(0, gap))} points</div></div>
              ) : (
                <div><div className="k">Position</div><div className="v">Top of the board</div></div>
              )}
              <div><div className="k">Follower growth</div><div className="v">{signed(me.followerGrowth)} this season</div></div>
              <div><div className="k">Weekly streak</div><div className="v">{me.streakWeeks} wk{me.streakWeeks === 1 ? "" : "s"}</div></div>
            </div>

            <div className="cta">
              <a className="cup-btn dark" href={WRITE_POST_URL} target="_blank" rel="noreferrer">Write your next post →</a>
              <span className="muted">
                {locked
                  ? `You've locked the ${money(cfg.prizeParticipation)}. Keep climbing the board.`
                  : needed > 0 && cfg.prizeParticipation > 0
                    ? `${Math.max(0, needed - posts)} more post${needed - posts === 1 ? "" : "s"} locks your ${money(cfg.prizeParticipation)}.`
                    : "Every post counts."}
                {ahead && ` One good post can pass ${firstName(ahead.displayName)}.`}
              </span>
            </div>
          </>
        ) : (
          <>
            <h2>You&rsquo;re not on the board yet</h2>
            <p className="muted">
              Install the browser extension so your LinkedIn posts sync here, then write a post. Once
              you&rsquo;re signed in here and on LinkedIn it connects by itself, and you join the board
              the moment your first data arrives.
            </p>
            <div className="cta">
              <a className="cup-btn dark" href={EXTENSION_STORE_URL} target="_blank" rel="noreferrer">Install the extension →</a>
              <a className="cup-btn pink" href={WRITE_POST_URL} target="_blank" rel="noreferrer">Write a post →</a>
            </div>
          </>
        )}
      </section>

      <div className="cup-columns">
        <div>
          {neighbourhood.length > 0 && (
            <>
              <div className="eyebrow">Your neighborhood</div>
              {neighbourhood.map((row) => (
                <Row key={row.memberId} row={row} mode={mode} challengeId={competition.id} isMe={row.memberId === viewerMemberId} />
              ))}
              {me && ahead && (
                <div className="cup-nudge">
                  <span>
                    You&rsquo;re <strong>{fmtNum(Math.max(0, gap))}</strong> points behind{" "}
                    {firstName(ahead.displayName)}. One post can close it.
                  </span>
                  <a className="cup-btn pink" href={WRITE_POST_URL} target="_blank" rel="noreferrer">Write a post →</a>
                </div>
              )}
            </>
          )}

          <section className="cup-card cup-board">
            <div className="eyebrow">Top of the board right now</div>
            <p className="muted small" style={{ marginTop: 4 }}>
              Standings update live. Nothing&rsquo;s locked until {longDate(competition.endAt)}.
            </p>
            {ranked.length === 0 ? (
              <div className="empty">
                Nobody has synced data for this challenge yet. Standings appear once people connect
                the extension.
              </div>
            ) : (
              <ol className="cup-list">
                {top.map((row) => (
                  <li key={row.memberId} className={row.memberId === viewerMemberId ? "me" : ""}>
                    <span className="rank">{row.rank}</span>
                    <Avatar name={row.displayName} size={40} />
                    <span>
                      <a className="who-link" href={`/members/${row.memberId}?challengeId=${competition.id}`}>{row.displayName}</a>
                      {row.memberId === viewerMemberId && <span className="muted"> · you</span>}
                      <span className="small muted" style={{ display: "block" }}>{row.followersUnknown ? "Followers not synced" : `${fmtInt(row.followerCount)} followers`}</span>
                    </span>
                    <span className="pts">{fmtNum(pointsFor(row, mode))}</span>
                    <a href={`/members/${row.memberId}?challengeId=${competition.id}`}>View posts →</a>
                  </li>
                ))}
              </ol>
            )}
            {ranked.length > 5 && (
              <button type="button" className="cup-btn ghost" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show the top 5" : `Show all ${ranked.length}`}
              </button>
            )}
          </section>
        </div>

        <aside>
          <div className="eyebrow">Top 3 posts this week</div>
          {topPosts.length === 0 ? (
            <div className="cup-card muted small">No posts yet this week. Yours could be first.</div>
          ) : (
            topPosts.map((post, index) => <TopPostCard key={post.postId} post={post} place={index + 1} />)
          )}
          <div className="cup-card cup-turn">
            <h3>Your turn</h3>
            <p>One post a week keeps the streak alive. Three a week is the ceiling for show-up points.</p>
            <a className="cup-btn pink" href={WRITE_POST_URL} target="_blank" rel="noreferrer">Write a post on LinkedIn →</a>
          </div>
        </aside>
      </div>

      <footer className="cup-foot">
        <p>
          {fmtInt(ranked.length)} on the board
          {notPosting > 0 && <> · {fmtInt(notPosting)} teammate{notPosting === 1 ? " hasn't" : "s haven't"} posted yet, jump in.</>}
        </p>
        <Rules config={cfg} compact />
        <p>
          Standings update live from everyone&rsquo;s synced LinkedIn data.{" "}
          <a href={`/challenges/${competition.id}/scoring`}>Scoring, with your points line by line</a>
          {" · "}window {fmtDate(competition.startAt)} → {fmtDate(competition.endAt)}
        </p>
      </footer>

      <AdminStrip challengeId={competition.id} enabled={competition.isOwner} />
    </div>
  );
}

export default function LeaderboardPage() {
  return <ChallengeLeaderboard />;
}
