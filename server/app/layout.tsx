// Root layout: the sidebar shell that stays mounted across soft navigations. Plain <a> links let
// TanStack Router swap only the page leaf, so the React Query cache survives navigation.
//
// The information architecture is the manifest's three questions: "How is everyone doing?"
// (Leaderboard), "How am I doing?" (My results), "How does this work?" (How scoring works) —
// plus Admin for the people running the challenge and System for the product operator.
import { Component, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { useGetChallenges, useGetMe, useLogout, useStopImpersonation } from "@linkedin-challenge/client/react-query";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";

function NavLink({ href, pathname }: { href: string; pathname: string }) {
  // Prefix-match nested challenge routes; exact-match the landing page and owner overview so
  // Leaderboard and Overview don't stay lit for every child underneath them.
  const active =
    href === "/" || href === "/challenges/mine" ? pathname === href : pathname.startsWith(href);
  return (
    <a className={active ? "nav-link active" : "nav-link"} href={href}>
      {label(href)}
    </a>
  );
}

function SideLink({ href, pathname, children, nested = false }: { href: string; pathname: string; children: ReactNode; nested?: boolean }) {
  const active = pathname === href;
  return <a className={`nav-link${nested ? " nested" : ""}${active ? " active" : ""}`} href={href}>{children}</a>;
}

const LABELS: Record<string, string> = {
  "/": "Leaderboard",
  "/me": "My results",
  "/challenges": "Challenges",
  "/rules": "How scoring works",
  "/challenges/mine": "My challenge overview",
  "/challenges/new": "Create a challenge",
  "/system": "All users",
  "/reports": "Post reports",
};
const label = (href: string) => LABELS[href] ?? href;

// The active tab must track the URL across soft navigations, and only the app shell's TanStack
// Router knows about those — window.location would paint once at mount and never move. But
// not-found.tsx boots OUTSIDE the router (its URL is never in the shell's route tree), where
// useLocation throws. So the live reader sits in its own component and this boundary catches the
// no-router case, falling back to the boot-time pathname — always accurate there, since a
// not-found document is only ever a hard load.
function RouterPathname({ children }: { children: (pathname: string) => ReactNode }) {
  return children(useLocation({ select: (l) => l.pathname }));
}

class PathnameProvider extends Component<
  { children: (pathname: string) => ReactNode },
  { outsideRouter: boolean }
> {
  state = { outsideRouter: false };
  static getDerivedStateFromError() {
    return { outsideRouter: true };
  }
  render() {
    if (this.state.outsideRouter) {
      return this.props.children(window.location.pathname);
    }
    return <RouterPathname>{this.props.children}</RouterPathname>;
  }
}

function Sidebar() {
  // Unseeded on purpose: session state is per-viewer, so seeding it into the streamed HTML would
  // make the page uncacheable for no gain.
  const { data } = useGetMe();
  const { data: challengeData } = useGetChallenges({ query: { enabled: Boolean(data?.status === 200 && data.data.signedIn) } });
  const me = data?.status === 200 ? data.data : undefined;
  const logout = useLogout();
  const stopImpersonation = useStopImpersonation();
  const challenges = challengeData?.status === 200 ? challengeData.data.challenges : [];
  const organiser = challenges.some((challenge) => challenge.isOwner);

  if (!me?.signedIn) return null;

  return (
    <aside className="sidebar">
      <a href="/me" className="brand">
        <span className="mark"><img src="/favicon.svg" alt="" /></span>
        <span className="brand-name">Challenge Sync</span>
      </a>

      <nav className="side-nav">
        <PathnameProvider>
          {(pathname) => (
            <>
              <SideLink href="/me" pathname={pathname}>My posts</SideLink>
              <div className="nav-section">Challenges</div>
              <SideLink href="/challenges" pathname={pathname}>All challenges</SideLink>
              {/* Organiser tools stay out of participants' way: only someone who already runs a
                  challenge, or the product operator, gets the overview and the create link. */}
              {(organiser || me.isSystemAdmin) && (
                <>
                  <SideLink href="/challenges/mine" pathname={pathname}>My challenges</SideLink>
                  <SideLink href="/challenges/new" pathname={pathname}>Create a challenge</SideLink>
                </>
              )}
              {challenges.some((challenge) => challenge.isFavorite) && (
                <div className="nav-subsection">Favorites</div>
              )}
              {challenges.filter((challenge) => challenge.isFavorite).map((challenge) => {
                const base = `/challenges/${challenge.id}`;
                const open = pathname === base || pathname.startsWith(`${base}/`);
                return (
                  <div className="challenge-nav" key={challenge.id}>
                    <SideLink href={base} pathname={pathname}>{challenge.name}</SideLink>
                    {open && (
                      <>
                        <SideLink href={base} pathname={pathname} nested>Leaderboard</SideLink>
                        <SideLink href={`${base}/scoring`} pathname={pathname} nested>Scoring</SideLink>
                        {challenge.isOwner && (
                          <>
                            <SideLink href={`${base}/invites`} pathname={pathname} nested>Invites</SideLink>
                            <SideLink href={`${base}/settings`} pathname={pathname} nested>Settings</SideLink>
                          </>
                        )}
                      </>
                    )}
                  </div>
                );
              })}

              {me.isSystemAdmin && (
                <>
                  <div className="nav-section">System</div>
                  <NavLink href="/system" pathname={pathname} />
                  <NavLink href="/reports" pathname={pathname} />
                </>
              )}
            </>
          )}
        </PathnameProvider>
      </nav>

      <div className="side-foot">
        {me.impersonatedBy && (
          <div className="impersonation">
            <span>
              Viewing as <strong>{me.displayName}</strong>
            </span>
            <button
              className="btn sm"
              type="button"
              onClick={() =>
                stopImpersonation.mutate(undefined, {
                  // Full document load: the cookie changed, so every cached query is answering
                  // as the wrong user.
                  onSuccess: () => {
                    window.location.href = "/system";
                  },
                })
              }
            >
              Stop
            </button>
          </div>
        )}
        <div className="side-user">
          <a href="/account" className="side-account">{me.displayName}</a>
          <button
            className="btn ghost sm"
            type="button"
            onClick={() =>
              logout.mutate(undefined, {
                onSuccess: () => {
                  window.location.href = "/auth/login";
                },
              })
            }
          >
            Log out
          </button>
        </div>
      </div>
    </aside>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <title>Challenge Sync</title>
      {/* No manual stylesheet link: the bundler injects a content-hashed copy of public/style.css,
          and an unhashed /style.css link loaded after it would let a browser's cached copy override
          every CSS change until the cache expired. */}
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <link rel="icon" href="/favicon.ico" sizes="32x32" />
      <NuqsAdapter>
        <div className="shell">
          <Sidebar />
          <main>{children}</main>
        </div>
      </NuqsAdapter>
    </>
  );
}
