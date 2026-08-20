import { memo, useMemo, useState, useEffect } from "react";
import { ParticipationMatrix } from "./Charts.jsx";

function MetricsFooter() {
  const [metrics, setMetrics] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const fetchMetrics = async () => {
      try {
        const res = await fetch("/api/metrics");
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setMetrics(data);
        }
      } catch {}
    };
    fetchMetrics();
    const id = setInterval(fetchMetrics, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  if (!metrics) return null;
  const agentCalls = metrics.counters?.llm_calls_by_type?.agent ?? 0;
  const synthCalls = metrics.counters?.llm_calls_by_type?.synthesis ?? 0;
  const llmLatency = metrics.latencies?.llm_prompt_ms;
  const synthLatency = metrics.latencies?.synthesis_ms;
  const hasData = agentCalls > 0 || synthCalls > 0 || (llmLatency && llmLatency.count > 0);
  if (!hasData) return null;
  return (
    <div className="loom-card loom-mt-sm loom-metrics-footer">
      <h3 className="loom-title-sm loom-mb-sm">Live Telemetry (daemon)</h3>
      <div className="loom-metrics-grid">
        <span>Agent calls: {agentCalls} · Synthesis: {synthCalls}</span>
        {llmLatency && llmLatency.count > 0 && (
          <span>LLM prompt p50 {llmLatency.p50}ms p95 {llmLatency.p95}ms avg {llmLatency.avg}ms</span>
        )}
        {synthLatency && synthLatency.count > 0 && (
          <span>Synthesis p50 {synthLatency.p50}ms p95 {synthLatency.p95}ms</span>
        )}
      </div>
      <div className="loom-text-xs loom-text-muted">Counters: llm_calls_by_type (agent/synthesis) · Latencies: llm_prompt_ms, synthesis_ms</div>
    </div>
  );
}

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
  participantName,
  totalRounds,
  activeRound,
}) => {
  const stats = state?.stats ?? {};
  const totalCalls = useMemo(() => CALL_COUNTER_KEYS.reduce((sum, key) => sum + (Number(stats[key]) || 0), 0), [stats]);
  const totalInputTokens = useMemo(() => Number(stats.input_tokens) || 0, [stats]);
  const totalOutputTokens = useMemo(() => Number(stats.output_tokens) || 0, [stats]);

  const typeCounts = useMemo(() => {
    const counts = {};
    for (const c of contributions) {
      counts[c.type] = (counts[c.type] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }, [contributions]);

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
          <span className="loom-stat-value">{turnRequests.length}</span>
          <span className="loom-stat-label">Turn Requests</span>
        </div>
        {totalCalls > 0 && (
          <div className="loom-stat-card">
            <span className="loom-stat-value">{totalCalls}</span>
            <span className="loom-stat-label">LLM Calls</span>
          </div>
        )}
        {totalInputTokens > 0 && (
          <div className="loom-stat-card">
            <span className="loom-stat-value">{totalInputTokens.toLocaleString()}</span>
            <span className="loom-stat-label">Input Tokens</span>
          </div>
        )}
        {totalOutputTokens > 0 && (
          <div className="loom-stat-card">
            <span className="loom-stat-value">{totalOutputTokens.toLocaleString()}</span>
            <span className="loom-stat-label">Output Tokens</span>
          </div>
        )}
      </div>
      {typeCounts.length > 0 && (
        <div className="loom-card loom-mt-sm">
          <h3 className="loom-title-sm loom-mb-sm">Contribution Types</h3>
          <div className="loom-type-stats">
            {typeCounts.map(({ type, count }) => (
              <div key={type} className="loom-type-stat-row">
                <span className="loom-type-stat-name">{type}</span>
                <span className="loom-type-stat-count">{count}</span>
                <div className="loom-type-stat-bar-track">
                  <div
                    className="loom-type-stat-bar"
                    style={{ width: `${contributions.length > 0 ? (count / contributions.length) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="loom-mt-sm">
        <ParticipationMatrix
          participants={participants}
          contributions={contributions}
          agentErrors={agentErrors}
          rounds={totalRounds}
          activeRound={activeRound}
        />
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
      <MetricsFooter />
    </div>
  );
});
export default OverviewTab;
