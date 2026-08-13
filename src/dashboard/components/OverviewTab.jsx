import { memo, useMemo } from "react";
import { ParticipationMatrix, ContributionTypeChart, ContributionTimeline } from "./Charts.jsx";

const CALL_COUNTER_KEYS = [
  "agent_prompts",
  "reflection_calls",
  "interjection_calls",
  "orchestrator",
  "domain",
  "moderation",
  "convergence",
  "summary",
  "compaction",
  "synthesis",
];

export const OverviewTab = memo(({
  state,
  contributions,
  interjections,
  participants,
  agentErrors,
  participantName,
  totalRounds,
}) => {
  const stats = state?.stats ?? {};
  const totalCalls = useMemo(() => CALL_COUNTER_KEYS.reduce((sum, key) => sum + (Number(stats[key]) || 0), 0), [stats]);
  const totalInputTokens = useMemo(() => Number(stats.input_tokens) || 0, [stats]);
  const totalOutputTokens = useMemo(() => Number(stats.output_tokens) || 0, [stats]);

  return (
    <div className="loom-overview">
      <div className="loom-stats-grid">
        <div className="loom-stat-card">
          <span className="loom-stat-value">{state.round}</span>
          <span className="loom-stat-label">Rounds</span>
        </div>
        <div className="loom-stat-card">
          <span className="loom-stat-value">{contributions.length}</span>
          <span className="loom-stat-label">Contributions</span>
        </div>
        <div className="loom-stat-card">
          <span className="loom-stat-value">{interjections.length}</span>
          <span className="loom-stat-label">Interjections</span>
        </div>
        <div className="loom-stat-card">
          <span className="loom-stat-value">{participants.length}</span>
          <span className="loom-stat-label">Participants</span>
        </div>
      </div>
      {totalCalls > 0 && (
        <div className="loom-stats-grid loom-mt-sm">
          <div className="loom-stat-card">
            <span className="loom-stat-value">{totalCalls}</span>
            <span className="loom-stat-label">LLM Calls</span>
          </div>
          <div className="loom-stat-card">
            <span className="loom-stat-value">{totalInputTokens.toLocaleString()}</span>
            <span className="loom-stat-label">Input Tokens</span>
          </div>
          <div className="loom-stat-card">
            <span className="loom-stat-value">{totalOutputTokens.toLocaleString()}</span>
            <span className="loom-stat-label">Output Tokens</span>
          </div>
        </div>
      )}
      <div className="loom-mt-sm">
        <ParticipationMatrix
          participants={participants}
          contributions={contributions}
          agentErrors={agentErrors}
          rounds={totalRounds}
        />
      </div>
      <div className="loom-mt-sm">
        <ContributionTypeChart contributions={contributions} />
      </div>
      <div className="loom-mt-sm">
        <ContributionTimeline contributions={contributions} />
      </div>
      {agentErrors.length > 0 && (
        <div className="loom-card loom-card-error loom-mt-sm">
          <h3 className="loom-title-sm loom-mb-sm">Agent Errors</h3>
          <div className="loom-space-xs">
            {agentErrors.map((err, i) => (
              <div key={i} className="loom-error-summary">
                <span className="loom-error-participant">{participantName(err.participant_id)}</span>
                <span className="loom-error-type">{err.error_type}</span>
                <span className="loom-error-message">{err.error_message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {participants.some((p) => p.reflections?.length > 0) && (
        <div className="loom-card loom-mt-sm">
          <h3 className="loom-title-sm loom-mb-sm">Participant Reflections</h3>
          <div className="loom-space-xs">
            {participants.filter((p) => p.reflections?.length > 0).map((p) => (
              <div key={p.id} className="loom-reflection-entry">
                <div className="loom-reflection-name">{participantName(p.id)}</div>
                <ul className="loom-reflection-list">
                  {p.reflections.map((r, i) => (
                    <li key={i} className="loom-text-xs loom-text-muted">{r}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
export default OverviewTab;
