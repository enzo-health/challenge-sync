-- One-off cleanup: delete post snapshots that repeat the reading just before them.
--
-- WHAT IT DOES
-- Before sync learned to skip unchanged readings, every sync stored a post_snapshots row for every
-- post it uploaded, even when no number had moved. This deletes a row when every metric column is
-- equal (NULL equal to NULL) to the row immediately before it for the same post, ordered by
-- (captured_at, id). A post's first row is never deleted, and of every run of identical readings
-- only the first row is kept. Nothing else is touched: no other table, and no kept row is changed.
--
-- WHAT A DIRECT READER OF THE TABLE WILL SEE CHANGE
-- The latest row of every post keeps the same VALUES in every metric column: a deleted latest row
-- is always a repeat of a kept earlier row. But that post's latest `captured_at` becomes OLDER: it
-- becomes the time the current numbers were first read, not the time they were last re-read.
-- Anyone reading post_snapshots directly must not treat its newest captured_at as "capture is
-- still running" (after this script, and for every new sync, since sync no longer stores repeats);
-- profile_snapshots gets a row on every sync and is the place to look for that.
--
-- WHY EVERY SCORE STAYS THE SAME
-- Scoring and the post views read a post's snapshots in only three ways (src/scoring.rs, src/dto.rs):
--   1. the latest row captured at or before a challenge's end (`latest_snapshot_before`);
--   2. the first row's captured_at, used as the post date when LinkedIn gave us none (`posted_at`);
--   3. the latest row overall (the post list and member detail).
-- (2) is untouched because a post's first row is always kept. For (1) and (3), take any deleted
-- row D. It belongs to a run of identical readings, and the run's first row F is kept, with F
-- captured at or before D. If D was the answer for some challenge end E (D.captured_at <= E), then
-- F.captured_at <= E too, so after the cleanup the answer is F, or a later kept row of the same
-- run, all of which carry exactly the same numbers. That is the challenge end boundary case: when a
-- run of identical readings spans E, keeping the run's EARLIEST row keeps a reading at or before E
-- whenever the run had one. (Keeping the latest row of a run instead would be wrong: if it fell
-- after E, the post would lose its only in-window reading and score nothing.) A row that differs
-- from the one before it in any column is never deleted, so no answer can change its numbers.
--
-- Sync applies the same rule as rows arrive (app/api/sync/route.rs): it compares an upload with
-- the post's latest stored row and writes nothing when they match. Running this script while
-- syncs continue is safe: a sync either compares against a kept row or against a deleted repeat
-- of it, and both hold the same numbers. The test is `cargo test skipping_repeated_readings`
-- plus scripts/test-snapshot-dedupe-e2e.py, which runs this file against a throwaway database.
--
-- HOW TO RUN
-- As written it ends in ROLLBACK, so running it changes nothing: it only prints the counts. To
-- apply it, back up first (server/backup-db.sh), then change the final `ROLLBACK;` to `COMMIT;`.
-- Written for PostgreSQL; it also runs unchanged on SQLite 3.39+ (the local test uses that).

BEGIN;

SELECT count(*) AS snapshots_before, count(DISTINCT post_id) AS posts FROM post_snapshots;

WITH ordered AS (
    SELECT id, LAG(id) OVER (PARTITION BY post_id ORDER BY captured_at, id) AS previous_id
    FROM post_snapshots
)
DELETE FROM post_snapshots
WHERE id IN (
    SELECT cur.id
    FROM ordered
    JOIN post_snapshots cur ON cur.id = ordered.id
    JOIN post_snapshots prev ON prev.id = ordered.previous_id
    WHERE cur.impressions IS NOT DISTINCT FROM prev.impressions
      AND cur.reactions IS NOT DISTINCT FROM prev.reactions
      AND cur.comments IS NOT DISTINCT FROM prev.comments
      AND cur.reposts IS NOT DISTINCT FROM prev.reposts
      AND cur.sends IS NOT DISTINCT FROM prev.sends
      AND cur.saves IS NOT DISTINCT FROM prev.saves
      AND cur.impressions_in_network IS NOT DISTINCT FROM prev.impressions_in_network
      AND cur.impressions_out_of_network IS NOT DISTINCT FROM prev.impressions_out_of_network
      AND cur.members_reached IS NOT DISTINCT FROM prev.members_reached
      AND cur.profile_viewers_from_post IS NOT DISTINCT FROM prev.profile_viewers_from_post
      AND cur.followers_from_post IS NOT DISTINCT FROM prev.followers_from_post
);

-- Inspect: every post still has its first row, so `posts` must equal the count above.
SELECT count(*) AS snapshots_after, count(DISTINCT post_id) AS posts FROM post_snapshots;

-- Change to COMMIT; to keep the deletions.
ROLLBACK;
