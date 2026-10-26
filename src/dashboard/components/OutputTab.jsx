import { memo, useState, useMemo, useEffect, useRef } from "react";
import { renderMarkdown } from "./Cards.jsx";
import { Card, CardContent, CardFooter } from "./ui/card.tsx";
import { Button } from "./ui/button.tsx";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "./ui/empty.tsx";
import { FileTextIcon, CopyIcon, CheckIcon, DownloadIcon } from "lucide-react";
import { toast } from "./ui/toast.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Label } from "./ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Textarea } from "./ui/textarea.tsx";

function OutputTabBase({ artifact, status, meetingId }) {
  const [copied, setCopied] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(null);
  const [modelKey, setModelKey] = useState("");
  const [variant, setVariant] = useState("default");
  const [instructions, setInstructions] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(null);
  const [regeneratedArtifact, setRegeneratedArtifact] = useState(null);
  const currentMeetingRef = useRef(meetingId);
  currentMeetingRef.current = meetingId;
  const displayedArtifact = regeneratedArtifact ?? artifact;
  const selectedModel = models.find((model) => model.key === modelKey) ?? null;
  const selectedVariants = Array.isArray(selectedModel?.variants) ? selectedModel.variants : [];
  const html = useMemo(() => renderMarkdown(displayedArtifact?.content ?? ""), [displayedArtifact?.content]);

  useEffect(() => {
    setRetrying(false);
    setRetryError(null);
    setRegeneratedArtifact(null);
    setDialogOpen(false);
    setInstructions("");
  }, [meetingId]);

  useEffect(() => {
    if (!dialogOpen) return undefined;
    let cancelled = false;
    setModelsLoading(true);
    setModels([]);
    setModelsError(null);
    fetch("/api/llm-models?refresh=1", { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? `Model discovery failed (${res.status})`);
        if (!Array.isArray(data?.models)) throw new Error("Model discovery returned an invalid response");
        return data.models;
      })
      .then((available) => {
        if (cancelled) return;
        setModels(available);
        const preferred = displayedArtifact?.orchestrator_config?.model;
        setModelKey(available.some((model) => model.key === preferred) ? preferred : (available[0]?.key ?? ""));
        setVariant("default");
      })
      .catch((err) => {
        if (!cancelled) setModelsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => { cancelled = true; };
  }, [dialogOpen, displayedArtifact?.orchestrator_config?.model]);

  const startResynthesis = async () => {
    const id = meetingId ?? new URLSearchParams(window.location.search).get("meeting");
    if (!id || !selectedModel) {
      setModelsError(!id ? "Select a meeting before regenerating its summary." : "Choose a model.");
      return;
    }
    const previousCreatedAt = displayedArtifact?.created_at;
    setRetryError(null);
    setRetrying(true);
    let accepted = false;
    try {
      const response = await fetch("/api/meetings/resynthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meeting_id: id,
          provider_id: selectedModel.provider_id,
          model_id: selectedModel.model_id,
          variant: variant === "default" ? null : variant,
          instructions,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error ?? `Could not start synthesis (${response.status})`);
      accepted = true;
      setDialogOpen(false);

      const deadline = Date.now() + 30 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (currentMeetingRef.current !== id) return;
        const jobResponse = await fetch(`/api/jobs?meeting=${encodeURIComponent(id)}`, { cache: "no-store" });
        const jobData = await jobResponse.json().catch(() => null);
        if (!jobResponse.ok) throw new Error(jobData?.error ?? `Could not check synthesis status (${jobResponse.status})`);
        const job = jobData?.job;
        if (!job) throw new Error("The synthesis job is no longer available.");
        if (job.phase === "error") throw new Error(job.error ?? "Synthesis failed.");
        if (job.phase !== "running" && job.phase !== "cancelling") break;
      }
      if (Date.now() >= deadline) throw new Error("Synthesis is taking longer than expected. Reload the output to check its status.");
      if (currentMeetingRef.current !== id) return;

      const artifactResponse = await fetch(`/api/artifact?meeting=${encodeURIComponent(id)}`, { cache: "no-store" });
      const nextArtifact = await artifactResponse.json().catch(() => null);
      if (!artifactResponse.ok) throw new Error(nextArtifact?.error ?? `Could not load the regenerated summary (${artifactResponse.status})`);
      if (!nextArtifact?.content) throw new Error("Synthesis finished without producing a summary.");
      if (previousCreatedAt && nextArtifact.created_at === previousCreatedAt) {
        throw new Error("Synthesis finished without writing a new summary.");
      }
      setRegeneratedArtifact(nextArtifact);
    } catch (err) {
      if (currentMeetingRef.current === id) {
        setRetryError(err instanceof Error ? err.message : String(err));
        if (accepted) setDialogOpen(false);
      }
    } finally {
      if (currentMeetingRef.current === id) setRetrying(false);
    }
  };

  const download = (format) => {
    const meeting = meetingId ?? new URLSearchParams(window.location.search).get("meeting");
    if (!meeting) return;
    const link = document.createElement("a");
    link.href = `/api/export?meeting=${encodeURIComponent(meeting)}&format=${format}`;
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text ?? "");
      setCopied(true);
      try { toast.add({ title: "Copied to clipboard", type: "success" }); } catch {}
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  if (!displayedArtifact || retrying) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileTextIcon />
          </EmptyMedia>
          <EmptyTitle>{retrying || (status && status !== "weaving" && status !== "initializing") ? "Synthesis in progress" : "No final artifact yet"}</EmptyTitle>
          <EmptyDescription>{retrying ? "The previous summary is hidden while Loom regenerates it." : "The final artifact appears here after synthesis finishes. You can keep reviewing the Timeline while it runs."}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="pt-6">
          <div className="typeset typeset-docs max-w-none w-full">
            <div dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </CardContent>
        <CardFooter className="flex items-center justify-between border-t bg-muted/20">
          <span className="text-xs text-muted-foreground">
            {displayedArtifact.created_at ? `Generated ${new Date(displayedArtifact.created_at).toLocaleString()}` : ""}
            {displayedArtifact.orchestrator_config ? ` · Orchestrator: ${[
              displayedArtifact.orchestrator_config.role,
              displayedArtifact.orchestrator_config.decisionPosture,
              displayedArtifact.orchestrator_config.synthesisStyle,
            ].filter(Boolean).join(" · ")}` : ""}
          </span>
           <div className="flex items-center gap-2">
             <Button variant="ghost" size="sm" onClick={() => download("markdown")}>
               <DownloadIcon className="size-3.5" /> Markdown
             </Button>
             <Button variant="ghost" size="sm" onClick={() => download("json")}>
               <DownloadIcon className="size-3.5" /> JSON
             </Button>
             <Button
               variant="outline"
               size="sm"
               onClick={() => handleCopy(displayedArtifact.content ?? "")}
             >
               {copied ? <><CheckIcon className="size-3.5" /> Copied</> : <><CopyIcon className="size-3.5" /> Copy</>}
             </Button>
           </div>
         </CardFooter>
      </Card>
      {retryError && !dialogOpen && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{retryError}</div>}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div>
            <div className="text-sm font-medium">Want a different synthesis?</div>
            <p className="text-xs text-muted-foreground">Try again with another model or additional instructions.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => { setRetryError(null); setDialogOpen(true); }}>
            Regenerate summary
          </Button>
        </CardContent>
      </Card>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden" aria-label="Regenerate deliberation summary">
          <DialogHeader>
            <DialogTitle>Regenerate summary</DialogTitle>
            <DialogDescription>Re-run synthesis over the saved deliberation using any available model, including models disabled in Setup.</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Label htmlFor="loom-resynthesis-model">Model</Label>
                <Select value={modelKey} onValueChange={(value) => { setModelKey(value); setVariant("default"); }} disabled={modelsLoading || models.length === 0}>
                  <SelectTrigger id="loom-resynthesis-model" className="font-mono text-xs" aria-label="Synthesis model">
                    <SelectValue placeholder={modelsLoading ? "Loading models…" : "Select a model…"} />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((model) => (
                      <SelectItem key={model.key} value={model.key} className="font-mono text-xs">
                        {model.key}{model.enabled ? "" : " (disabled)"}{model.unhealthy ? " (unhealthy)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-36 flex-col gap-1.5">
                <Label htmlFor="loom-resynthesis-variant">Variant</Label>
                <Select value={variant} onValueChange={setVariant} disabled={!selectedModel || selectedVariants.length === 0}>
                  <SelectTrigger id="loom-resynthesis-variant" className="font-mono text-xs capitalize" aria-label="Synthesis model variant">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    {selectedVariants.map((value) => <SelectItem key={value} value={value} className="capitalize">{value}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="loom-resynthesis-instructions">Additional context or instructions <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Textarea
                id="loom-resynthesis-instructions"
                rows={4}
                maxLength={4000}
                placeholder="e.g. Preserve unresolved disagreements and focus the recommendation on the constraints raised in round two."
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                disabled={retrying}
              />
            </div>
            {modelsLoading && <p className="text-xs text-muted-foreground">Loading all available provider models…</p>}
            {modelsError && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{modelsError}</div>}
            {!modelsLoading && !modelsError && models.length === 0 && <p className="text-sm text-muted-foreground">No provider models are currently available.</p>}
            {retryError && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{retryError}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={retrying}>Cancel</Button>
            <Button onClick={startResynthesis} disabled={retrying || modelsLoading || !selectedModel}>
              {retrying ? "Starting…" : "Try synthesis again"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const OutputTab = memo(OutputTabBase);
export { OutputTab };
