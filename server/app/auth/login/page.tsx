import { useLogin } from "@linkedin-challenge/client/react-query";
import { useState } from "react";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = useLogin();

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand" aria-hidden="true">
          <img src="/favicon.svg" alt="" />
        </div>
        <p className="auth-eyebrow">Challenge Sync</p>
        <h1>Welcome back</h1>
        <p className="auth-intro">Sign in with your Challenge Sync account to see how your posts are doing.</p>

        {error && (
          <div className="notice err" role="alert">
            {error}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            login.mutate(
              { data: { email, password } },
              {
                onSuccess: (res) => {
                  if (res.status === 200) {
                    // Hard load: the session cookie is new, so every cached query is stale.
                    // Everyone lands on their org's leaderboard; admins get the dashboard link
                    // in the nav rather than a different destination.
                    window.location.href = "/";
                  } else {
                    setError("Invalid email or password.");
                  }
                },
                onError: () => setError("Invalid email or password."),
              },
            );
          }}
        >
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <div className="password-input">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                maxLength={128}
                required
              />
              <button
                className="password-toggle"
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((shown) => !shown)}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <button className="auth-submit" type="submit" disabled={login.isPending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="auth-switch">
          Don&rsquo;t have an account? <a href="/auth/signup">Create one</a>
        </p>
      </div>
    </div>
  );
}
