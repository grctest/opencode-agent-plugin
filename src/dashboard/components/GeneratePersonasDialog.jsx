import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog.tsx";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Alert } from "./ui/alert.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { Label } from "./ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Avatar } from "./Avatar.tsx";
import { CATEGORY_META, AVATAR_EXPRESSION, AVATAR_COLORS } from "./tierMeta.jsx";

const COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];
const PREVIEW_QUESTION_MAX = 300;
const PREVIEW_CONTEXT_MAX = 240;

const clip = (text, max) => {
  const t = String(text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

function ResultRow({ persona, selected, onToggle }) {
  const meta = CATEGORY_META[persona.category] ?? CATEGORY_META.mid;
  const tags = (persona.tags ?? []).slice(0, 3);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      aria-label={`${selected ? "Deselect" : "Select"} ${persona.name} (${meta.label})`}
      className={
        "flex w-full gap-3 rounded-xl border p-3 text-left transition-all duration-150 " +
        (selected
          ? "border-primary/60 bg-primary/[0.06]"
          : "border-border bg-card hover:-translate-y-px hover:border-primary/40 hover:bg-muted/50")
      }
    >
      <span className="shrink-0 self-center" aria-hidden="true">
        <Avatar name={persona.name} extra="Generate" size={36} title={persona.name} expression={AVATAR_EXPRESSION} colors={AVATAR_COLORS} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <strong className="truncate text-sm">{persona.name}</strong>
          <Badge variant="outline" className={"shrink-0 " + meta.badge} title={meta.blurb}>{meta.label}</Badge>
        </span>
        {persona.angle ? (
          <span className="truncate text-xs italic text-muted-foreground" title={persona.angle}>
            {persona.angle}
          </span>
        ) : null}
        <span className="flex gap-1 overflow-hidden">
          {tags.map((t) => (
            <Badge key={t} variant="secondary" className="shrink-0 text-[10px] font-normal">{t}</Badge>
          ))}
        </span>
        <span className="truncate text-xs text-muted-foreground" title={persona.agenda}>{persona.agenda}</span>
      </span>
      <span
        aria-hidden="true"
        className={
          "flex h-5 w-5 shrink-0 self-center items-center justify-center rounded border text-xs " +
          (selected ? "border-primary bg-primary text-primary-foreground" : "border-border text-transparent")
        }
      >
        ✓
      </span>
    </button>
  );
}

/**
 * Bespoke persona generation dialog.
 *
 * Three steps in one controlled dialog:
 *  1. intro    — explains the process, count (1-8, default 3) + model picks.
 *  2. running  — one LLM call; honest spinner copy, no fake progress.
 *  3. results  — multi-select the generated personas, each showing its unique
 *                `angle`, then "Add N to room" (which also saves them to the
 *                Custom tab via the parent).
 *
 * Busy/error/results live in the parent hook so a close during generation
 * doesn't lose state — reopening shows the running step again.
 */
export function GeneratePersonasDialog({
  open,
  question,
  context,
  enabledModels,
  genDefaultModel,
  busy,
  error,
  results,
  rejected,
  onGenerate,
  onReset,
  onApply,
  onOpenChange,
}) {
  const [count, setCount] = useState(3);
  const [modelKey, setModelKey] = useState(genDefaultModel ?? "");
  const [selected, setSelected] = useState(() => new Set());

  const questionOk = String(question ?? "").trim().length >= 3;
  const hasResults = (results ?? []).length > 0;
  const step = busy ? "running" : hasResults ? "results" : "intro";

  // Reseed on mount (the parent mounts this dialog only while open), so
  // reopening never inherits a previous run's selection or pending results —
  // parent state is cleared here too.
  useEffect(() => {
    setCount(3);
    setModelKey(genDefaultModel ?? "");
    setSelected(new Set());
    onReset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The model list can arrive after mount (llm fetch race) — fill the default
  // in once it exists, but never overwrite a user's explicit pick.
  useEffect(() => {
    if (!modelKey && genDefaultModel) setModelKey(genDefaultModel);
  }, [modelKey, genDefaultModel]);

  const selectedInOrder = useMemo(
    () => (results ?? []).filter((p) => selected.has(p.name)),
    [results, selected],
  );

  const toggle = (name) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const startGeneration = () => onGenerate({ count, model: modelKey || null });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[88vh] max-w-2xl flex-col overflow-hidden"
        aria-label="Generate bespoke personas"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>Generate bespoke personas</DialogTitle>
          <DialogDescription>
            {step === "results"
              ? "Distinct takes on your question — pick the ones you want in the room."
              : "Persona definitions written for your exact question, each from a different angle."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {step === "intro" && (
            <>
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
                <li>We read your question and context from Setup step 1.</li>
                <li>The selected model designs N personas — one distinct lens each, checked against the existing catalog for overlap.</li>
                <li>You pick from the results. Selected seats are also saved under the <strong>Custom</strong> tab for future sessions.</li>
              </ol>

              <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
                <div className="font-medium text-foreground">Generating for:</div>
                <p className="mt-1 text-muted-foreground">“{clip(question, PREVIEW_QUESTION_MAX)}”</p>
                {String(context ?? "").trim() && (
                  <p className="mt-1 text-muted-foreground">Context: {clip(context, PREVIEW_CONTEXT_MAX)}</p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label htmlFor="loom-generate-count">How many personas</Label>
                  <Select value={String(count)} onValueChange={(v) => setCount(Number(v))}>
                    <SelectTrigger id="loom-generate-count" size="sm" className="w-32" aria-label="Number of personas to generate">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COUNT_OPTIONS.map((n) => (
                        <SelectItem key={n} value={String(n)}>{n} persona{n === 1 ? "" : "s"}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="loom-generate-model">Model</Label>
                  <Select value={modelKey} onValueChange={setModelKey}>
                    <SelectTrigger id="loom-generate-model" size="sm" className="max-w-72 font-mono text-xs" aria-label="Model for persona generation">
                      <SelectValue placeholder="Select model…" />
                    </SelectTrigger>
                    <SelectContent>
                      {(enabledModels ?? []).map((m) => (
                        <SelectItem key={m.key} value={m.key} className="font-mono text-xs">{m.key}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {error && (
                <Alert variant="destructive" role="alert">
                  <span>{error}</span>
                </Alert>
              )}
              {!questionOk && (
                <Alert>
                  <span>Describe your question in Setup step 1 first — generation is grounded in it.</span>
                </Alert>
              )}
              {!modelKey && (enabledModels ?? []).length === 0 && (
                <Alert>
                  <span>Enable at least one model in Setup step 2 first.</span>
                </Alert>
              )}
            </>
          )}

          {step === "running" && (
            <div className="flex flex-col items-center justify-center gap-3 py-10 text-sm text-muted-foreground" aria-live="polite">
              <Spinner />
              <p>Designing {count} distinct lens{count === 1 ? "" : "es"} for your question…</p>
              <p className="text-xs">This is a single model call and can take up to a minute.</p>
            </div>
          )}

          {step === "results" && (
            <>
              {(rejected ?? []).length > 0 && (
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {(rejected ?? []).length} output{(rejected ?? []).length === 1 ? " was" : "s were"} dropped as invalid or duplicate — showing {results.length} usable persona{results.length === 1 ? "" : "s"}.
                </p>
              )}
              <div className="flex flex-col gap-2">
                {(results ?? []).map((p) => (
                  <ResultRow
                    key={p.name}
                    persona={p}
                    selected={selected.has(p.name)}
                    onToggle={() => toggle(p.name)}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <DialogFooter className="shrink-0 items-center justify-between gap-3 sm:justify-between">
          {step === "intro" && (
            <>
              <span className="min-w-0 text-xs text-muted-foreground">
                One model call · nothing is saved until you seat a persona.
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button size="sm" onClick={startGeneration} disabled={busy || !questionOk || !modelKey}>
                  Generate {count} persona{count === 1 ? "" : "s"}
                </Button>
              </span>
            </>
          )}
          {step === "running" && (
            <>
              <span className="min-w-0 text-xs text-muted-foreground">Generation continues even if you close this dialog.</span>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
            </>
          )}
          {step === "results" && (
            <>
              <div className="flex min-w-0 flex-col items-start gap-0.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {selected.size} selected
                  {selectedInOrder.length > 0 && (
                    <span className="font-normal text-muted-foreground">
                      {" "}— {selectedInOrder.slice(0, 4).map((p) => p.name).join(", ")}
                      {selectedInOrder.length > 4 && ` +${selectedInOrder.length - 4} more`}
                    </span>
                  )}
                </span>
                <span>Seating also saves them to your Custom tab.</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="outline" size="sm" onClick={onReset}>Start over</Button>
                <Button variant="outline" size="sm" onClick={startGeneration} disabled={busy}>
                  {busy && <Spinner className="mr-2" />}
                  Regenerate
                </Button>
                <Button size="sm" onClick={() => onApply(selectedInOrder)} disabled={busy || selected.size === 0}>
                  Add {selected.size} to room
                </Button>
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
