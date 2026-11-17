# Chrome Web Store submission — Challenge Sync

## Release file

Build with:

```sh
just extension-release https://social-challenge.enzo.health
```

Upload `extension/dist/challenge-sync-0.1.1.zip`.

Production homepage: <https://social-challenge.enzo.health>

Privacy policy: <https://social-challenge.enzo.health/privacy>

## Listing copy

### Name

Challenge Sync

### Summary

Privately sync analytics for your own LinkedIn posts to challenges you choose to join.

### Detailed description

Challenge Sync lets you bring analytics for your own LinkedIn posts into the Challenge app.

Connect the extension after signing in to both Challenge and LinkedIn. It periodically reads the posts and author-only analytics LinkedIn already shows you, then securely syncs those results to your Challenge account. You can review your posts, understand what is working, and participate in challenges you explicitly accept.

The extension:

- reads only your own LinkedIn posts and analytics;
- never sees or transmits your LinkedIn password;
- never sends your LinkedIn session cookies to the Challenge server;
- never posts, likes, comments, follows, or messages on your behalf;
- syncs automatically only twice a day, with an optional manual sync; and
- shares challenge-period data only with challenges you choose to join.

LinkedIn is a trademark of LinkedIn Corporation. Challenge Sync is not endorsed by or affiliated with LinkedIn.

### Category

Productivity

### Language

English (United States)

## Single purpose

Synchronize a signed-in user's own LinkedIn post analytics to their Challenge account so they can review their results and participate in challenges they explicitly accept.

## Permission justifications

### `storage`

Stores the revocable Challenge sync token, last successful sync time, next scheduled sync time, post count, and diagnostic status locally in the browser.

### `alarms`

Schedules a low-frequency background sync twice per day. Manual sync remains user initiated.

### `cookies`

Reads the Challenge website's session cookie once to connect the extension to the account already signed in, and reads LinkedIn's `JSESSIONID` locally to make authenticated requests for the user's own data. LinkedIn cookies never leave the browser.

### `https://www.linkedin.com/*`

Required to request the signed-in user's own profile, posts, and author analytics from LinkedIn and to confirm that the user is signed in.

### `https://social-challenge.enzo.health/*`

Required to exchange the existing Challenge session for a revocable extension token and upload the user's synchronized post analytics to their Challenge account.

## Data-use disclosures

Data handled by the extension includes authentication information for the Challenge account, website content from the user's own LinkedIn posts, and personal communications only when they appear in the user's own post content or analytics. The extension does not collect browsing history outside the two declared origins, financial information, health information, precise location, or LinkedIn credentials.

Data is used only for the extension's stated synchronization purpose. It is not sold, used for advertising, or transferred for unrelated purposes. See the published privacy policy for retention and challenge-sharing details.

## Submission checklist

- Upload the verified zip.
- Upload at least one 1280×800 or 640×400 screenshot of the extension popup.
- Supply the 128×128 icon from `icons/icon.png` if the dashboard requests it separately.
- Set the homepage and privacy policy URLs above.
- Paste the single-purpose and permission justifications above into Privacy practices.
- Complete the publisher contact verification and any developer-account enrollment required by Google.
- Save as draft, review the final permissions and listing, then submit for review.
