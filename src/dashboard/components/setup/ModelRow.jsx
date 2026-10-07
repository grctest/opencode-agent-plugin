import { Checkbox } from "../ui/checkbox.tsx";
import { Badge } from "../ui/badge.tsx";
import { formatContext, formatCost } from "./setupFormat.js";

export function ModelRow({ index, style, ariaAttributes, items, disabled, onToggle }) {
  const m = items[index];
  if (!m) return null;
  const off = !m.enabled || m.unhealthy;
  return (
    <div style={style} {...ariaAttributes}>
      <div className="h-full pb-1">
        <label
          className={"flex h-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-xs hover:bg-muted/60 " + (off ? "opacity-60" : "")}
        >
          <Checkbox
            checked={!!m.enabled}
            disabled={disabled}
            onCheckedChange={(v) => onToggle(m.key, v === true)}
            aria-label={`${m.enabled ? "Disable" : "Enable"} ${m.key} for Loom agents`}
          />
          <span className="min-w-0 flex-1 truncate font-mono" title={m.key}>{m.key}</span>
          <span className="shrink-0 text-muted-foreground">{formatContext(m.context)}</span>
          {m.reasoning && <Badge variant="secondary" className="shrink-0 text-[10px]">reasoning</Badge>}
          <span className="shrink-0 text-muted-foreground">{formatCost(m.cost)}</span>
          {m.unhealthy && <Badge variant="outline" className="shrink-0 border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400" title="Failed repeatedly — excluded until re-enabled">unhealthy</Badge>}
        </label>
      </div>
    </div>
  );
}
