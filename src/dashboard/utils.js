/** @typedef {string | number | boolean | null | undefined | ClassValue[] | Record<string, boolean>} ClassValue */

/** @param {ClassValue} value */
function normalize(value) {
  if (!value) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(normalize).filter(Boolean).join(" ");
  return Object.entries(value)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(" ");
}

/** @param {...ClassValue} inputs */
export function cn(...inputs) {
  return inputs.map(normalize).filter(Boolean).join(" ");
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
  interjection: "loom-badge-interjection",
};

const STATUS_COLORS = {
  weaving: "loom-badge-weaving",
  converged: "loom-badge-converged",
  deadlocked: "loom-badge-deadlocked",
  max_rounds_reached: "loom-badge-max_rounds_reached",
  initializing: "loom-badge-initializing",
  aborted: "loom-badge-aborted",
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
  const now = Date.now();
  const diff = now - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
