// "Connect your AI assistant": the signed-in member's own read-only API keys for the reporting API
// (/api/v1/*), and a copyable setup for an agent. Keys are made, listed and revoked through
// /api/me/api-keys, which only ever acts on the member the session belongs to; admins see and
// revoke everyone's on the Reports page.
import {
  getListMyApiKeysQueryKey,
  useCreateMyApiKey,
  useGetMe,
  useListMyApiKeys,
  useRevokeMyApiKey,
} from "@linkedin-challenge/client/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { fmtLocalDate } from "../../../components/format";
import { ConfirmModal } from "../../../components/confirm-modal";
import { errorText } from "../../../components/host-block";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      className="btn ghost sm"
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed: select and copy it" : label}
    </button>
  );
}

const pre = { display: "block", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: "8px 0 0" } as const;

function starterPrompts(docsUrl: string, memberId: number) {
  const setup =
    `Read the API documentation at ${docsUrl} first. ` +
    `Authenticate every request with my API key as "Authorization: Bearer <key>" ` +
    `(I'll give you the key separately; never print it). ` +
    `The API is read-only. My memberId is ${memberId}.`;
  return [
    {
      title: "Learn my voice, then draft",
      text:
        `${setup}\n\n` +
        `Fetch my original posts from the past 180 days (memberId=${memberId}, sort=impressions). ` +
        `Study my best-performing ones: topics, how they open, length, structure and tone. ` +
        `Then draft three LinkedIn posts in my voice about: <your topic>. ` +
        `For each draft, say which of my past posts it learns from.`,
    },
    {
      title: "What do the top posts have in common?",
      text:
        `${setup}\n\n` +
        `Fetch everyone's original posts from the past 30 days, once with sort=impressions&limit=25 ` +
        `and once with sort=engagementRate&minImpressions=500&limit=25. ` +
        `What do the top posts have in common (topic, opening line, length, format, day and time ` +
        `posted)? Give me five concrete, specific ideas I could use in my next post.`,
    },
    {
      title: "How did my week go?",
      text:
        `${setup}\n\n` +
        `Compare my numbers for the past 7 days with the 7 before (GET /api/v1/stats with ` +
        `memberId=${memberId}), list my posts from this week with their numbers, and tell me which ` +
        `did best and the most likely reasons why.`,
    },
  ];
}

export default function MyApiKeysPage() {
  const me = useGetMe();
  const { data, isLoading } = useListMyApiKeys();
  const create = useCreateMyApiKey();
  const revoke = useRevokeMyApiKey();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ id: number; name: string } | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const account = me.data?.status === 200 ? me.data.data : undefined;
  const list = data?.status === 200 ? data.data : undefined;
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListMyApiKeysQueryKey() });
  const docsUrl = `${window.location.origin}/api/v1/docs`;

  if (me.isLoading || isLoading) return <div className="spinner">Loading…</div>;
  if (!account?.signedIn || account.memberId == null || data?.status === 401) {
    return (
      <div className="empty">
        Your session expired. <a href="/auth/login">Log in again</a>.
      </div>
    );
  }
  if (!list) {
    return <div className="empty">Your API keys could not be loaded. Reload the page to try again.</div>;
  }
  const atLimit = list.keys.length >= list.maxKeys;

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
          setName("");
          refresh();
        },
        onError: (error) => setError(errorText(error, "The key could not be created. Try again.")),
      },
    );
  };

  return (
    <>
      <h1>Connect your AI assistant</h1>
      <p className="lede">
        An API key lets your own AI assistant (Claude, ChatGPT or a script of yours) read the
        challenge&rsquo;s post data. It can then look at what is working for you and for colleagues,
        and help you write posts in your own voice.
      </p>

      <div className="panel">
        <h3>What a key can read</h3>
        <p>
          Everyone&rsquo;s posts in the challenge, with their full text and all their numbers
          (impressions, reactions, comments, reposts, sends, saves), the list of members and when
          each last synced, and the company stats. It is <strong>read-only</strong>: nothing can be
          posted, changed or deleted with it, here or on LinkedIn.
        </p>
        <p style={{ marginBottom: 0 }}>
          <strong>Treat a key like a password.</strong> Anyone holding it can read all of the
          above. Give it only to an assistant you trust, never paste it anywhere public, and revoke
          it here when you stop using it: it stops working at once.
        </p>
      </div>

      <h2>Your keys</h2>
      <div className="panel">
        {created && (
          <div className="notice ok">
            <p style={{ marginTop: 0 }}>
              <strong>{created.name}</strong>: copy this key now. It will not be shown again.
            </p>
            <p style={{ marginBottom: 0 }}>
              <span className="code" style={{ wordBreak: "break-all" }}>{created.key}</span>{" "}
              <CopyButton text={created.key} />
            </p>
          </div>
        )}
        {error && <div className="notice err">{error}</div>}

        {atLimit ? (
          <p className="notice warn">
            You have {list.keys.length} keys, the most one person can hold. Revoke one you no longer
            use to make another.
          </p>
        ) : (
          <form onSubmit={submit} style={{ display: "flex", gap: 8, alignItems: "end", marginBottom: 16 }}>
            <label className="field" style={{ flex: 1, marginBottom: 0 }}>
              <span>Name, so you know which key is which</span>
              <input
                value={name}
                maxLength={100}
                required
                placeholder="e.g. Claude on my laptop"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button type="submit" disabled={create.isPending || !name.trim()}>
              Create key
            </button>
          </form>
        )}

        {list.keys.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>You have no API keys yet.</p>
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
              {list.keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td className="small muted">{fmtLocalDate(key.createdAt)}</td>
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
        <p className="muted small" style={{ marginBottom: 0 }}>
          Up to {list.maxKeys} keys each. Each key can make up to {list.requestsPerMinute} requests a minute.
        </p>
      </div>

      <h2>Set up your assistant</h2>
      <div className="panel">
        <p style={{ marginTop: 0 }}>
          <strong>1. The documentation.</strong> Give your assistant this address. It explains every
          endpoint and parameter, and needs no key to read.
        </p>
        <p>
          <span className="code">{docsUrl}</span> <CopyButton text={docsUrl} />
        </p>
        <p>
          <strong>2. The key.</strong> Hand it over separately from the prompt: as the{" "}
          <span className="code">CHALLENGE_API_KEY</span> environment variable for a coding agent,
          or pasted into a private chat when it asks.
        </p>
        <p style={{ marginBottom: 0 }}>
          <strong>3. A starter prompt.</strong> Pick one, copy it, and change the parts in angle
          brackets.
        </p>
        {starterPrompts(docsUrl, account.memberId).map((prompt) => (
          <div key={prompt.title} style={{ marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <strong>{prompt.title}</strong>
              <CopyButton text={prompt.text} label="Copy prompt" />
            </div>
            <pre className="code" style={pre}>{prompt.text}</pre>
          </div>
        ))}
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
                  setRevokeError(res.data.error);
                  return;
                }
                setRevoking(null);
                refresh();
              },
              onError: (error) => setRevokeError(errorText(error, "The key could not be revoked. Try again.")),
            },
          );
        }}
      >
        <p>Revoke &ldquo;{revoking?.name}&rdquo;? Anything using it stops working at once.</p>
      </ConfirmModal>
    </>
  );
}
