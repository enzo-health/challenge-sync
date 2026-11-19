// What a phone sees instead of the app (the shell decides, with components/mobile.ts). Nothing
// else is mounted behind it, so the hidden page fetches nothing.
export function MobileNotice() {
  return (
    <div className="mobile-notice">
      <div className="auth-card">
        <div className="auth-brand" aria-hidden="true">
          <img src="/favicon.svg" alt="" />
        </div>
        <p className="auth-eyebrow">Challenge Sync</p>
        <h1>Sorry, this isn&rsquo;t available on mobile</h1>
        <p className="auth-intro">You need to use a desktop for this.</p>
      </div>
    </div>
  );
}
