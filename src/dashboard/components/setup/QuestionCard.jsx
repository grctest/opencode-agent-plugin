import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../ui/card.tsx";
import { Input } from "../ui/input.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { Label } from "../ui/label.tsx";

export function QuestionCard({ question, setQuestion, context, setContext, maxRounds, setMaxRounds, disabled, sectionRef }) {
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
      </CardContent>
    </Card>
  );
}
