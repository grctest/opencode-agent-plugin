import { useState, useEffect, useCallback, useRef } from "react";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { TriangleAlertIcon, ClockIcon, ExternalLinkIcon } from "lucide-react";

function formatCountdown(ms) {
  if (!ms || ms <= 0) return "";
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function RateLimitBanner({ rateLimit, onDismiss }) {
  const [remainingMs, setRemainingMs] = useState(() => {
    if (!rateLimit?.retryAt) return rateLimit?.retryAfterMs ?? 0;
    return Math.max(0, new Date(rateLimit.retryAt).getTime() - Date.now());
  });
  const timerRef = useRef(null);

  useEffect(() => {
    if (!rateLimit?.retryAt) {
      setRemainingMs(rateLimit?.retryAfterMs ?? 0);
      return;
    }
    const updateRemaining = () => {
      const remaining = Math.max(0, new Date(rateLimit.retryAt).getTime() - Date.now());
      setRemainingMs(remaining);
      if (remaining <= 0 && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
        onDismiss?.();
      }
    };
    updateRemaining();
    timerRef.current = setInterval(updateRemaining, 1000);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [rateLimit?.retryAt, rateLimit?.retryAfterMs, onDismiss]);

  const handleActionClick = useCallback(() => {
    if (rateLimit?.action?.link) {
      window.open(rateLimit.action.link, "_blank", "noopener,noreferrer");
    }
  }, [rateLimit?.action?.link]);

  if (!rateLimit) return null;

  const isHardLimit = rateLimit.type === "free_tier_limit" || rateLimit.type === "account_rate_limit";
  const title = rateLimit.action?.title ?? (isHardLimit ? "Usage Limit Reached" : "Rate Limited");
  const message = rateLimit.message ?? "Rate limit exceeded. Please try again later.";
  const actionLabel = rateLimit.action?.label;
  const actionLink = rateLimit.action?.link;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-lg px-4">
      <Alert
        variant={isHardLimit ? "destructive" : "default"}
        className={`flex items-start gap-3 ${
          isHardLimit
            ? "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900"
            : "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900"
        }`}
      >
        {isHardLimit ? (
          <TriangleAlertIcon className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
        ) : (
          <ClockIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <AlertTitle
            className={
              isHardLimit
                ? "text-red-800 dark:text-red-200"
                : "text-amber-800 dark:text-amber-200"
            }
          >
            {title}
          </AlertTitle>
          <AlertDescription
            className={`text-sm mt-1 ${
              isHardLimit
                ? "text-red-700 dark:text-red-300"
                : "text-amber-700 dark:text-amber-300"
            }`}
          >
            <span>{message}</span>
            {remainingMs > 0 && (
              <span className="ml-2 font-medium">
                ({isHardLimit ? "Resets in" : "Retrying in"} {formatCountdown(remainingMs)})
              </span>
            )}
          </AlertDescription>
          {(actionLabel || onDismiss) && (
            <div className="flex items-center gap-2 mt-3">
              {actionLabel && actionLink && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleActionClick}
                  className="flex items-center gap-1.5"
                >
                  {actionLabel}
                  <ExternalLinkIcon className="h-3.5 w-3.5" />
                </Button>
              )}
              {onDismiss && (
                <Button variant="ghost" size="sm" onClick={onDismiss}>
                  Dismiss
                </Button>
              )}
            </div>
          )}
        </div>
      </Alert>
    </div>
  );
}
