// The browser's UTC offset, for the requests that are read in the viewer's own days, and the `tz`
// cookie that lets the server seed those requests into a page before its bundle runs.
//
// A page's prefetch.rs can only seed a query whose key it can reproduce, and the Overview's and
// Reports' first queries carry this offset. The server has no other way to know it, so the shell
// writes it on every load (`rememberTimezone`, from layout.tsx) and `src/seeds.rs` reads it back.
// A first-ever visit has no cookie and simply fetches as before; a stale one (the clocks changed
// since) keys an entry the page does not ask for, which is then ignored.

const pad = (n: number) => String(n).padStart(2, "0");

/** The UTC offset at `date` as `-07:00`. */
export function offsetOf(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The browser's UTC offset right now as `-07:00`. */
export const offsetNow = (): string => offsetOf(new Date());

/** Write the `tz` cookie (`TIMEZONE_COOKIE` in src/seeds.rs). Not secret: an offset, nothing else. */
export function rememberTimezone(): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `tz=${offsetNow()}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}
