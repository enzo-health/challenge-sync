// One member's results, LinkedIn-analytics style: the overall standing first, then each post
// behind it, grouped into the same weekly buckets the scoring uses. Shared by "My results" and
// the leaderboard drill-in — the manifest wants those to be the same view of the same data.
import { useGetMemberDetail, useGetMyPosts } from "@linkedin-challenge/client/react-query";
import type { PostStat, WeekGroup } from "@linkedin-challenge/client";
import { parseAsInteger, parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs";
import { useEffect, useRef, useState } from "react";
import { fmtInt, fmtNum, fmtDate, initials } from "./format";

const PAGE_SIZE = 50;
const POST_SORTS = [
  "newest",
  "oldest",
  "impressions",
  "reactions",
  "comments",
  "reposts",
  "sends",
  "saves",
] as const;

function Metric({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="metric">
      <span className="n">{fmtInt(value)}</span>
      <span className="k">{label}</span>
      {sub && <span className="k muted">{sub}</span>}
    </div>
  );
}

/** Post text clamped to three lines, with a "show more" toggle when it is longer. Also used by
 * the admin Reports page, so a post reads the same everywhere. */
export function PostText({ text }: { text: string | null | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    setExpanded(false);
    setCanExpand(false);
  }, [text]);

  useEffect(() => {
    const element = textRef.current;
    if (!element || expanded) return;
    setCanExpand(element.scrollHeight > element.clientHeight + 1);
  }, [expanded, text]);

  return (
    <>
      <p ref={textRef} className={`post-text${expanded ? "" : " collapsed"}`}>
        {text || <span className="muted">(no post text)</span>}
      </p>
      {canExpand && (
        <button
          type="button"
          className="post-text-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "…show more"}
        </button>
      )}
    </>
  );
}

function Post({ post, showMedia }: { post: PostStat; showMedia: boolean }) {
  const total = post.impressionsInNetwork + post.impressionsOutOfNetwork;

  return (
    <div className="post">
      {post.isRepost && <span className="post-kind">Repost</span>}
      {/* Keyed by post so switching posts starts collapsed, as it did before this was shared. */}
      <PostText key={post.id} text={post.textPreview} />
      {showMedia && post.imageUrls.length > 0 && (
        <div className={`post-media count-${Math.min(post.imageUrls.length, 4)}`}>
          {post.imageUrls.map((url, index) => (
            <img
              key={url}
              src={url}
              alt={`Attached media ${index + 1} of ${post.imageUrls.length}`}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ))}
        </div>
      )}
      <div className="metrics">
        <Metric label="Impressions" value={post.impressions} />
        <Metric label="Reactions" value={post.reactions} />
        {/* Only other people's comments score, so show that number and keep the raw total beside
            it — otherwise a post whose comments are all the author's own looks mis-scored. */}
        <Metric
          label={post.comments !== post.commentsByOthers ? "Comments (others)" : "Comments"}
          value={post.commentsByOthers}
          sub={post.comments !== post.commentsByOthers ? `${post.comments} total` : undefined}
        />
        <Metric label="Reposts" value={post.reposts} />
        <Metric label="Sends" value={post.sends} />
        <Metric label="Saves" value={post.saves} />
      </div>
      {(total > 0 || post.membersReached > 0 || post.profileViewersFromPost > 0 || post.followersFromPost > 0) && (
        <div className="metrics" style={{ marginTop: 8 }}>
          {total > 0 && (
            <>
              <Metric
                label="In-network"
                value={post.impressionsInNetwork}
                sub={`${Math.round((post.impressionsInNetwork / total) * 100)}%`}
              />
              <Metric
                label="Out-of-network"
                value={post.impressionsOutOfNetwork}
                sub={`${Math.round((post.impressionsOutOfNetwork / total) * 100)}%`}
              />
            </>
          )}
          <Metric label="Members reached" value={post.membersReached} />
          <Metric label="Profile views from post" value={post.profileViewersFromPost} />
          <Metric label="Followers from post" value={post.followersFromPost} />
        </div>
      )}
      <p className="small muted" style={{ marginBottom: 0, marginTop: 8 }}>
        {fmtDate(post.postedAt)}
        {post.permalink && (
          <>
            {" · "}
            <a href={post.permalink} target="_blank" rel="noreferrer">
              View on LinkedIn
            </a>
          </>
        )}
      </p>
    </div>
  );
}

function Week({
  group,
  gradedPerWeek,
  showMedia,
}: {
  group: WeekGroup;
  gradedPerWeek: number;
  showMedia: boolean;
}) {
  const counted = Math.min(gradedPerWeek, group.posts.length);
  return (
    <section>
      <div className="week-head">
        <h3>Week {group.week + 1}</h3>
        <span className="small muted">
          {fmtDate(group.startAt)} → {fmtDate(group.endAt)} · {group.posts.length} post
          {group.posts.length === 1 ? "" : "s"}
          {group.posts.length > counted && `, best ${counted} scored`}
        </span>
      </div>
      {group.posts.map((post) => (
        <Post key={post.id} post={post} showMedia={showMedia} />
      ))}
    </section>
  );
}

