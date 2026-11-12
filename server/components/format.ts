// Display formatting shared by the page components (ported from the deleted Rust `ui.rs`).
//
// This is application code, so it lives here rather than in the generated client package —
// `.nextrs/client` is a build product that `nextrs client generate` recreates from scratch.


/**
 * Thousands-separated integer.
 *
 * The `n === 0` guard also catches negative zero, which Intl renders as "-0". That is not
 * hypothetical: Rust's `Sum for f64` uses -0.0 as its identity (so signed zeros survive addition),
 * so any empty `.sum()` — an org with no standings yet — serializes as `-0.0`.
 */
export function fmtInt(n: number): string {
  if (n === 0) return "0";
  return Math.round(n).toLocaleString("en-US");
}

/** Score-style number: one decimal place, dropped when the value is whole. */
export function fmtNum(n: number): string {
  if (n === 0) return "0";
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded)
    ? rounded.toLocaleString("en-US")
    : rounded.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/**
 * A scoring *rate* (points per reaction, per impression, ...). Distinct from fmtNum because rates
 * are routinely far below 0.1 — `perImpression` defaults to 0.01, which fmtNum would round to "0"
 * and tell participants impressions are worth nothing.
 */
export function fmtRate(n: number): string {
  if (n === 0) return "0";
  const decimals = Math.abs(n) < 0.01 ? 4 : Math.abs(n) < 1 ? 3 : 2;
  return n
    .toFixed(decimals)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

/** Unix seconds → `Mar 4, 2026`. Dates are stored as unix seconds throughout. */
export function fmtDate(unix: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    // Windows are stored at UTC midnight; local rendering would shift them a day west of GMT.
    timeZone: "UTC",
  });
}

/** Unix seconds → `Mar 4, 2026` in the viewer's own time zone, for moments (when a post went
 * up) rather than the UTC-midnight windows `fmtDate` is for. */
export function fmtLocalDate(unix: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Initials for the avatar placeholder, until profile pictures are stored. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}
