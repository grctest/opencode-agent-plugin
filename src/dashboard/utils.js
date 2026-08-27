import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** @param {...any} inputs */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

const TIER_COLORS = {
  junior: "loom-badge-junior",
  mid: "loom-badge-mid",
  senior: "loom-badge-senior",
  principal: "loom-badge-principal",
};

const TYPE_COLORS = {
  propose: "loom-badge-propose",
  challenge: "loom-badge-challenge",
  refine: "loom-badge-refine",
  support: "loom-badge-support",
  dissent: "loom-badge-dissent",
  synthesize: "loom-badge-synthesize",
  question: "loom-badge-question",
  turn_request: "loom-badge-turn-request",
  reflection: "loom-badge-reflection",
  query_response: "loom-badge-query_response",
  evidence_response: "loom-badge-evidence_response",
  summoned_response: "loom-badge-summoned_response",
};

const STATUS_COLORS = {
  weaving: "loom-badge-weaving",
  converged: "loom-badge-converged",
  max_rounds_reached: "loom-badge-max_rounds_reached",
  initializing: "loom-badge-initializing",
  aborted: "loom-badge-aborted",
  failed: "loom-badge-aborted",
  cancelled: "loom-badge-aborted",
  timeout: "loom-badge-timeout",
};

/** @param {string} tier */
export function tierClass(tier) {
  return TIER_COLORS[tier] ?? "";
}

/** @param {string} type */
export function typeClass(type) {
  return TYPE_COLORS[type] ?? "";
}

/** @param {string} status */
export function statusClass(status) {
  return STATUS_COLORS[status] ?? "";
}

/** @param {string} iso */
export function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const now = Date.now();
  const diff = now - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
