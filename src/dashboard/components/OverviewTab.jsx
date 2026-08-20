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
      <div className="loom-table-scroll">
        <table className="loom-table loom-metrics-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Count</th>
              <th>p50</th>
              <th>p95</th>
              <th>avg</th>
              <th>max</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Agent calls</td>
              <td>{agentCalls}</td>
              <td>{llmLatency?.p50 ?? "—"} {llmLatency ? "ms" : ""}</td>
              <td>{llmLatency?.p95 ?? "—"} {llmLatency ? "ms" : ""}</td>
              <td>{llmLatency?.avg ?? "—"} {llmLatency ? "ms" : ""}</td>
              <td>{llmLatency?.max ?? "—"} {llmLatency ? "ms" : ""}</td>
            </tr>
            <tr>
              <td>Synthesis calls</td>
              <td>{synthCalls}</td>
              <td>{synthLatency?.p50 ?? "—"} {synthLatency ? "ms" : ""}</td>
              <td>{synthLatency?.p95 ?? "—"} {synthLatency ? "ms" : ""}</td>
              <td>{synthLatency?.avg ?? "—"} {synthLatency ? "ms" : ""}</td>
              <td>{synthLatency?.max ?? "—"} {synthLatency ? "ms" : ""}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="loom-text-xs loom-text-muted loom-mt-xs">Counters: llm_calls_by_type (agent/synthesis) · Latencies: llm_prompt_ms, synthesis_ms · Updates every 5s</div>
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
  orchestratorMessages,
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
          orchestratorMessages={orchestratorMessages}
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
