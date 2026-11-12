import { useParams as useRouterParams } from "@tanstack/react-router";

// Matched route params for deeply nested components. The app shell's router
// keeps these values live across soft navigation.
export function useParams<
  T extends Record<string, string> = Record<string, string>,
>(): T {
  return useRouterParams({ strict: false }) as T;
}

// Generated TanStack Query hooks/options, plus nextrs URL-bound companions.
export * from "./generated/react-query";

// Orval indents mutation declarations, which nextrs' generated-barrel scanner does not currently
// recognize as top-level exports. Keep the challenge mutation available from this public entry
// point without editing generated output.
export { useCreateChallenge } from "./generated/react-query/challenges/challenges";
export { useCreateInvites } from "./generated/react-query/invites/invites";
export { useDeleteMember } from "./generated/react-query/members/members";
export { useSetChallengeFavorite } from "./generated/react-query/favorite/favorite";
export { useUpdateChallenge } from "./generated/react-query/challenges/challenges";
