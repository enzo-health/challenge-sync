// Participant sign-up: redeem an invite code into a real account. Everyone signs in to see
// anything, so this is where a participant gets the credentials they use on the web AND in the extension.
import { EXTENSION_STORE_URL } from "../../../components/links";
import { useJoinWithInvite } from "@linkedin-challenge/client/react-query";
import { useState } from "react";

export default function Join() {
  const [inviteCode, setInviteCode] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<{ challengeName: string } | null>(null);
  const join = useJoinWithInvite();

  // No token to copy any more: the extension signs in with these same credentials.
  if (joined) {
    return (
      <>
        <h1>You joined {joined.challengeName}</h1>
        <div className="notice ok">
          Your account is ready. To start syncing, install the Challenge Sync extension. You&rsquo;re
          already signed in here, so once LinkedIn is open in this browser it connects on its own.
        </div>
        <p>
          <a className="btn" href={EXTENSION_STORE_URL} target="_blank" rel="noreferrer">
            Install the extension
          </a>{" "}
          <a className="btn" href="/">
            Go to the overview
          </a>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Join a challenge</h1>
      <p className="lede">
        Redeem an invitation to let this challenge read and score your synced posts. If you
        already have an account, use your existing email and password.
      </p>
      {error && <div className="notice err">{error}</div>}

      <div className="panel" style={{ maxWidth: 460 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            join.mutate(
              { data: { inviteCode, name, email, password } },
              {
                onSuccess: (res) => {
                  if (res.status === 200) {
                    setJoined({ challengeName: res.data.orgName });
                  } else {
                    setError(res.data?.error ?? "Something went wrong. Please try again.");
                  }
                },
                onError: () => setError("Something went wrong. Please try again."),
              },
            );
          }}
        >
          <div className="field">
            <span>Invite code</span>
            <input
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="AB12-CD34"
              required
            />
          </div>
          <div className="field">
            <span>Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </div>
          <button type="submit" disabled={join.isPending}>
            {join.isPending ? "Joining…" : "Join"}
          </button>
        </form>
      </div>

      <p className="small muted">
        Already have an account? <a href="/auth/login">Log in</a>.
      </p>
    </>
  );
}
