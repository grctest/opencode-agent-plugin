import { Button } from "../ui/button.tsx";
import { ORCHESTRATOR_BEHAVIOR_OPTIONS } from "../../stores/setupForm.js";

export function FeatureModeControl({ value, onChange, disabled }) {
  return (
    <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Capability mode">
      {["disabled", "optional", "mandatory"].map((mode) => (
        <Button
          key={mode}
          type="button"
          size="sm"
          variant={value === mode ? "default" : "outline"}
          disabled={disabled}
          onClick={() => onChange(mode)}
          aria-pressed={value === mode}
          className="px-2 text-[11px] capitalize"
        >
          {mode}
        </Button>
      ))}
    </div>
  );
}

export function getOrchestratorBehaviorOption(key, value) {
  const options = ORCHESTRATOR_BEHAVIOR_OPTIONS[key] ?? [];
  return options.find((option) => option.value === value) ?? options[0];
}

export function getOrchestratorBehaviorDescription(key, value) {
  return getOrchestratorBehaviorOption(key, value)?.description;
}
