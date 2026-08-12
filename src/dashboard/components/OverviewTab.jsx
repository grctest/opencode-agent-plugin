import { cn, typeClass } from "../utils.js";
import { ParticipationMatrix, ContributionTypeChart, ContributionTimeline } from "./Charts.jsx";

export function OverviewTab({
  state,
  contributions,
  interjections,
  participants,
  contributionStats,
  agentErrors,
  participantName,
  totalRounds,
}) {
  const stats = state?.stats ?? {};
  const callStats = stats.calls ?? {};
  const totalInputTokens = callStats.totalInputTokens ?? 0;
  const totalOutputTokens = callStats.totalOutputTokens ?? 0;
  const totalCalls = callStats.total ?? 0;

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
      {Object.keys(contributionStats).length > 0 && (
        <div className="loom-card loom-mt-sm">
          <h3 className="loom-title-sm loom-mb-sm">Contribution Types</h3>
          <div className="loom-stat-badges">
            {Object.entries(contributionStats).map(([type, count]) => (
              <span key={type} className={cn("loom-badge", typeClass(type))}>
                {type}: {count}
              </span>
            ))}
          </div>
        </div>
      )}
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
    </div>
  );
}
