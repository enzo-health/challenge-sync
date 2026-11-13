import { ChallengeLeaderboard } from "../../../components/challenge-leaderboard";

export default function ChallengeLeaderboardPage({ params }: { params: { id: string } }) {
  return <ChallengeLeaderboard fixedChallengeId={Number(params.id)} />;
}
