// Rendered for any URL that matches no route, with a real 404 status.
//
// nextrs picks the deepest not-found.tsx whose path applies, so adding one under a segment (say
// app/orgs/not-found.tsx) overrides this for that subtree. This root one is the backstop.
export default function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p className="lede">
        That page doesn&rsquo;t exist. It may have moved, or the link may be wrong.
      </p>
      <p>
        <a className="btn" href="/">
          Back to the overview
        </a>
      </p>
    </>
  );
}
