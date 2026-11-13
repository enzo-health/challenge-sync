// The landing page: how the company is doing on LinkedIn over the past 7, 30 or 90 days, and the
// viewer's part in it. Every signed-in member sees it. Every number comes from one
// `getStatsOverview` call; the definitions live in `src/stats.rs` and are spelled out at the
// bottom of the page, because "impressions" here means impressions GAINED in the period, which is
// not the same as the totals on a post.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { parseAsNumberLiteral, useQueryState } from "nuqs";
import type { StatsBucket, StatsCounts, StatsMetric, StatsOverview, StatsYou } from "@linkedin-challenge/client";
import { useGetStatsOverview } from "@linkedin-challenge/client/react-query";
import { fmtInt, fmtLocalDate, initials } from "../components/format";
import { EXTENSION_STORE_URL, WRITE_POST_URL } from "../components/links";

const PERIODS = [7, 30, 90] as const;
type Days = (typeof PERIODS)[number];

const pad = (n: number) => String(n).padStart(2, "0");
/** The browser's UTC offset right now as `-07:00`, sent the same way the Reports page sends it. */
function offsetNow(): string {
  const minutes = -new Date().getTimezoneOffset();
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const ZONE_NAME = Intl.DateTimeFormat().resolvedOptions().timeZone;

const pct = (share: number) => {
  const value = share * 100;
  if (value > 0 && value < 1) return "<1%";
  return `${Math.round(value)}%`;
};
const shortDay = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const weekday = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-US", { weekday: "short" });
const ordinal = (n: number) => {
  const mod100 = n % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
};

/** "+12% vs previous 7 days", or a dash when the previous period had nothing to compare. */
function Change({ metric, days }: { metric: StatsMetric; days: number }) {
  const vs = `vs previous ${days} days`;
  if (metric.change == null) {
    return <div className="tile-change">– {vs}</div>;
  }
  const rounded = Math.round(metric.change * 100);
  if (rounded === 0) return <div className="tile-change">Same as previous {days} days</div>;
  return (
    <div className={`tile-change ${rounded > 0 ? "up" : "down"}`}>
      {rounded > 0 ? "+" : "−"}
      {fmtInt(Math.abs(rounded))}% {vs}
    </div>
  );
}

function Tile({
  label,
  metric,
  days,
  sub,
  you,
}: {
  label: string;
  metric: StatsMetric;
  days: number;
  sub?: ReactNode;
  you?: ReactNode;
}) {
  return (
    <div className="stat stat-tile">
      <div className="k">{label}</div>
      <div className="v">
        {fmtInt(metric.value)}
        {sub && <span className="v-sub"> {sub}</span>}
      </div>
      <Change metric={metric} days={days} />
      {you && <div className="tile-you">{you}</div>}
    </div>
  );
}

/** "You: 1,200 · 18% of the company", with the share left off when the company's number is 0. */
function YouLine({ value, share }: { value: number; share: number | null }) {
  return (
    <>
      <span className="swatch you" aria-hidden="true" />
      You: <strong>{fmtInt(value)}</strong>
      {share != null && <> · {pct(share)} of the company</>}
    </>
  );
}

// --- the chart --------------------------------------------------------------------------------

/** A round number at or above `value`, so the top gridline reads 50 rather than 47. */
function niceMax(value: number): number {
  if (value <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * pow >= value) return step * pow;
  }
  return 10 * pow;
}

