import { memo } from "react";
import { cn } from "../utils.js";

function SkeletonCard({ className }) {
  return (
    <div className={cn("loom-skeleton loom-skeleton-card", className)}>
      <div className="loom-skeleton loom-skeleton-line loom-skeleton-line-short" style={{ marginBottom: "0.5rem" }} />
      <div className="loom-skeleton loom-skeleton-line loom-skeleton-line-long" />
    </div>
  );
}

function SkeletonRound() {
  return (
    <div className="loom-skeleton-card">
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <div className="loom-skeleton loom-skeleton-line" style={{ width: 48, height: 16 }} />
        <div className="loom-skeleton loom-skeleton-line" style={{ width: 80, height: 16 }} />
      </div>
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}

const LoadingSkeleton = memo(({ rounds = 3 }) => (
  <div className="loom-empty-state">
    <div className="loom-skeleton" style={{ width: 48, height: 48, borderRadius: "50%", marginBottom: "1rem" }} />
    <div className="loom-skeleton loom-skeleton-line loom-skeleton-line-short" style={{ width: 200, marginBottom: "0.5rem" }} />
    <div className="loom-skeleton loom-skeleton-line" style={{ width: 140 }} />
    <div style={{ marginTop: "1.5rem", width: "100%", maxWidth: 500 }}>
      {Array.from({ length: rounds }, (_, i) => (
        <SkeletonRound key={i} />
      ))}
    </div>
  </div>
));

export { LoadingSkeleton };
