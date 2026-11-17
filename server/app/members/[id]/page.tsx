// A teammate's results — reached from a leaderboard row. Same component as "My results": the
// manifest wants the admin's and the participant's view to be the same information. An admin also
// gets the weekly lottery exclusion here (PUT /api/admin/lottery/exclusions/{id}).
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { MemberDetail } from "@linkedin-challenge/client";
import { getGetAdminLotteryQueryKey, useSetLotteryExclusion } from "@linkedin-challenge/client/react-query";
import { MemberResults } from "../../../components/member-results";
import { errorText } from "../../../components/host-block";

/** "Excluded from the weekly lottery", for those the lottery is open to (`canSetLotteryExcluded`). */
function LotteryExclusion({ detail }: { detail: MemberDetail }) {
  const queryClient = useQueryClient();
  const setExclusion = useSetLotteryExclusion();
  const [error, setError] = useState<string | null>(null);
  if (!detail.canSetLotteryExcluded) return null;

  const fallback = "Changing the lottery exclusion failed. Try again.";
  const change = (excluded: boolean) => {
    setError(null);
    setExclusion.mutate(
      { id: detail.memberId, data: { excluded } },
      {
        onSuccess: (res) => {
          if (res.status !== 200) {
            setError(`Changing the lottery exclusion failed: ${res.data.error}`);
            return;
          }
          // This page (every challenge and page of it) and every week of the lottery.
          void queryClient.invalidateQueries({ queryKey: [`/api/members/${detail.memberId}`] });
          void queryClient.invalidateQueries({ queryKey: getGetAdminLotteryQueryKey() });
        },
        onError: (err) => setError(errorText(err, `${fallback} (${err instanceof Error ? err.message : String(err)})`)),
      },
    );
  };

  return (
    <div>
      <label className="media-toggle" title="Organisers can post without being drawn as the winner">
        <input
          type="checkbox"
          checked={detail.lotteryExcluded}
          disabled={setExclusion.isPending}
          onChange={(event) => change(event.target.checked)}
        />
        <span>Excluded from the weekly lottery</span>
      </label>
      {error && <div className="notice err">{error}</div>}
    </div>
  );
}

export default function MemberPage({ params }: { params: { id: string } }) {
  // The board links carry ?challengeId= so the detail describes the same window as the row.
  const challengeId =
    typeof window !== "undefined"
      ? Number(new URLSearchParams(window.location.search).get("challengeId")) || undefined
      : undefined;

  return (
    <MemberResults
      memberId={Number(params.id)}
      challengeId={challengeId}
      backHref={challengeId ? `/challenges/${challengeId}` : "/"}
      backLabel="Leaderboard"
      controls={(detail) => <LotteryExclusion detail={detail} />}
    />
  );
}
