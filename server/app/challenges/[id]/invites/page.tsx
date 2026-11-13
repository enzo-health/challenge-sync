import { useCreateInvites, useGetChallengeInvites, useGetLeaderboard } from "@linkedin-challenge/client/react-query";
import { useState, type ChangeEvent } from "react";
import { errorText } from "../../../../components/host-block";

function splitEmails(value: string) {
  return [...new Set(value.split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

function csvEmails(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index <= csv.length; index += 1) {
    const char = csv[index] ?? "\n";
    if (char === '"' && quoted && csv[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  const header = rows.shift()?.map((value) => value.toLowerCase().replace(/^\uFEFF/, "")) ?? [];
  const emailColumn = header.indexOf("email");
  if (emailColumn < 0) throw new Error('The CSV needs a column named "email".');
  return splitEmails(rows.map((values) => values[emailColumn] ?? "").join(" "));
}

export default function ChallengeInvitesPage({ params }: { params: { id: string } }) {
  const challengeId = Number(params.id);
  const [recipients, setRecipients] = useState("");
  const [role, setRole] = useState<"participant" | "owner">("participant");
  const [error, setError] = useState<string | null>(null);
  const challenge = useGetLeaderboard({ challengeId });
  const { data, isLoading, refetch } = useGetChallengeInvites(challengeId);
  const create = useCreateInvites();
  const info = challenge.data?.status === 200 ? challenge.data.data.competition : undefined;
  const emails = splitEmails(recipients);

  async function loadCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    try {
      const imported = csvEmails(await file.text());
      if (imported.length === 0) throw new Error("The CSV has no email addresses.");
      setRecipients((current) => [...new Set([...splitEmails(current), ...imported])].join("\n"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read that CSV.");
    }
  }

  if (isLoading || challenge.isLoading) return <div className="spinner">Loading invites…</div>;
  if (!info?.isOwner || data?.status !== 200) return <div className="empty">Challenge not found.</div>;

  return (
    <>
      <h1>Invites</h1>
      <p className="lede">Invite people to <strong>{info.name}</strong>. Each invitation is tied to its recipient&rsquo;s email address.</p>
      {error && <div className="notice err">{error}</div>}
      <div className="panel">
        <form onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          if (emails.length === 0) {
            setError("Enter at least one email address.");
            return;
          }
          create.mutate({ id: challengeId, data: { emails, role } }, {
            onSuccess: (response) => {
              if (response.status !== 200) {
                setError(response.data?.error ?? "Could not create invitations.");
                return;
              }
              setRecipients("");
              void refetch();
            },
            onError: (error) => setError(errorText(error, "Could not create invitations.")),
          });
        }}>
          <label className="field">
            <span>Email addresses</span>
            <textarea rows={7} value={recipients} onChange={(event) => setRecipients(event.target.value)} placeholder={"alex@example.com, sam@example.com\ntaylor@example.com"} />
            <span className="small muted">Separate addresses with commas, spaces, semicolons, or new lines.</span>
          </label>
          <label className="field">
            <span>Role</span>
            <select value={role} onChange={(event) => setRole(event.target.value as "participant" | "owner")}>
              <option value="participant">Participant</option>
              <option value="owner">Owner — can manage this challenge and invite others</option>
            </select>
          </label>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button type="submit" disabled={create.isPending || emails.length === 0}>
              {create.isPending ? "Creating invitations…" : `Invite ${emails.length || "people"}`}
            </button>
            <label className="btn ghost" style={{ cursor: "pointer" }}>
              Upload CSV
              <input type="file" accept=".csv,text/csv" onChange={loadCsv} hidden />
            </label>
            <span className="small muted">CSV files must include an email column.</span>
          </div>
        </form>
      </div>
      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        {data.data.invites.length === 0 ? <div className="empty">No invitations yet.</div> : (
          <table><thead><tr><th>Email</th><th>Role</th><th>Code</th><th>Status</th></tr></thead><tbody>
            {data.data.invites.map((invite) => <tr key={invite.code}>
              <td>{invite.email ?? <span className="muted">Legacy open invite</span>}</td>
              <td><span className="badge">{invite.role === "owner" || invite.role === "admin" ? "Owner" : "Participant"}</span></td>
              <td><span className="code">{invite.code}</span></td>
              <td><span className={`badge ${invite.redeemed ? "muted" : "ok"}`}>{invite.redeemed ? "Joined" : "Ready to share"}</span></td>
            </tr>)}
          </tbody></table>
        )}
      </div>
    </>
  );
}
