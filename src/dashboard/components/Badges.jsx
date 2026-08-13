import { memo } from "react";
import { cn, tierClass, typeClass, statusClass } from "../utils.js";

export const StatusBadge = memo(({ status }) => (
  <span className={cn("loom-badge", statusClass(status))}>
    {status}
  </span>
));

export const TierBadge = memo(({ tier }) => (
  <span className={cn("loom-badge", tierClass(tier))}>
    {tier}
  </span>
));

export const TypeBadge = memo(({ type }) => (
  <span className={cn("loom-badge", typeClass(type))}>
    {type}
  </span>
));
