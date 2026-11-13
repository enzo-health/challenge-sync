// Owner settings for one challenge: name, window, and the scoring rules. Scores are derived at
// read time, so saving here re-scores the board immediately.
import {
  getGetChallengesQueryKey,
  getGetLeaderboardQueryKey,
  useGetLeaderboard,
  useUpdateChallenge,
} from "@linkedin-challenge/client/react-query";
import type { ScoringConfig } from "@linkedin-challenge/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ScoringFields } from "../../../../components/challenge-form";
import { errorText } from "../../../../components/host-block";

function isoDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

export default function ChallengeSettingsPage({ params }: { params: { id: string } }) {
  const challengeId = Number(params.id);
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetLeaderboard({ challengeId });
  const update = useUpdateChallenge();
  const challenge = data?.status === 200 ? data.data.competition : undefined;

  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [cfg, setCfg] = useState<ScoringConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!challenge || cfg) return;
    setName(challenge.name);
    setStart(isoDate(challenge.startAt));
    setEnd(isoDate(challenge.endAt));
    setIsActive(challenge.isActive);
    setCfg(challenge.config);
  }, [challenge, cfg]);

  if (isLoading) return <div className="spinner">Loading…</div>;
  if (!challenge || !challenge.isOwner) {
    return <div className="empty">Only a challenge owner can change its settings.</div>;
  }
  if (!cfg) return <div className="spinner">Loading…</div>;

  return (
    <>
      <p className="small muted">
        <a href={`/challenges/${challengeId}`}>← Back to the board</a>
      </p>
      <h1>Challenge settings</h1>
      <p className="lede">
        Changing the rules re-scores everyone on the next page load. Nothing is stored, so there
        is nothing to migrate.
      </p>
      {error && <div className="notice err">{error}</div>}
      {saved && <div className="notice ok">Saved. The board now uses these rules.</div>}
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          setSaved(false);
          update.mutate(
            { id: challengeId, data: { name, start, end, isActive, config: cfg } },
            {
              onSuccess: (res) => {
                if (res.status === 200) {
                  setSaved(true);
                  void queryClient.invalidateQueries({ queryKey: getGetChallengesQueryKey() });
                  void queryClient.invalidateQueries({
                    queryKey: getGetLeaderboardQueryKey({ challengeId }),
                  });
                } else {
                  setError(res.data?.error ?? "Could not save the challenge.");
                }
              },
              onError: (error) => setError(errorText(error, "Could not save the challenge.")),
            },
          );
        }}
      >
        <div className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field row">
          <label className="field" style={{ margin: 0 }}>
            <span>Start</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>End (inclusive)</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} required />
          </label>
        </div>
        <label className="field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            style={{ width: "auto" }}
          />
          <span style={{ margin: 0 }}>Active (people are auto-enrolled while it runs)</span>
        </label>

        <ScoringFields cfg={cfg} onChange={setCfg} />

        <p style={{ marginTop: 18, display: "flex", gap: 8 }}>
          <button type="submit" disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save settings"}
          </button>
          <a className="btn ghost" href={`/challenges/${challengeId}`}>
            Cancel
          </a>
        </p>
      </form>
    </>
  );
}
