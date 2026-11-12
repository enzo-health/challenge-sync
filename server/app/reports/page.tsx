// Admin post reports: everyone's posts from a period, filtered by impressions and text, who
// posted, and a CSV export. The same report is served to an admin's AI agent at /api/v1/posts with an API key,
// and the keys are managed at the bottom of this page. Reachable only with the admin flag.
import {
  getGetPostReportUrl,
  getListApiKeysQueryKey,
  useCreateApiKey,
  useGetPostReport,
  useListApiKeys,
  useRevokeApiKey,
} from "@linkedin-challenge/client/react-query";
import type { GetPostReportParams } from "@linkedin-challenge/client/react-query";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { fmtInt, fmtLocalDate, initials } from "../../components/format";
import { PostText } from "../../components/member-results";
import { ConfirmModal } from "../../components/confirm-modal";

// The dates on this page are the viewer's own days. The browser knows its time zone and its
// daylight saving rules, so it turns each day into exact instants and the server needs no time
// zone database: a Thursday-evening post in Denver stays in Thursday's week.
const pad = (n: number) => String(n).padStart(2, "0");

/** A `Date`'s UTC offset as `-07:00`, at that moment (so a range across a clock change is right). */
function offsetOf(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** A local wall-clock time as ISO 8601 with its offset, e.g. `2026-11-12T23:59:59-07:00`. */
function localIso(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offsetOf(date)}`
  );
}

/** `YYYY-MM-DD` for today plus `offsetDays`, in the viewer's time zone. */
function localDay(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The first or last second of a `YYYY-MM-DD` day in the viewer's time zone. */
function dayEdge(day: string, end: boolean): Date {
  const [y, m, d] = day.split("-").map(Number);
  return end ? new Date(y!, m! - 1, d!, 23, 59, 59) : new Date(y!, m! - 1, d!, 0, 0, 0);
}

const ZONE_NAME = Intl.DateTimeFormat().resolvedOptions().timeZone;

type Form = {
  since: string;
  until: string;
  minImpressions: string;
  minOutOfNetwork: string;
  contains: string;
  includeReposts: boolean;
};

function toParams(form: Form): GetPostReportParams {
  const until = dayEdge(form.until, true);
  const params: GetPostReportParams = {
    since: localIso(dayEdge(form.since, false)),
    until: localIso(until),
    // So the CSV's posted_at_local column and the echoed period read in the viewer's time.
    timezone: offsetOf(until),
  };
  if (form.includeReposts) params.includeReposts = true;
  // Empty boxes mean "no minimum"; sending them would be a 400 for a number that is not one.
  if (form.minImpressions.trim()) params.minImpressions = Number(form.minImpressions);
  if (form.minOutOfNetwork.trim()) params.minOutOfNetworkImpressions = Number(form.minOutOfNetwork);
  if (form.contains.trim()) params.contains = form.contains.trim();
  return params;
}

const num = (n: number | null) => (n == null ? "—" : fmtInt(n));

export default function Reports() {
  const [form, setForm] = useState<Form>({
    since: localDay(-6),
    until: localDay(0),
    minImpressions: "",
    minOutOfNetwork: "",
    contains: "",
    includeReposts: false,
  });
  const [params, setParams] = useState<GetPostReportParams>(() => toParams(form));
  // Keep the last result on screen while a new one loads, instead of blanking the page.
  const { data, isLoading, isFetching } = useGetPostReport(params, {
    query: { placeholderData: keepPreviousData },
  });

  const run = (event: FormEvent) => {
    event.preventDefault();
    setParams(toParams(form));
  };
  const field = (key: "since" | "until" | "minImpressions" | "minOutOfNetwork" | "contains") => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value }),
  });

  if (isLoading) return <div className="spinner">Loading…</div>;
  if (data?.status === 401) {
    return (
      <div className="empty">
        Your session expired. <a href="/auth/login">Log in again</a>.
      </div>
    );
  }

  const report = data?.status === 200 ? data.data : null;
  const error = data && data.status !== 200 ? data.data.error : null;
  const filtered =
    params.minImpressions != null || params.minOutOfNetworkImpressions != null || params.contains != null;

  return (
    <>
      <h1>Post reports</h1>
      <p className="lede">
        Everyone&rsquo;s original posts from a period, with their latest numbers. Both dates are
        included, from midnight to midnight in your time zone ({ZONE_NAME}). Minimums are
        &ldquo;at least&rdquo;: for strictly over 3,000, enter 3001. &ldquo;Post mentions&rdquo;
        ignores case. Leave the filters empty to see everyone who posted.
      </p>

      <form className="panel" onSubmit={run}>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          <label className="field">
            <span>From</span>
            <input type="date" required {...field("since")} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" required {...field("until")} />
          </label>
          <label className="field">
            <span>Minimum impressions</span>
            <input type="number" min={0} step={1} placeholder="Any" {...field("minImpressions")} />
          </label>
          <label className="field">
            <span>Minimum out-of-network impressions</span>
            <input type="number" min={0} step={1} placeholder="Any" {...field("minOutOfNetwork")} />
          </label>
          <label className="field">
            <span>Post mentions</span>
            <input type="search" placeholder="e.g. Enzo" {...field("contains")} />
          </label>
        </div>
        <label className="small" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={form.includeReposts}
            onChange={(event) => setForm({ ...form, includeReposts: event.target.checked })}
          />
          Include reshares (only original posts count by default)
        </label>
        <p style={{ margin: 0 }}>
          <button type="submit" disabled={isFetching}>
            {isFetching ? "Loading…" : "Show posts"}
          </button>{" "}
          {/* The download comes from the server with the filters shown, not from this table, so
              the file is exactly what an agent gets with format=csv. */}
          <a className="btn ghost" href={getGetPostReportUrl({ ...params, format: "csv" })} download>
            Export CSV
          </a>
        </p>
      </form>

      {error && <div className="notice err">{error}</div>}

      {report && (
        <>
          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <div className="stat">
              <div className="k">{filtered ? "Matching posts" : "Posts"}</div>
              <div className="v">{fmtInt(report.postCount)}</div>
            </div>
            <div className="stat">
              <div className="k">People who posted</div>
              <div className="v">{fmtInt(report.authors.length)}</div>
            </div>
            <div className="stat">
              <div className="k">Period</div>
              <div className="v" style={{ fontSize: 16 }}>
                {fmtLocalDate(Date.parse(report.filters.since) / 1000)} –{" "}
                {fmtLocalDate(Date.parse(report.filters.until) / 1000)}
              </div>
            </div>
          </div>

          <h2>Posts</h2>
          <div className="panel" style={{ padding: 0, overflowX: "auto" }}>
            {report.posts.length === 0 ? (
              <div className="empty">No posts match these filters.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Author</th>
                    <th>Post</th>
                    <th>Date</th>
                    <th className="num">Impressions</th>
                    <th className="num">Out of network</th>
                    <th className="num">Reactions</th>
                    <th className="num">Comments</th>
                  </tr>
                </thead>
                <tbody>
                  {report.posts.map((post) => (
                    <tr key={post.postId}>
                      <td>
                        <span className="who">
                          <span className="avatar">{initials(post.authorName)}</span>
                          <span>{post.authorName}</span>
                        </span>
                      </td>
                      {/* The whole text, clamped to three lines with "show more": deciding whether a
                          post is about Enzo means reading it. */}
                      <td className="small" style={{ minWidth: 280, maxWidth: 480 }}>
                        {post.isRepost && <span className="post-kind">Repost</span>}
                        <PostText key={post.postId} text={post.text} />
                        <a href={post.postUrl} target="_blank" rel="noreferrer">
                          View on LinkedIn
                        </a>
                      </td>
                      <td className="small muted">{fmtLocalDate(post.postedAtUnix)}</td>
                      <td className="num">{num(post.impressions)}</td>
                      <td className="num">{num(post.impressionsOutOfNetwork)}</td>
                      <td className="num">{num(post.reactions)}</td>
                      <td className="num">{num(post.comments)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <h2>Who posted</h2>
          <div className="panel" style={{ padding: 0, overflowX: "auto" }}>
            {report.authors.length === 0 ? (
              <div className="empty">Nobody posted in this period.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th className="num">Posts in period</th>
                    {filtered && <th className="num">Matching</th>}
                  </tr>
                </thead>
                <tbody>
                  {report.authors.map((author) => (
                    <tr key={author.memberId}>
                      <td>
                        <span className="who">
                          <span className="avatar">{initials(author.displayName)}</span>
                          <span>{author.displayName}</span>
                        </span>
                      </td>
                      <td className="num">{fmtInt(author.postsInPeriod)}</td>
                      {filtered && <td className="num">{fmtInt(author.matchingPosts)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <ApiKeys />
    </>
  );
}

function ApiKeys() {
  const { data } = useListApiKeys();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ id: number; name: string } | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const keys = data?.status === 200 ? data.data.keys : [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListApiKeysQueryKey() });
  const origin = window.location.origin;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    create.mutate(
      { data: { name } },
      {
        onSuccess: (res) => {
          if (res.status !== 200) {
            setError(res.data.error);
            return;
          }
          setCreated({ name: res.data.name, key: res.data.key });
          setCopied(false);
          setName("");
          refresh();
        },
        onError: () => setError("The key could not be created. Try again."),
      },
    );
  };

  return (
    <>
      <h2>API keys</h2>
      <div className="panel">
        <p className="muted" style={{ marginTop: 0 }}>
          Give a key to an AI agent or a script so it can fetch this report itself. A key can read
          everyone&rsquo;s post data, so share it only with something you trust, and revoke it when
          it is no longer needed. Instructions for the agent are in{" "}
          <span className="code">docs/reporting-api.md</span>.
        </p>

        {created && (
          <div className="notice ok">
            <p style={{ marginTop: 0 }}>
              <strong>{created.name}</strong>: copy this key now. It will not be shown again.
            </p>
            <p style={{ marginBottom: 0 }}>
              <span className="code" style={{ wordBreak: "break-all" }}>{created.key}</span>{" "}
              <button
                className="btn ghost sm"
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(created.key).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </p>
          </div>
        )}
        {error && <div className="notice err">{error}</div>}

        <form onSubmit={submit} style={{ display: "flex", gap: 8, alignItems: "end", marginBottom: 16 }}>
          <label className="field" style={{ flex: 1, marginBottom: 0 }}>
            <span>Name, so you know which key is which</span>
            <input
              value={name}
              maxLength={100}
              required
              placeholder="e.g. Jason's agent"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button type="submit" disabled={create.isPending || !name.trim()}>
            Create key
          </button>
        </form>

        {keys.length === 0 ? (
          <p className="muted">No API keys yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td className="small muted">
                    {fmtLocalDate(key.createdAt)}
                    {key.createdByName ? ` by ${key.createdByName}` : ""}
                  </td>
                  <td className="small muted">{key.lastUsedAt ? fmtLocalDate(key.lastUsedAt) : "never"}</td>
                  <td className="num">
                    <button
                      className="btn ghost sm"
                      type="button"
                      disabled={revoke.isPending}
                      onClick={() => {
                        setRevokeError(null);
                        setRevoking({ id: key.id, name: key.name });
                      }}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3>Example</h3>
        <p className="muted small">
          Posts in the past week that mention Enzo with at least 3,000 out-of-network impressions
          (&ldquo;at least&rdquo; means 3,000 counts; use 3001 for strictly over). Add{" "}
          <code>&amp;timezone=-07:00</code> to read the dates in Mountain standard time (-06:00 in
          summer):
        </p>
        <pre className="code" style={{ display: "block", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {`curl -H "Authorization: Bearer $CHALLENGE_API_KEY" \\\n  "${origin}/api/v1/posts?contains=enzo&minOutOfNetworkImpressions=3000"`}
        </pre>
        <p className="muted small">
          Who posted this week (see <code>authors</code> in the response), or the same as a spreadsheet
          with <code>&amp;format=csv</code>:
        </p>
        <pre className="code" style={{ display: "block", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {`curl -H "Authorization: Bearer $CHALLENGE_API_KEY" \\\n  "${origin}/api/v1/posts"`}
        </pre>
        <p className="muted small">
          Who has the extension installed and when each person last synced:{" "}
          <code>{`${origin}/api/v1/members`}</code> (same key).
        </p>
      </div>
      <ConfirmModal
        open={revoking !== null}
        title="Revoke API key"
        confirmLabel="Revoke"
        danger
        busy={revoke.isPending}
        error={revokeError}
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          if (!revoking) return;
          setRevokeError(null);
          revoke.mutate(
            { id: revoking.id },
            {
              onSuccess: (res) => {
                if (res.status !== 200) {
                  setRevokeError("The key could not be revoked. Try again.");
                  return;
                }
                setRevoking(null);
                refresh();
              },
              onError: () => setRevokeError("The key could not be revoked. Try again."),
            },
          );
        }}
      >
        <p>Revoke &ldquo;{revoking?.name}&rdquo;? Anything using it stops working at once.</p>
      </ConfirmModal>
    </>
  );
}