function PostExplorer({
  posts,
  total,
  page,
  pageCount,
  filter,
  sort,
  onFilter,
  onSort,
  onPage,
  showMedia,
}: {
  posts: PostStat[];
  total: number;
  page: number;
  pageCount: number;
  filter: string;
  sort: (typeof POST_SORTS)[number];
  onFilter: (value: string) => void;
  onSort: (value: (typeof POST_SORTS)[number]) => void;
  onPage: (value: number) => void;
  showMedia: boolean;
}) {
  const [filterInput, setFilterInput] = useState(filter);
  const filterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setFilterInput(filter), [filter]);
  useEffect(() => () => {
    if (filterTimer.current) clearTimeout(filterTimer.current);
  }, []);

  return (
    <section className="post-explorer">
      <div className="post-explorer-head">
        <div>
          <h2>Synced posts</h2>
          <p className="small muted">
            {total} post{total === 1 ? "" : "s"}
          </p>
        </div>
        <div className="post-controls">
          <label>
            <span>Filter posts</span>
            <input
              type="search"
              value={filterInput}
              onChange={(event) => {
                const value = event.target.value;
                setFilterInput(value);
                if (filterTimer.current) clearTimeout(filterTimer.current);
                filterTimer.current = setTimeout(() => onFilter(value), 300);
              }}
              placeholder="Search post text"
            />
          </label>
          <label>
            <span>Sort by</span>
            <select
              value={sort}
              onChange={(event) => {
                onSort(event.target.value as (typeof POST_SORTS)[number]);
              }}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="impressions">Most impressions</option>
              <option value="reactions">Most reactions</option>
              <option value="comments">Most comments</option>
              <option value="reposts">Most reposts</option>
              <option value="sends">Most sends</option>
              <option value="saves">Most saves</option>
            </select>
          </label>
        </div>
      </div>
      {posts.length === 0 ? (
        <div className="empty">
          {filter ? "No posts match that filter." : "No posts have synced yet."}
        </div>
      ) : (
        <div className="post-list">
          {posts.map((post) => (
            <Post key={post.id} post={post} showMedia={showMedia} />
          ))}
        </div>
      )}
      {pageCount > 1 && (
        <nav className="pagination" aria-label="Synced posts pages">
          <button
            type="button"
            disabled={page === 1}
            onClick={() => onPage(page - 1)}
          >
            Previous
          </button>
          <span className="small muted">
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            disabled={page === pageCount}
            onClick={() => onPage(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}

export function MemberResults({
  memberId,
  challengeId,
  backHref,
  backLabel,
}: {
  memberId: number;
  challengeId?: number;
  backHref?: string;
  backLabel?: string;
}) {
  const [showMedia, setShowMedia] = useState(false);
  const [{ filter, sort, page }, setParams] = useQueryStates({
    filter: parseAsString.withDefault(""),
    sort: parseAsStringLiteral(POST_SORTS).withDefault("newest"),
    page: parseAsInteger.withDefault(1),
  });
  const { data, isLoading } = useGetMemberDetail(
    memberId,
    { challengeId, filter: filter || undefined, sort, page, pageSize: PAGE_SIZE },
  );
  const serverPage = data?.status === 200 ? data.data.postPage : page;
  useEffect(() => {
    if (page !== serverPage) void setParams({ page: serverPage });
  }, [page, serverPage, setParams]);

  if (isLoading) return <div className="spinner">Loading results…</div>;
  if (data?.status !== 200) {
    return <div className="empty">We couldn&rsquo;t find that participant.</div>;
  }

  const detail = data.data;
  const { standing, competition, weeks } = detail;

  return (
    <>
      {backHref && (
        <p className="small muted">
          <a href={backHref}>← {backLabel ?? "Back"}</a>
        </p>
      )}

      <div className="who" style={{ gap: 14, marginBottom: 4 }}>
        <span className="avatar" style={{ width: 48, height: 48, fontSize: 16 }}>
          {initials(detail.displayName)}
        </span>
        <h1 style={{ margin: 0 }}>{detail.displayName}</h1>
      </div>

      <p className="small muted">
        <strong>{detail.followerCount == null ? "Followers not synced yet" : `${fmtInt(detail.followerCount)} followers`}</strong>
        {detail.followerCount != null && " · Latest synced count"}
      </p>

      {detail.profileUrl && (
        <p className="small muted">
          <a href={detail.profileUrl} target="_blank" rel="noreferrer">
            LinkedIn profile
          </a>
        </p>
      )}

      <MediaToggle checked={showMedia} onChange={setShowMedia} />

      {!competition ? (
        <p className="lede">
          No challenge is running yet. Your LinkedIn results will still sync and appear below.
        </p>
      ) : (
        <>
          <p className="lede">
            <strong>{competition.name}</strong> · {fmtDate(competition.startAt)} →{" "}
            {fmtDate(competition.endAt)}
          </p>

          {standing ? (
            <div className="grid cols-4">
              <div className="stat">
                <div className="k">Rank</div>
                <div className="v">#{standing.rank}</div>
              </div>
              <div className="stat">
                <div className="k">Total points</div>
                <div className="v">{fmtNum(standing.total)}</div>
              </div>
              <div className="stat">
                <div className="k">Followers used for scoring</div>
                <div className="v">{standing.followersUnknown ? "Not synced" : fmtInt(standing.followerCount)}</div>
              </div>
              <div className="stat">
                <div className="k">Posts scored</div>
                <div className="v">
                  {standing.gradedPosts}
                  {standing.totalPosts > standing.gradedPosts && (
                    <span className="muted small"> / {standing.totalPosts}</span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="empty">No synced data inside the challenge window yet.</div>
          )}

          {standing && (
            <p className="small muted">
              {competition.config.normalizeByFollowers && competition.config.followerBaseline > 0 && standing.followerCount > 0
                ? `Engagement adjustment: ${fmtInt(competition.config.followerBaseline)} baseline ÷ ${fmtInt(standing.followerCount)} followers = ${(competition.config.followerBaseline / standing.followerCount).toLocaleString(undefined, { maximumSignificantDigits: 3 })}×. Applied to capped engagement points; posting and consistency points stay the same.`
                : "Engagement is not scaled by follower count for these results."}
              {" "}<a href={`/challenges/${competition.id}/scoring`}>See scoring rules →</a>
            </p>
          )}

          <h2>Posts by week</h2>
          {weeks.length === 0 ? (
            <div className="empty">No posts in the challenge window.</div>
          ) : (
            weeks.map((group) => (
              <Week
                key={group.week}
                group={group}
                gradedPerWeek={competition.config.maxPostsPerWeek}
                showMedia={showMedia}
              />
            ))
          )}

        </>
      )}

      <PostExplorer
        posts={detail.posts}
        total={detail.postCount}
        page={detail.postPage}
        pageCount={detail.postPageCount}
        filter={filter}
        sort={sort}
        onFilter={(value) => void setParams({ filter: value, page: 1 })}
        onSort={(value) => void setParams({ sort: value, page: 1 })}
        onPage={(value) => void setParams({ page: value })}
        showMedia={showMedia}
      />
    </>
  );
}

export function PersonalPosts({ displayName }: { displayName: string }) {
  const [showMedia, setShowMedia] = useState(false);
  const [{ filter, sort, page }, setParams] = useQueryStates({
    filter: parseAsString.withDefault(""),
    sort: parseAsStringLiteral(POST_SORTS).withDefault("newest"),
    page: parseAsInteger.withDefault(1),
  });
  const { data, isLoading } = useGetMyPosts({
    filter: filter || undefined,
    sort,
    page,
    pageSize: PAGE_SIZE,
  });
  const serverPage = data?.status === 200 ? data.data.page : page;
  useEffect(() => {
    if (page !== serverPage) void setParams({ page: serverPage });
  }, [page, serverPage, setParams]);

  if (isLoading) return <div className="spinner">Loading results…</div>;
  if (data?.status !== 200) return <div className="empty">We couldn&rsquo;t load your posts.</div>;

  return (
    <>
      <div className="who" style={{ gap: 14, marginBottom: 4 }}>
        <span className="avatar" style={{ width: 48, height: 48, fontSize: 16 }}>
          {initials(displayName)}
        </span>
        <h1 style={{ margin: 0 }}>{displayName}</h1>
      </div>
      <p className="small muted">
        <strong>{data.data.followerCount == null ? "Followers not synced yet" : `${fmtInt(data.data.followerCount)} followers`}</strong>
        {data.data.followerCount != null && " · Latest synced count"}
      </p>
      <p className="lede">Your LinkedIn data belongs to you.</p>
      <MediaToggle checked={showMedia} onChange={setShowMedia} />
      <PostExplorer
        posts={data.data.posts}
        total={data.data.total}
        page={data.data.page}
        pageCount={data.data.pageCount}
        filter={filter}
        sort={sort}
        onFilter={(value) => void setParams({ filter: value, page: 1 })}
        onSort={(value) => void setParams({ sort: value, page: 1 })}
        onPage={(value) => void setParams({ page: value })}
        showMedia={showMedia}
      />
    </>
  );
}

function MediaToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="media-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>Show attached media</span>
    </label>
  );
}
