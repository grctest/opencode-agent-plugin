import { memo } from "react";
import { Badge } from "./ui/badge.tsx";

// Includes civilian and nonhuman, which the badge component styles as
// "secondary" (no named variant) — a non-human seat still has to be labelled,
// not rendered as a blank.
const validCategory = (c) => typeof c === "string" && c.length > 0;
const validStatus = new Set(["weaving", "converged", "max_rounds_reached", "initializing", "aborted", "failed", "cancelled", "timeout"]);
const validType = new Set(["propose", "challenge", "refine", "support", "dissent", "synthesize", "question", "reflection", "query_response", "evidence_response", "summoned_response", "vote_response"]);

export const StatusBadge = memo(({ status }) => {
  const v = validStatus.has(status) ? (status === "failed" || status === "cancelled" ? "aborted" : status) : "secondary";
  return <Badge variant={v}>{status}</Badge>;
});

export const CategoryBadge = memo(({ category }) => {
  const v = validCategory(category) ? category : "secondary";
  return <Badge variant={v}>{category}</Badge>;
});

// legacy alias: TierBadge kept for backwards compat, use CategoryBadge instead
export const TierBadge = CategoryBadge;

export const TypeBadge = memo(({ type }) => {
  const v = validType.has(type) ? type : "secondary";
  return <Badge variant={v}>{type}</Badge>;
});
