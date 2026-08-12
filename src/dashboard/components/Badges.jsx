import { cn, tierClass, typeClass, statusClass } from "../utils.js";

export function StatusBadge({ status }) {
  return (
    <span className={cn("loom-badge", statusClass(status))}>
      {status}
    </span>
  );
}

export function TierBadge({ tier }) {
  return (
    <span className={cn("loom-badge", tierClass(tier))}>
      {tier}
    </span>
  );
}

export function TypeBadge({ type }) {
  return (
    <span className={cn("loom-badge", typeClass(type))}>
      {type}
    </span>
  );
}
