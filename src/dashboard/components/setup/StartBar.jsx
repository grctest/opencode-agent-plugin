import { Button } from "../ui/button.tsx";
import { Spinner } from "../ui/spinner.tsx";

export function StartBar({ budgetEstimate, requirements, scrollToSection, canStart, readOnly, busy, doStart }) {
  return (
    <div className="sticky bottom-3 z-10 rounded-xl border bg-card/95 p-3 shadow-lg backdrop-blur" role="region" aria-label="Start deliberation">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="w-full text-xs text-muted-foreground">
          Planning estimate: up to {budgetEstimate.calls} LLM calls across {budgetEstimate.rounds} rounds and {budgetEstimate.participants} seats. Provider cost and actual usage may vary.
        </div>
        <ul id="loom-start-checklist" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {requirements.map((r) => (
            <li key={r.key} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={
                  "flex size-4 items-center justify-center rounded-full text-[10px] font-bold " +
                  (r.met ? "bg-emerald-500 text-white" : "bg-muted text-muted-foreground")
                }
              >
                {r.met ? "✓" : "○"}
              </span>
              <button
                type="button"
                onClick={() => (r.key === "idle" ? window.scrollTo({ top: 0, behavior: "smooth" }) : scrollToSection(r.key))}
                className={"hover:underline " + (r.met ? "text-muted-foreground" : "font-medium text-foreground")}
                title={r.met ? "Requirement met" : `Jump to: ${r.label}`}
              >
                {r.label}
              </button>
            </li>
          ))}
        </ul>
        <Button
          size="lg"
          onClick={doStart}
          disabled={!canStart || readOnly}
          title={readOnly ? "Locked — this deliberation's configuration is read-only" : canStart ? "Start the deliberation" : `Waiting on: ${requirements.filter((r) => !r.met).map((r) => r.label).join("; ")}`}
          aria-describedby="loom-start-checklist"
        >
          {busy === "start" && <Spinner className="mr-2" />}
          {busy === "start" ? "Starting…" : "Approve & start deliberation"}
        </Button>
      </div>
    </div>
  );
}
