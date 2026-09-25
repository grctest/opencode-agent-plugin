import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog.tsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs.tsx";
import { Badge } from "./ui/badge.tsx";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./ui/collapsible.tsx";
import { ORCHESTRATOR_BEHAVIOR_OPTIONS } from "../stores/setupForm.js";

function selectedOptionLabel(impact) {
  const options = ORCHESTRATOR_BEHAVIOR_OPTIONS[impact?.key] ?? [];
  return options.find((option) => option.value === impact?.value)?.label ?? String(impact?.value ?? "");
}

function ImpactList({ impacts }) {
  return (
    <ul className="flex flex-col gap-2">
      {(impacts ?? []).map((impact) => (
        <li key={impact.key} className="rounded-lg border p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-xs">{impact.label}</strong>
            <Badge variant="secondary" className="text-[11px] font-normal">{selectedOptionLabel(impact)}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{impact.effect}</p>
          {impact.excerpt ? (
            <Collapsible className="mt-1.5">
              <CollapsibleTrigger className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                View exact insertion
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-1.5 max-h-32 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] whitespace-pre-wrap">{impact.excerpt}</pre>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function PromptSection({ title, appliesTo, system, user }) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h4 className="text-sm font-medium">{title}</h4>
        <p className="text-xs text-muted-foreground">{appliesTo}</p>
      </div>
      <Collapsible>
        <CollapsibleTrigger className="text-left text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          View assembled system instruction
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg border bg-muted/40 p-2.5 font-mono text-[11px] whitespace-pre-wrap">{system}</pre>
        </CollapsibleContent>
      </Collapsible>
      <Collapsible>
        <CollapsibleTrigger className="text-left text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          View representative user prompt
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg border bg-muted/40 p-2.5 font-mono text-[11px] whitespace-pre-wrap">{user}</pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function OrchestratorPreviewDialog({ open, busy, error, preview, onOpenChange }) {
  const unused = preview?.unusedByThesePrompts?.[0];
  const unusedLabel = (ORCHESTRATOR_BEHAVIOR_OPTIONS[unused?.key] ?? []).find((option) => option.value === unused?.value)?.label ?? String(unused?.value ?? "");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Orchestrator prompt impact</DialogTitle>
          <DialogDescription>
            Static preview only. These excerpts use the current Step 5 selections and a short synthetic deliberation; no model is called.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {busy && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Building prompt preview…
            </p>
          )}
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Preview unavailable</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {preview && !busy && !error && (
            <Tabs defaultValue="round-summary" className="flex min-h-0 flex-col gap-3">
              <TabsList>
                <TabsTrigger value="round-summary">Round summary</TabsTrigger>
                <TabsTrigger value="final-synthesis">Final synthesis</TabsTrigger>
                <TabsTrigger value="configuration">Configuration</TabsTrigger>
              </TabsList>
              <TabsContent value="round-summary" className="flex flex-col gap-3">
                <ImpactList impacts={preview.roundSummary?.impacts} />
                <PromptSection
                  title={preview.roundSummary?.title}
                  appliesTo={preview.roundSummary?.appliesTo}
                  system={preview.roundSummary?.system}
                  user={preview.roundSummary?.user}
                />
              </TabsContent>
              <TabsContent value="final-synthesis" className="flex flex-col gap-3">
                <ImpactList impacts={preview.finalSynthesis?.impacts} />
                <PromptSection
                  title={preview.finalSynthesis?.title}
                  appliesTo={preview.finalSynthesis?.appliesTo}
                  system={preview.finalSynthesis?.system}
                  user={preview.finalSynthesis?.user}
                />
              </TabsContent>
              <TabsContent value="configuration" className="flex flex-col gap-3 text-xs">
                <div className="rounded-lg border p-2.5">
                  <strong className="text-xs">Turn-order policy is not used by these two prompts</strong>
                  <p className="mt-1 text-muted-foreground">{unused?.reason}</p>
                  <p className="mt-1 text-[11px]">Current value: {unusedLabel}</p>
                </div>
                <div className="rounded-lg border p-2.5">
                  <strong className="text-xs">Sample-data provenance</strong>
                  <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                    {(preview.sampleProvenance ?? []).map((entry) => (
                      <li key={entry.field}>{entry.field}: {entry.source}</li>
                    ))}
                  </ul>
                </div>
                <p className="text-muted-foreground">{preview.boundaryNote}</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {(preview.notes ?? []).map((note, index) => <li key={index}>{note}</li>)}
                </ul>
                <pre className="max-h-48 overflow-auto rounded-lg border bg-muted/40 p-2.5 font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(preview.config, null, 2)}</pre>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
