import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../ui/card.tsx";
import { Label } from "../ui/label.tsx";
import { Switch } from "../ui/switch.tsx";
import { FeatureModeControl } from "./FeatureModeControl.jsx";

export function CapabilitiesCard({ features, setFeature, isFrozen, readOnly, sectionRef }) {
  const disabled = isFrozen || readOnly;
  return (
    <Card ref={sectionRef}>
      <CardHeader>
        <CardTitle>4. Persona agent capabilities</CardTitle>
        <CardDescription>Define which tools and interaction protocols the participating agents may use.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="mb-1 text-sm font-medium">Agent capabilities</div>
          {[
            ["forums", "Forums", "Allow participants to create, read, and discuss forum topics. Mandatory requires one forum tool call per active turn."],
            ["agentQueries", "Agent-to-agent queries", "Allow peer interaction tools: query, vote, summon, and request-next. Mandatory requires one eligible peer interaction when peers are available."],
            ["localSearch", "Local search", "Allow read, glob, and grep for project files. Mandatory requires one local search call per active turn."],
            ["onlineResearch", "Online research", "Allow websearch and webfetch. Mandatory requires one online research call per active turn."],
          ].map(([key, label, description]) => (
            <div key={key} className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-muted/50">
              <div className="min-w-0">
                <Label className="cursor-default">{label}</Label>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
              <FeatureModeControl value={features[key] ?? "optional"} onChange={(value) => setFeature(key, value)} disabled={disabled} />
            </div>
          ))}
          <div className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-muted/50">
            <div className="min-w-0">
              <Label htmlFor="loom-feature-skillState" className="cursor-pointer">SKILL.state / stance</Label>
              <p className="text-xs text-muted-foreground">When on, each agent projects stance + evidence as their final action each non-pass turn via loom_state_patch. Off disables carried state.</p>
            </div>
            <Switch id="loom-feature-skillState" checked={(() => { const v = features.skillState; return v === "on" || v === "mandatory" || v === "optional" || v === true; })()} onCheckedChange={(value) => setFeature("skillState", value ? "on" : "off")} disabled={disabled} aria-label="SKILL.state / stance" />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-muted/50">
            <div className="min-w-0">
              <Label htmlFor="loom-feature-agentCommands" className="cursor-pointer">Bash commands</Label>
              <p className="text-xs text-muted-foreground">Allow allowlisted shell commands. Bash is always optional.</p>
            </div>
            <Switch id="loom-feature-agentCommands" checked={features.agentCommands !== false} onCheckedChange={(value) => setFeature("agentCommands", value === true)} disabled={disabled} aria-label="Bash commands" />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-muted/50">
            <div className="min-w-0">
              <Label htmlFor="loom-feature-parallelQueries" className="cursor-pointer">Parallel peer queries</Label>
              <p className="text-xs text-muted-foreground">Fan out multi-target queries and votes concurrently in rate-limited batches. Off runs them sequentially.</p>
            </div>
            <Switch id="loom-feature-parallelQueries" checked={features.parallelQueries !== false} onCheckedChange={(value) => setFeature("parallelQueries", value === true)} disabled={disabled} aria-label="Parallel peer queries" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
