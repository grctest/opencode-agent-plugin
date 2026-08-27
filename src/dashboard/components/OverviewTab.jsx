import { memo, useMemo } from "react";
import { ParticipationMatrix, ContributionTypeChart, ContributionTimeline } from "./Charts.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert.tsx";
import { Badge } from "./ui/badge.tsx";
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

  const StatCard = ({ value, label }) => (
    <Card className="py-4">
      <CardContent className="text-center py-0">
        <span className="block text-2xl font-bold">{value}</span>
        <span className="block text-xs text-muted-foreground mt-1">{label}</span>
      </CardContent>
    </Card>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard value={state.round} label="Rounds" />
        <StatCard value={contributions.length} label="Contributions" />
        <StatCard value={turnRequests.length} label="Turn Requests" />
        {totalCalls > 0 && <StatCard value={totalCalls} label="LLM Calls" />}
        {totalInputTokens > 0 && <StatCard value={totalInputTokens.toLocaleString()} label="Input Tokens" />}
        {totalOutputTokens > 0 && <StatCard value={totalOutputTokens.toLocaleString()} label="Output Tokens" />}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ContributionTypeChart contributions={contributions} />
        <ContributionTimeline contributions={contributions} />
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
