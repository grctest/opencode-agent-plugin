import { Button } from "../ui/button.tsx";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../ui/card.tsx";
import { Input } from "../ui/input.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { Label } from "../ui/label.tsx";

export function QuestionCard({ question, setQuestion, context, setContext, maxRounds, setMaxRounds, taskMode, setTaskMode, buildMode, setDeliberationMode, disabled, sectionRef }) {
  return (
    <Card ref={sectionRef}>
      <CardHeader>
        <CardTitle>1. Question</CardTitle>
        <CardDescription>What should the circle deliberate on?</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="loom-question">Question</Label>
          <Textarea
            id="loom-question"
            rows={3}
            placeholder="e.g. Should we migrate our authentication from sessions to JWT?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="loom-context">Context <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Textarea
            id="loom-context"
            rows={2}
            placeholder="Background, files to consider, constraints…"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="loom-rounds">Max rounds</Label>
            <Input
              id="loom-rounds"
              type="number"
              min={1}
              max={10}
              value={maxRounds}
              onChange={(e) => setMaxRounds(e.target.value)}
              className="w-20"
              disabled={disabled}
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="min-w-0">
            <Label htmlFor="loom-task-mode" className="cursor-default">Task type</Label>
            <p className="mt-0.5 text-xs text-muted-foreground" aria-live="polite">{taskMode === "programming" ? "Programming — code collaboration: agents read files, propose or apply diffs, and hand off work." : "Discussion — agents deliberate in prose: research, cite, and argue. No code scaffolding in the prompts."}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Task type" id="loom-task-mode">
            <Button
              type="button"
              size="sm"
              variant={taskMode === "discussion" ? "default" : "outline"}
              disabled={disabled}
              onClick={() => setTaskMode("discussion")}
              aria-pressed={taskMode === "discussion"}
              title="Agents deliberate in prose — research, cite, and argue. No code scaffolding in the prompts."
              className="px-2 text-[11px]"
            >
              Discussion
            </Button>
            <Button
              type="button"
              size="sm"
              variant={taskMode === "programming" ? "default" : "outline"}
              disabled={disabled}
              onClick={() => setTaskMode("programming")}
              aria-pressed={taskMode === "programming"}
              title="Code collaboration: agents read files, propose or apply diffs, and hand off work."
              className="px-2 text-[11px]"
            >
              Programming
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="min-w-0">
            <Label htmlFor="loom-deliberationMode" className="cursor-default">Deliberation mode</Label>
            <p className="mt-0.5 text-xs text-muted-foreground" aria-live="polite">{buildMode ? "Build — agents may write and edit project files after reading. Choose this when the deliberation should produce live changes." : "Plan — read-only. Agents propose diffs but never write. Switch to Build before starting if you expect live file changes."}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Deliberation mode" id="loom-deliberationMode">
            <Button
              type="button"
              size="sm"
              variant={buildMode ? "outline" : "default"}
              disabled={disabled}
              onClick={() => setDeliberationMode("plan")}
              aria-pressed={!buildMode}
              title="Read-only. Agents propose diffs but never write."
              className="px-2 text-[11px]"
            >
              Plan
            </Button>
            <Button
              type="button"
              size="sm"
              variant={buildMode ? "default" : "outline"}
              disabled={disabled}
              onClick={() => setDeliberationMode("build")}
              aria-pressed={buildMode}
              title="Agents may write and edit project files. Choose this if the deliberation should produce live changes."
              className="px-2 text-[11px]"
            >
              Build
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
