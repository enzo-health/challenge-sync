// Pages the root layout (app/layout.tsx) renders without the app shell: no sidebar, no banners,
// just the page. For screens shown to an audience: the lottery's presenter view, and the public
// official draw (/lottery). Access is
// unchanged: each page's middleware and API still decide who may see it.
const BARE_PAGES = new Set(["/admin/lottery/present", "/lottery"]);

export function isBarePage(pathname: string): boolean {
  return BARE_PAGES.has(pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname);
}
