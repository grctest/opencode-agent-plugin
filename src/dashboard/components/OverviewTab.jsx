import { memo, useMemo } from "react";
import { ParticipationMatrix, ContributionTypeChart, ContributionTimeline } from "./Charts.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert.tsx";
import { Badge } from "./ui/badge.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { Label } from "./ui/label.tsx";
import { TriangleAlertIcon } from "lucide-react";

const CALL_COUNTER_KEYS = [
  "agent_prompts",
  "reflection_calls",
  "orchestrator",
  "moderation",
  "summary",
  "turn_order",
  "synthesis",
];

const StatCard = memo(({ value, label }) => (
  <Card className="py-4">
    <CardContent className="text-center py-0">
      <span className="block text-2xl font-bold">{value}</span>
      <span className="block text-xs text-muted-foreground mt-1">{label}</span>
    </CardContent>
  </Card>
));

export const OverviewTab = memo(({
  state,
  contributions,
  turnRequests,
  participants,
  agentErrors,
  orchestratorMessages,
  participantName,
  totalRounds,
  activeRound,
}) => {
  const stats = state?.stats ?? {};
  const totalCalls = useMemo(() => CALL_COUNTER_KEYS.reduce((sum, key) => sum + (Number(stats[key]) || 0), 0), [stats]);
  const totalInputTokens = useMemo(() => Number(stats.input_tokens) || 0, [stats]);
  const totalOutputTokens = useMemo(() => Number(stats.output_tokens) || 0, [stats]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Left column: 1 row of 3 stats above chart */}
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            <StatCard value={state.round} label="Rounds" />
            <StatCard value={contributions.length} label="Contributions" />
            <StatCard value={turnRequests.length} label="Turn Requests" />
          </div>
          {(totalCalls > 0 || totalInputTokens > 0 || totalOutputTokens > 0) && (
            <div className="grid grid-cols-3 gap-3">
              {totalCalls > 0 && <StatCard value={totalCalls} label="LLM Calls" />}
              {totalInputTokens > 0 && <StatCard value={totalInputTokens.toLocaleString()} label="Input Tokens" />}
              {totalOutputTokens > 0 && <StatCard value={totalOutputTokens.toLocaleString()} label="Output Tokens" />}
            </div>
          )}
          <ContributionTypeChart contributions={contributions} />
          <ContributionTimeline contributions={contributions} />
        </div>

        {/* Right column: knit message query in textarea */}
        <div className="flex flex-col gap-2 min-h-0">
          <Label htmlFor="knit-query" className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Knit Message
          </Label>
          <Textarea
            id="knit-query"
            readOnly
            value={state.question ?? ""}
            placeholder="No knit message"
            className="flex-1 min-h-[280px] lg:min-h-[320px] h-full resize-none bg-white dark:bg-input/30 font-mono text-sm field-sizing-fixed overflow-auto"
          />
        </div>
      </div>

      <ParticipationMatrix
        participants={participants}
        contributions={contributions}
        agentErrors={agentErrors}
        orchestratorMessages={orchestratorMessages}
        rounds={totalRounds}
        activeRound={activeRound}
      />

      {agentErrors.length > 0 && (
        <Card className="border-destructive/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><TriangleAlertIcon className="size-4 text-destructive" /> Agent Errors</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {agentErrors.map((err, i) => (
              <Alert key={i} variant="destructive" className="py-2">
                <TriangleAlertIcon />
                <AlertTitle className="text-xs">{participantName(err.participant_id)} — {err.error_type}</AlertTitle>
                <AlertDescription className="text-xs">{err.error_message}</AlertDescription>
              </Alert>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
});
export default OverviewTab;
