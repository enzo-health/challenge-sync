// The company join link: `/join/<code>`. One reusable link for everyone, pasted wherever the
// company talks. It remembers the code in a cookie the extension can read, then shows the same
// get-started steps as the sign-in page. The server checks the code when the extension presents
// it; a wrong code simply never signs anyone in.
import { useEffect } from "react";
import { GetStarted } from "../../../components/get-started";

const THIRTY_DAYS = 30 * 24 * 60 * 60;

export default function JoinLink({ params }: { params: { code: string } }) {
  useEffect(() => {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `join_code=${encodeURIComponent(params.code)}; Path=/; Max-Age=${THIRTY_DAYS}; SameSite=Lax${secure}`;
  }, [params.code]);

  return <GetStarted invited />;
}