/** A bar with 4px rounded corners on its top end only, anchored to the baseline. */
function topRoundedBar(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function bucketLabel(bucket: StatsBucket, weekly: boolean): string {
  if (!weekly) return shortDay(bucket.startUnix);
  const last = bucket.startUnix + (bucket.days - 1) * 86400;
  return `${shortDay(bucket.startUnix)} – ${shortDay(last)}`;
}

/**
 * Stacked bars: the viewer's part at the bottom (amber), everyone else above it (teal). Hover or
 * focus a column for its numbers; the same numbers are in the table under the chart.
 */
function BarChart({
  title,
  series,
  pick,
  weekly,
  hasYou,
  emptyText,
}: {
  title: string;
  series: StatsBucket[];
  pick: (counts: StatsCounts) => number;
  weekly: boolean;
  hasYou: boolean;
  emptyText: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const height = 200;
  const margin = { top: 10, right: 6, bottom: 24, left: 44 };
  const plotW = Math.max(0, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;

  const totals = series.map((b) => pick(b.company));
  const yours = series.map((b) => (b.you ? pick(b.you) : 0));
  const sum = totals.reduce((a, b) => a + b, 0);
  const max = niceMax(Math.max(0, ...totals));
  const y = (value: number) => margin.top + plotH - (value / max) * plotH;
  const slot = series.length ? plotW / series.length : 0;
  const gap = Math.min(6, slot * 0.25);
  const barW = Math.max(1, slot - gap);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  // Label as many columns as fit: every day for a week, every few days for a month.
  const labelEvery = Math.max(1, Math.ceil(series.length / Math.max(1, Math.floor(plotW / (weekly ? 64 : 46)))));

  const summary =
    sum === 0
      ? `${title}: none in this period.`
      : `${title}: ${fmtInt(sum)} in total. ` +
        series.map((b, i) => `${bucketLabel(b, weekly)}: ${fmtInt(totals[i]!)}`).join("; ") +
        ".";

  const tip = active != null ? series[active] : undefined;
  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={summary}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={margin.left} x2={width - margin.right} y1={y(t)} y2={y(t)} />
              <text className="tick" x={margin.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {fmtInt(t)}
              </text>
            </g>
          ))}
          {series.map((bucket, i) => {
            const x = margin.left + i * slot + gap / 2;
            const total = totals[i]!;
            const mine = Math.min(yours[i]!, total);
            const rest = total - mine;
            const mineH = (mine / max) * plotH;
            const restH = (rest / max) * plotH;
            // A 2px surface gap between the two segments, taken out of the upper one.
            const between = mine > 0 && rest > 0 ? 2 : 0;
            return (
              <g
                key={bucket.startUnix}
                className={`col${active === i ? " on" : ""}`}
                tabIndex={0}
                aria-label={`${bucketLabel(bucket, weekly)}: ${fmtInt(total)}${hasYou ? `, you ${fmtInt(mine)}` : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                {/* Hit target: the whole column, not just the bar. */}
                <rect className="hit" x={margin.left + i * slot} y={margin.top} width={slot} height={plotH} />
                {mine > 0 && (
                  <path
                    className="bar you"
                    d={rest > 0 ? `M${x},${y(0)}h${barW}v${-mineH}h${-barW}Z` : topRoundedBar(x, y(0) - mineH, barW, mineH)}
                  />
                )}
                {rest > 0 && restH - between > 0 && (
                  <path className="bar rest" d={topRoundedBar(x, y(0) - mineH - restH, barW, restH - between)} />
                )}
                {i % labelEvery === 0 && (
                  <text className="tick" x={x + barW / 2} y={height - 6} textAnchor="middle">
                    {weekly ? shortDay(bucket.startUnix) : series.length <= 7 ? `${weekday(bucket.startUnix)} ${new Date(bucket.startUnix * 1000).getDate()}` : shortDay(bucket.startUnix)}
                  </text>
                )}
              </g>
            );
          })}
          <line className="axis" x1={margin.left} x2={width - margin.right} y1={y(0)} y2={y(0)} />
        </svg>
      )}
      {sum === 0 && width > 0 && <div className="chart-empty">{emptyText}</div>}
      {tip && active != null && (
        <div
          className="chart-tip"
          style={{
            left: Math.min(Math.max(margin.left + (active + 0.5) * slot, 70), width - 70),
            top: Math.max(0, y(totals[active]!) - 8),
          }}
        >
          <strong>{bucketLabel(tip, weekly)}</strong>
          <span>Everyone: {fmtInt(totals[active]!)}</span>
          {hasYou && <span>You: {fmtInt(Math.min(yours[active]!, totals[active]!))}</span>}
        </div>
      )}
    </div>
  );
}

function ChartTable({
  series,
  weekly,
  hasYou,
  columns,
}: {
  series: StatsBucket[];
  weekly: boolean;
  hasYou: boolean;
  columns: [string, (c: StatsCounts) => number][];
}) {
  return (
    <details className="chart-table">
      <summary>Show the numbers</summary>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>{weekly ? "Week" : "Day"}</th>
              {columns.map(([label]) => (
                <th className="num" key={label}>{label}</th>
              ))}
              {hasYou && columns.map(([label]) => (
                <th className="num" key={`you-${label}`}>You: {label.toLowerCase()}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {series.map((bucket) => (
              <tr key={bucket.startUnix}>
                <td>{bucketLabel(bucket, weekly)}</td>
                {columns.map(([label, pick]) => (
                  <td className="num" key={label}>{fmtInt(pick(bucket.company))}</td>
                ))}
                {hasYou && columns.map(([label, pick]) => (
                  <td className="num" key={`you-${label}`}>{fmtInt(bucket.you ? pick(bucket.you) : 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Legend({ hasYou }: { hasYou: boolean }) {
  if (!hasYou) return null;
  return (
    <div className="chart-legend">
      <span><span className="swatch you" aria-hidden="true" />You</span>
      <span><span className="swatch rest" aria-hidden="true" />Everyone else</span>
    </div>
  );
}

// --- lists ------------------------------------------------------------------------------------

/** A name in a list: the viewer's own links to My posts; deleted accounts are not named. */
function Person({ name, isYou, former }: { name: string; isYou: boolean; former: boolean }) {
  return (
    <span className="who">
      <span className="avatar">{former ? "–" : initials(name)}</span>
      {isYou ? (
        <span>
          <a href="/me">{name}</a> <span className="badge brand">You</span>
        </span>
      ) : (
        <span className={former ? "muted" : undefined}>{name}</span>
      )}
    </span>
  );
}

function TopPosters({ stats, you }: { stats: StatsOverview; you: StatsYou | null }) {
  const rows = stats.topPosters;
  const days = stats.period.days;
  const youShown = rows.some((row) => row.isYou);
  return (
    <section className="panel stats-list">
      <h2>Who posted most</h2>
      {rows.length === 0 ? (
        <div className="empty">Nobody has published a post in the past {days} days.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="num" style={{ width: 44 }}>#</th>
              <th>Person</th>
              <th className="num">Posts</th>
              <th className="num">Impressions gained</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.rank}-${row.memberId ?? "former"}`} className={row.isYou ? "me-row" : undefined}>
                <td className="num">{row.rank}</td>
                <td><Person name={row.displayName} isYou={row.isYou} former={row.formerMember} /></td>
                <td className="num">{fmtInt(row.posts)}</td>
                <td className="num">{fmtInt(row.impressionsGained)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {you && !youShown && (
        <p className="stats-you-rank">
          {you.rank != null
            ? <>You: <strong>{ordinal(you.rank)}</strong> of {fmtInt(you.posterCount)}, with {fmtInt(you.posts.value)} post{you.posts.value === 1 ? "" : "s"}.</>
            : <>You haven&rsquo;t published a post in the past {days} days. <a href={WRITE_POST_URL} target="_blank" rel="noreferrer">Write a post →</a></>}
        </p>
      )}
    </section>
  );
}

function TopPosts({ stats }: { stats: StatsOverview }) {
  const rows = stats.topPosts;
  return (
    <section className="panel stats-list posts">
      <h2>Posts that gained the most impressions</h2>
      {rows.length === 0 ? (
        <div className="empty">No post has gained impressions in the past {stats.period.days} days.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Post</th>
              <th className="num">Gained</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((post) => (
              <tr key={post.postId} className={post.isYou ? "me-row" : undefined}>
                <td>
                  <Person name={post.authorName} isYou={post.isYou} former={post.formerMember} />
                  <div className="stats-post-line">
                    {post.firstLine ?? <span className="muted">No text read</span>}
                  </div>
                  <div className="small muted">
                    Posted {fmtLocalDate(post.postedAtUnix)} ·{" "}
                    <a href={post.postUrl} target="_blank" rel="noreferrer">View on LinkedIn</a>
                    {post.impressions != null && <> · {fmtInt(post.impressions)} in total</>}
                  </div>
                </td>
                <td className="num">{fmtInt(post.impressionsGained)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// --- the page ---------------------------------------------------------------------------------

function PeriodSwitch({ days, onChange }: { days: Days; onChange: (days: Days) => void }) {
  return (
    <div className="period-switch" role="group" aria-label="Period">
      {PERIODS.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={days === value}
          className={days === value ? "on" : ""}
          onClick={() => onChange(value)}
        >
          {value} days
        </button>
      ))}
    </div>
  );
}

export default function StatsOverviewPage() {
  // In the URL, so a link to "the past 30 days" can be shared. 7 is the default and stays out of it.
  const [days, setDays] = useQueryState("days", parseAsNumberLiteral(PERIODS).withDefault(7));
  const [timezone] = useState(offsetNow);
  const { data, isLoading } = useGetStatsOverview(
    { days, timezone },
    { query: { placeholderData: keepPreviousData } },
  );

  if (isLoading) return <div className="spinner">Loading…</div>;
  if (data?.status !== 200) {
    if (data?.status === 400) return <div className="notice err">{data.data.error}</div>;
    return (
      <div className="empty">
        Your session expired. <a href="/auth/login">Log in again</a>.
      </div>
    );
  }

  const stats = data.data;
  const { company, you, period, sync, series } = stats;
  const weekly = period.bucket === "week";
  const hasYou = you != null;
  const per = weekly ? "week" : "day";

  return (
    <div className="stats">
      <div className="stats-head">
        <div>
          <h1>Enzo on LinkedIn</h1>
          <p className="lede">
            How the company&rsquo;s LinkedIn posts are doing, and your part in it:{" "}
            {fmtLocalDate(Date.parse(period.since) / 1000)} to {fmtLocalDate(Date.parse(period.until) / 1000)},
            midnight to midnight in your time zone ({ZONE_NAME}).
          </p>
        </div>
        <PeriodSwitch days={days as Days} onChange={(value) => void setDays(value === 7 ? null : value)} />
      </div>

      {sync.stale && (
        <div className="notice warn">
          {sync.lastSyncAtUnix != null
            ? <>No one has synced since {shortDay(sync.lastSyncAtUnix)}. Numbers will update when the extension is syncing again.</>
            : <>No one has synced yet. Numbers will appear once the extension starts syncing.</>}
        </div>
      )}

      {you && !you.hasSynced && (
        <section className="panel stats-prompt">
          <h2>Your posts aren&rsquo;t syncing yet</h2>
          <p className="muted">
            Install the browser extension so your LinkedIn posts sync here, then write a post. Once
            you&rsquo;re signed in here and on LinkedIn it connects by itself, and your numbers
            appear the moment your first data arrives.
          </p>
          <p style={{ margin: 0 }}>
            <a className="btn" href={EXTENSION_STORE_URL} target="_blank" rel="noreferrer">Install the extension →</a>{" "}
            <a className="btn ghost" href={WRITE_POST_URL} target="_blank" rel="noreferrer">Write a post →</a>
          </p>
        </section>
      )}

      <div className="stat-tiles">
        <Tile
          label="Posts published"
          metric={company.posts}
          days={period.days}
          you={you && <YouLine value={you.posts.value} share={you.shareOfPosts} />}
        />
        <Tile
          label="People who posted"
          metric={company.people}
          days={period.days}
          sub={<>of {fmtInt(company.activeMembers)}</>}
          you={you && (
            <>
              <span className="swatch you" aria-hidden="true" />
              {you.posted ? <>You posted</> : <>You haven&rsquo;t posted yet</>}
            </>
          )}
        />
        <Tile
          label="Impressions gained"
          metric={company.impressions}
          days={period.days}
          you={you && <YouLine value={you.impressions.value} share={you.shareOfImpressions} />}
        />
        <Tile
          label="Out-of-network impressions gained"
          metric={company.outOfNetworkImpressions}
          days={period.days}
          you={you && <YouLine value={you.outOfNetworkImpressions.value} share={you.shareOfOutOfNetworkImpressions} />}
        />
        <Tile
          label="Reactions + comments gained"
          metric={company.engagement}
          days={period.days}
          you={you && <YouLine value={you.engagement.value} share={you.shareOfEngagement} />}
        />
      </div>

      <div className="stats-charts">
        <section className="panel">
          <h2>Posts published per {per}</h2>
          <Legend hasYou={hasYou} />
          <BarChart
            title={`Posts published per ${per}`}
            series={series}
            pick={(c) => c.posts}
            weekly={weekly}
            hasYou={hasYou}
            emptyText="No posts in this period"
          />
          <ChartTable series={series} weekly={weekly} hasYou={hasYou} columns={[["Posts", (c) => c.posts]]} />
        </section>
        <section className="panel">
          <h2>Impressions gained per {per}</h2>
          <Legend hasYou={hasYou} />
          <BarChart
            title={`Impressions gained per ${per}`}
            series={series}
            pick={(c) => c.impressions}
            weekly={weekly}
            hasYou={hasYou}
            emptyText="No new impressions read in this period"
          />
          <p className="chart-caption">
            A gain is counted on the {per} the extension read it, so one post can add to several {per}s.
          </p>
          <ChartTable
            series={series}
            weekly={weekly}
            hasYou={hasYou}
            columns={[
              ["Impressions", (c) => c.impressions],
              ["Out of network", (c) => c.outOfNetworkImpressions],
              ["Reactions + comments", (c) => c.engagement],
            ]}
          />
        </section>
      </div>

      <div className="stats-lists">
        <TopPosters stats={stats} you={you} />
        <TopPosts stats={stats} />
      </div>

      <details className="stats-defs">
        <summary>How these numbers are counted</summary>
        <ul>
          <li>
            <strong>Posts published</strong>: original posts that went up in the period. Reshares
            are not counted, as in the post reports.
          </li>
          <li>
            <strong>People who posted</strong>: everyone with at least one of those posts, out of
            every account that has not been deleted.
          </li>
          <li>
            <strong>Impressions gained</strong>: how much the impression totals of the company&rsquo;s
            original posts grew during the period, whenever the post went up. For each post, the last
            number read before the period ended minus the last number read before it began (0 if it
            was first read during the period), never below 0. Posts published more than 45 days
            before the period are left out: the extension stops re-reading them by then.
          </li>
          <li>
            <strong>Out-of-network impressions</strong> and <strong>reactions + comments</strong> are
            counted the same way.
          </li>
          <li>
            Each number is compared with the {period.days} days just before. People who have left
            still count in the totals, so past numbers do not change, but are listed as
            &ldquo;Former member&rdquo;.
          </li>
        </ul>
      </details>
    </div>
  );
}
