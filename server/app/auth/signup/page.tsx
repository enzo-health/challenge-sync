import { useSignup } from "@linkedin-challenge/client/react-query";
import { useState } from "react";

export default function Signup() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signup = useSignup();

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand" aria-hidden="true"><img src="/favicon.svg" alt="" /></div>
        <p className="auth-eyebrow">Challenge Sync</p>
        <h1>Create your account</h1>
        <p className="auth-intro">Create a Challenge Sync account to start syncing your post results. You can set up challenges later.</p>

        {error && <div className="notice err" role="alert">{error}</div>}

        <form onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          signup.mutate({ data: {
            name, email, password,
          } }, {
            onSuccess: (res) => {
              if (res.status === 200) window.location.href = "/";
              else setError(res.data?.error ?? "Something went wrong. Please try again.");
            },
            onError: () => setError("Something went wrong. Please try again."),
          });
        }}>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" autoComplete="name" autoFocus value={name}
              onChange={(e) => setName(e.target.value)} maxLength={100} required />
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" value={email}
              onChange={(e) => setEmail(e.target.value)} maxLength={254} required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <div className="password-input">
              <input id="password" type={showPassword ? "text" : "password"}
                autoComplete="new-password" value={password}
                onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={128} required />
              <button className="password-toggle" type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword} onClick={() => setShowPassword((shown) => !shown)}>
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            <p className="field-help">At least 8 characters</p>
          </div>
          <button className="auth-submit" type="submit" disabled={signup.isPending}>
            {signup.isPending ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="auth-switch">Already have an account? <a href="/auth/login">Sign in</a></p>
      </div>
    </div>
  );
}
