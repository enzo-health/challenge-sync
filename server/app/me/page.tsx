// "How am I doing?" — the viewer's own results, first-class in the nav rather than something you
// find by locating yourself on the board.
import { useGetMe } from "@linkedin-challenge/client/react-query";
import { PersonalPosts } from "../../components/member-results";

export default function MyResults() {
  const { data, isLoading } = useGetMe();
  const me = data?.status === 200 ? data.data : undefined;

  if (isLoading) return <div className="spinner">Loading…</div>;
  if (!me?.signedIn || me.memberId == null) {
    return (
      <div className="empty">
        Your session expired. <a href="/auth/login">Log in again</a>.
      </div>
    );
  }

  return (
    <PersonalPosts
      displayName={me.displayName ?? "Your results"}
      action={
        <a className="me-avatar-link" href="/me/avatar">
          Edit my avatar
        </a>
      }
    />
  );
}
