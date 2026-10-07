import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../ui/card.tsx";
import { Button } from "../ui/button.tsx";
import { Label } from "../ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { ORCHESTRATOR_BEHAVIOR_OPTIONS, ORCHESTRATOR_BEHAVIOR_LABELS } from "../../stores/setupForm.js";
import { getOrchestratorBehaviorDescription } from "./FeatureModeControl.jsx";

export function OrchestratorCard({
  orchestrator, features, setFeature, setOrchestratorField, patchForm,
  enabledModels, variantsForKey, openOrchestratorPreview, previewBusy,
  isFrozen, readOnly, sectionRef,
}) {
  return (
    <Card ref={sectionRef}>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <CardTitle>5. Orchestrator agent</CardTitle>
            <CardDescription>Choose the coordinating model and define how it manages, summarizes, and synthesizes the deliberation.</CardDescription>
          </div>
          <div className="ml-auto">
            <Button variant="outline" size="sm" onClick={openOrchestratorPreview} disabled={previewBusy || isFrozen || readOnly} title={isFrozen ? "Locked while a deliberation is running" : readOnly ? "Locked — this deliberation's configuration is read-only" : "Show how the current orchestrator settings affect round summaries and final synthesis"}>
              {previewBusy ? "Previewing…" : "Preview prompt impact"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="min-w-0">
            <Label htmlFor="loom-orchestrator-deliberationMode" className="cursor-default">Deliberation mode</Label>
            <p className="mt-0.5 text-xs text-muted-foreground" aria-live="polite">{features.buildMode === true ? "Build — agents may write and edit project files after reading. Choose this when the deliberation should produce live changes." : "Plan — read-only. Agents propose diffs but never write. Switch to Build before starting if you expect live file changes."}</p>
          </div>
          <Select value={features.buildMode === true ? "build" : "plan"} onValueChange={(value) => setFeature("buildMode", value === "build")} disabled={isFrozen || readOnly}>
            <SelectTrigger id="loom-orchestrator-deliberationMode" size="sm" className="w-44 shrink-0 font-normal" aria-label="Deliberation mode">
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="plan">Plan — read-only</SelectItem>
              <SelectItem value="build">Build — may write</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label htmlFor="loom-orchestrator-model">Orchestrator model</Label>
              <Select value={orchestrator.model ?? ""} onValueChange={(value) => patchForm({ orchestrator: { ...orchestrator, model: value, variant: null } })} disabled={isFrozen || readOnly || !enabledModels.length}>
                <SelectTrigger id="loom-orchestrator-model" className="max-w-xl font-mono text-xs" aria-label="Orchestrator model">
                  <SelectValue placeholder="Select a model…" />
                </SelectTrigger>
                <SelectContent>
                  {enabledModels.map((m) => <SelectItem key={m.key} value={m.key}>{m.key}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {variantsForKey(orchestrator.model).length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="loom-orchestrator-variant">Variant</Label>
                <Select value={orchestrator.variant ?? "default"} onValueChange={(value) => setOrchestratorField("variant", value === "default" ? null : value)} disabled={isFrozen || readOnly || !enabledModels.length}>
                  <SelectTrigger id="loom-orchestrator-variant" size="sm" className="min-w-28 font-mono text-xs capitalize" aria-label="Orchestrator variant">
                    <SelectValue placeholder="Default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    {variantsForKey(orchestrator.model).map((v) => (
                      <SelectItem key={v} value={v} className="capitalize">{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">The model used for orchestrator calls, including turn planning, round summaries, and final synthesis; participant models remain independent. Variant selects the model's reasoning-effort overlay when the provider offers one — Default uses the server default.</p>
        </div>
        <div className="flex flex-col gap-2">
          {Object.entries(ORCHESTRATOR_BEHAVIOR_OPTIONS).map(([key, options]) => (
            <div key={key} className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div className="min-w-0">
                <Label htmlFor={`loom-orchestrator-${key}`} className="cursor-default">{ORCHESTRATOR_BEHAVIOR_LABELS[key]}</Label>
                <p className="mt-0.5 text-xs text-muted-foreground" aria-live="polite">{getOrchestratorBehaviorDescription(key, orchestrator[key])}</p>
              </div>
              <Select value={orchestrator[key]} onValueChange={(value) => setOrchestratorField(key, value)} disabled={isFrozen || readOnly}>
                <SelectTrigger id={`loom-orchestrator-${key}`} size="sm" className="w-44 shrink-0 font-normal">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="loom-orchestrator-custom">Custom operating instructions <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Textarea
            id="loom-orchestrator-custom"
            rows={3}
            maxLength={4000}
            placeholder="e.g. Favor explicit tradeoffs, keep dissent visible, and call out assumptions before recommending action."
            value={orchestrator.customInstructions}
            onChange={(event) => setOrchestratorField("customInstructions", event.target.value)}
            disabled={isFrozen || readOnly}
          />
        </div>
      </CardContent>
    </Card>
  );
}
