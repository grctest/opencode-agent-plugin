import { memo } from "react";
import { Skeleton } from "./ui/skeleton.tsx";
import { Card } from "./ui/card.tsx";

function SkeletonCard() {
  return (
    <Card className="py-4">
      <div className="px-4 space-y-2">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-4 w-[85%]" />
      </div>
    </Card>
  );
}

function SkeletonRound() {
  return (
    <div className="space-y-3 py-2">
      <div className="flex gap-2">
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-20" />
      </div>
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}

const LoadingSkeleton = memo(({ rounds = 3 }) => (
  <div className="flex flex-col items-center justify-center py-12 text-center">
    <Skeleton className="size-12 rounded-full mb-4" />
    <Skeleton className="h-4 w-[200px] mb-2" />
    <Skeleton className="h-4 w-[140px]" />
    <div className="mt-6 w-full max-w-[500px] space-y-4">
      {Array.from({ length: rounds }, (_, i) => (
        <SkeletonRound key={i} />
      ))}
    </div>
  </div>
));

export { LoadingSkeleton };
