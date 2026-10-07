export function StepHeader({ steps }) {
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Setup progress">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden="true" className="text-muted-foreground">→</span>}
          <span
            className={
              "flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium " +
              (s.status === "done"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : s.status === "current"
                  ? "border-primary/50 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground")
            }
          >
            <span
              aria-hidden="true"
              className={
                "flex size-5 items-center justify-center rounded-full text-[11px] font-bold " +
                (s.status === "done" ? "bg-emerald-500 text-white" : s.status === "current" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")
              }
            >
              {s.status === "done" ? "✓" : i + 1}
            </span>
            {s.label}
            {s.detail && <span className="font-normal opacity-80">{s.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
