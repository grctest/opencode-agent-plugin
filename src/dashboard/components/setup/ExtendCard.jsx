import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../ui/card.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Label } from "../ui/label.tsx";

export function ExtendCard({ selectedMeeting, extendInput, setExtendInput, extendRounds, setExtendRounds, doExtend, busy, job }) {
  if (!selectedMeeting) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Extend current deliberation</CardTitle>
        <CardDescription>Send new input to the circle selected in the sidebar.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1">
            <Input
              placeholder="New input for the circle…"
              value={extendInput}
              onChange={(e) => setExtendInput(e.target.value)}
              aria-label="New input for the current deliberation"
              disabled={!!job?.running}
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="loom-extend-rounds" className="text-xs text-muted-foreground">Additional rounds</Label>
            <Input
              id="loom-extend-rounds"
              type="number"
              min={1}
              max={10}
              value={extendRounds}
              onChange={(e) => setExtendRounds(e.target.value)}
              className="w-20"
              disabled={!!job?.running}
              aria-label="Additional rounds to grant"
            />
          </div>
          <Button variant="outline" onClick={doExtend} disabled={extendInput.trim().length < 3 || !!job?.running || busy === "extend"}>
            {busy === "extend" ? "Extending…" : "Extend"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
