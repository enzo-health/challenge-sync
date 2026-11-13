// Vercel Speed Insights (real-user Core Web Vitals), mounted once in the root layout.
//
// The React component injects /_vercel/speed-insights/script.js, which Vercel serves on the
// deployment only while Speed Insights is enabled for the project; the script then beacons to
// /_vercel/speed-insights/vitals and follows client-side navigations itself (history API), so
// TanStack Router soft navigations are reported per page.
//
// Production builds only. A debug build (cargo dev, every e2e in scripts/check.sh) defines
// NODE_ENV as "development", where the SDK would pull a debug script from Vercel's CDN and log
// every metric to the console; there is nothing to measure locally, so it renders nothing.
//
// `route` groups dynamic URLs (/challenges/12/scoring and /challenges/40/scoring both count as
// /challenges/[id]/scoring). It comes from the router's deepest match, whose fullPath uses
// TanStack's `$id`, turned back into the app/ folder spelling. Like the sidebar, the layout also
// renders outside the router on a not-found document, where useMatches throws, so a boundary
// falls back to a fixed "/_not-found" route there (the same label Next.js uses).
import { Component, type ReactNode } from "react";
import { useMatches } from "@tanstack/react-router";
import { SpeedInsights } from "@vercel/speed-insights/react";

// Replaced at bundle time by nextrs's rolldown `define` ("production" in a release build); this
// declaration is only for the type checker, which has no Node types here.
declare const process: { env: { NODE_ENV?: string } };

const NOT_FOUND_ROUTE = "/_not-found";

// Invite codes are the only secret that rides in a path (/join/[code]), and query strings carry
// nothing worth measuring, so strip both before a beacon leaves the page.
// The SDK's React entry doesn't export its prop types, so name them off the component.
const beforeSend: NonNullable<Parameters<typeof SpeedInsights>[0]["beforeSend"]> = (event) => {
  try {
    const url = new URL(event.url);
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/^\/join\/[^/]+/, "/join/[code]");
    return { ...event, url: url.href };
  } catch {
    return event;
  }
};

/** `/challenges/$id/scoring` -> `/challenges/[id]/scoring`; a bare `$` splat -> `[...splat]`. */
function routeFromFullPath(fullPath: string): string {
  const route = fullPath
    .split("/")
    .map((seg) => (seg === "$" ? "[...splat]" : seg.startsWith("$") ? `[${seg.slice(1)}]` : seg))
    .join("/");
  // TanStack keeps a trailing slash on some full paths; the URL never has one except at the root.
  return route.length > 1 && route.endsWith("/") ? route.slice(0, -1) : route || "/";
}

function RouterSpeedInsights() {
  const route = useMatches({ select: (matches) => routeFromFullPath(matches[matches.length - 1]?.fullPath ?? "/") });
  return <SpeedInsights route={route} beforeSend={beforeSend} />;
}

class RouteBoundary extends Component<{ children: ReactNode }, { outsideRouter: boolean }> {
  state = { outsideRouter: false };
  static getDerivedStateFromError() {
    return { outsideRouter: true };
  }
  render() {
    if (this.state.outsideRouter) return <SpeedInsights route={NOT_FOUND_ROUTE} beforeSend={beforeSend} />;
    return this.props.children;
  }
}

export function AppSpeedInsights() {
  if (process.env.NODE_ENV !== "production") return null;
  return (
    <RouteBoundary>
      <RouterSpeedInsights />
    </RouteBoundary>
  );
}
