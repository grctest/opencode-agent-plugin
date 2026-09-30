import { memo } from "react";
import { Badge } from "./ui/badge.tsx";

// Includes civilian and nonhuman, which the badge component styles as
// "secondary" (no named variant) — a non-human seat still has to be labelled,
// not rendered as a blank.
const validTier = new Set(["junior", "mid", "senior", "principal", "civilian", "nonhuman"]);
const validType = new Set(["propose", "challenge", "refine", "support", "dissent", "synthesize", "question", "turn_request", "reflection", "query_response", "evidence_response", "summoned_response", "vote_response"]);
const validStatus = new Set(["weaving", "converged", "max_rounds_reached", "initializing", "aborted", "failed", "cancelled", "timeout"]);

export const StatusBadge = memo(({ status }) => {
  const v = validStatus.has(status) ? (status === "failed" || status === "cancelled" ? "aborted" : status) : "secondary";
  return <Badge variant={v}>{status}</Badge>;
});

export const TierBadge = memo(({ tier }) => {
  const v = validTier.has(tier) ? tier : "secondary";
  return <Badge variant={v}>{tier}</Badge>;
});

export const TypeBadge = memo(({ type }) => {
  const v = validType.has(type) ? type : "secondary";
  return <Badge variant={v}>{type}</Badge>;
});
