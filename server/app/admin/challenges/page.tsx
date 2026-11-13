// Challenge setup: any user can create one and becomes its first member. Other users join only
// through challenge-specific invitations.
import { useGetAdminOverview, useCreateChallenge, getGetAdminOverviewQueryKey } from "@linkedin-challenge/client/react-query";
import type { ScoringConfig } from "@linkedin-challenge/client";
import { fmtDate } from "../../../components/format";
import { ScoringFields } from "../../../components/challenge-form";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorText } from "../../../components/host-block";

function isoDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function NewChallenge({
  defaults,
  open,
  onClose,
  onCreated,
}: {
  defaults: ScoringConfig;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [start, setStart] = useState(isoDate());
  const [end, setEnd] = useState(isoDate(90));
  const [cfg, setCfg] = useState<ScoringConfig>(defaults);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateChallenge();

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        // Backdrop only — a click that started inside the dialog shouldn't discard a filled form.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="New challenge">
        <div className="modal-head">
          <h3>New challenge</h3>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        {error && <div className="notice err">{error}</div>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate(
              { data: { name, start, end, config: cfg } },
              {
                onSuccess: (res) => {
                  if (res.status === 200) {
                    setName("");
                    onCreated();
                    onClose();
                  } else {
                    setError(res.data?.error ?? "Could not create the challenge.");
                  }
                },
                onError: (error) => setError(errorText(error, "Could not create the challenge.")),
              },
            );
          }}
        >
          <div className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Q3 Posting Sprint"
              required
            />
          </div>
          <div className="field row">
            <label className="field" style={{ margin: 0 }}>
              <span>Start</span>
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>End</span>
              <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} required />
            </label>
          </div>

          <ScoringFields cfg={cfg} onChange={setCfg} />

          <p style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create challenge"}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}

export default function ChallengeSetup() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetAdminOverview();
  const [creating, setCreating] = useState(false);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getGetAdminOverviewQueryKey() });

  if (isLoading) return <div className="spinner">Loading…</div>;
  if (data?.status !== 200) {
    return (
      <div className="empty">
        Your session expired. <a href="/auth/login">Log in again</a>.
      </div>
    );
  }

  const { competitions, defaults } = data.data;
  const now = Math.floor(Date.now() / 1000);

  return (
    <>
      <div className="week-head">
        <h1 style={{ margin: 0 }}>Challenge setup</h1>
        <button onClick={() => setCreating(true)}>New challenge</button>
      </div>
      <p className="lede">
        A challenge defines the window being measured and how results turn into a ranking.
        You become its first owner. Other people join only when they accept an invitation.
      </p>

      {competitions.length === 0 ? (
        <div className="empty">No challenges yet. Create one to start scoring.</div>
      ) : (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Window</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {competitions.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="small muted">
                    {fmtDate(c.startAt)} → {fmtDate(c.endAt)}
                  </td>
                  <td>
                    <span className={`badge ${c.isActive && c.endAt >= now ? "ok" : "muted"}`}>
                      {c.isActive && c.endAt >= now ? "Running" : "Finished"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <NewChallenge
        defaults={defaults}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={refresh}
      />
    </>
  );
}
