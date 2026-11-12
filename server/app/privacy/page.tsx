export default function PrivacyPage() {
  return (
    <article style={{ maxWidth: 760 }}>
      <h1>Privacy policy</h1>
      <p className="lede">Last updated August 22, 2026</p>

      <h2>What Challenge Sync does</h2>
      <p>
        Challenge Sync helps you privately collect analytics for your own LinkedIn posts and use
        them in challenges you choose to join. The Chrome extension works only while you are
        signed in to both Challenge Sync and LinkedIn.
      </p>

      <h2>Data we collect</h2>
      <p>When you create an account or use the extension, we may store:</p>
      <ul>
        <li>your Challenge Sync name, email address, and authentication records;</li>
        <li>your LinkedIn public profile identifier and profile URL;</li>
        <li>your own LinkedIn posts, post text previews, URLs, and timestamps;</li>
        <li>analytics LinkedIn shows you for your own posts, such as impressions, reactions, comments, reposts, saves, sends, reach, profile views, and followers gained; and</li>
        <li>profile-level follower and profile-view snapshots used for challenge scoring.</li>
      </ul>

      <h2>Cookies and credentials</h2>
      <p>
        The extension reads the Challenge Sync session cookie only to connect the browser to the
        account you already signed into. It reads LinkedIn&rsquo;s session state only to request your
        own data from LinkedIn inside your browser. Your LinkedIn cookies, password, and other
        credentials are never sent to or stored by Challenge Sync. The extension stores a
        revocable Challenge Sync token locally after connection.
      </p>

      <h2>How data is used and shared</h2>
      <p>
        We use the collected data to show your post history and analytics, synchronize later
        readings, and calculate challenge results. Your synced posts belong to your account.
        Joining a challenge grants that challenge read access to the posts and analytics relevant
        to its scoring period. An invitation does not grant access until you explicitly accept it.
      </p>
      <p>
        We do not sell personal data, use it for advertising, or share it with unrelated third
        parties. Infrastructure providers may process data only to operate the application and
        database.
      </p>

      <h2>Control and retention</h2>
      <p>
        You choose whether to connect the extension and whether to accept each challenge. You can
        remove the extension at any time to stop future collection. Stored account and analytics
        data is retained while needed to provide the service and preserve challenge history.
      </p>

      <h2>Contact and deletion requests</h2>
      <p>
        To ask a privacy question or request deletion, contact the publisher through the project&rsquo;s{" "}
        <a href="https://github.com/enzo-health/challenge-sync/issues">support tracker</a>.
        Do not include passwords, session cookies, or other secrets in a public issue.
      </p>
    </article>
  );
}
