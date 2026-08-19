import { useMemo, memo } from "react";
import { cn } from "../utils.js";

export const ParticipationMatrix = memo(function ParticipationMatrix({ participants, contributions, agentErrors, rounds, activeRound }) {
  const roundData = useMemo(() => {
    const contribMap = new Map();
    for (const c of contributions) {
      contribMap.set(`${c.participant_id}:${c.round}`, true);
    }
    const errorMap = new Map();
    const errorRounds = new Set();
    for (const e of agentErrors) {
      if (!errorMap.has(`${e.participant_id}:${e.round}`)) {
        errorMap.set(`${e.participant_id}:${e.round}`, true);
      }
      errorRounds.add(e.round);
    }

    const reflectionMap = new Map();
    for (const c of contributions) {
      if (c.type === "reflection") {
        const key = `${c.participant_id}:${c.round}`;
        reflectionMap.set(key, (reflectionMap.get(key) || 0) + 1);
      }
    }

    const orderMap = new Map();
    for (let r = 1; r <= rounds; r++) {
      const roundContribs = contributions
        .filter((c) => c.round === r && c.type !== "reflection" && c.type !== "query_response" && c.type !== "evidence_response" && c.type !== "summoned_response" && c.type !== "vote_response" && c.type !== "vote_tally")
        .slice()
        .sort((a, b) =>
          (a.created_at || "").localeCompare(b.created_at || "") ||
          ((a.id ?? 0) - (b.id ?? 0))
        );
      roundContribs.forEach((c, i) => orderMap.set(`${c.participant_id}:${r}`, i + 1));
    }

    const data = [];
    for (let r = 1; r <= rounds; r++) {
      const row = {};
      for (const p of participants) {
        const key = `${p.id}:${r}`;
        const reflectionCount = reflectionMap.get(key) || 0;
        if (contribMap.has(key)) {
          row[p.id] = { status: "contributed", order: orderMap.get(key) || null, reflectionCount };
        } else if (errorMap.has(key)) {
          row[p.id] = { status: "error", order: null, reflectionCount };
        } else if (p.status === "passed") {
          row[p.id] = { status: "passed", order: null, reflectionCount };
        } else if (activeRound && r > activeRound) {
          row[p.id] = { status: "future", order: null, reflectionCount };
        } else {
          row[p.id] = { status: "none", order: null, reflectionCount };
        }
      }
      data.push({ round: r, participants: row });
    }
    return { data, errorRounds };
  }, [participants, contributions, agentErrors, rounds, activeRound]);

  if (rounds === 0 || participants.length === 0) return null;

  return (
    <div className="loom-card">
      <h3 className="loom-title-sm loom-mb-sm">Participation</h3>
      <div className="loom-matrix-scroll">
        <table className="loom-matrix">
          <caption className="sr-only">Agent participation by round</caption>
          <thead>
            <tr>
              <th className="loom-matrix-round-label">Round</th>
              {participants.map((p) => (
                <th key={p.id} className="loom-matrix-participant">
                  <span className="loom-matrix-participant-name">{p.name}</span>
                  <span className="loom-matrix-participant-tier">{p.tier}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roundData.data.map(({ round, participants: row }) => (
              <tr key={round} className={cn(roundData.errorRounds.has(round) && "loom-matrix-row-error")}>
                <td className="loom-matrix-round-label">R{round}</td>
                {participants.map((p) => {
                  const cell = row[p.id];
                  const status = cell?.status ?? "none";
                  const reflectionCount = cell?.reflectionCount ?? 0;
                  if (status === "contributed" && cell.order) {
                    return (
                      <td key={p.id} className="loom-matrix-cell">
                        <span
                          className="loom-matrix-number loom-matrix-contributed"
                          title={`Spoke ${cell.order} in round ${round}`}
                        >
                          {cell.order}
                        </span>
                        {reflectionCount > 0 && (
                          <span className="loom-matrix-reflection-badge" title={`${reflectionCount} reflection${reflectionCount !== 1 ? "s" : ""}`}>
                            {reflectionCount}↩
                          </span>
                        )}
                      </td>
                    );
                  }
                  return (
                    <td key={p.id} className="loom-matrix-cell">
                      <span className={cn("loom-matrix-dot", `loom-matrix-${status}`)} title={status} />
                      {reflectionCount > 0 && (
                        <span className="loom-matrix-reflection-badge" title={`${reflectionCount} reflection${reflectionCount !== 1 ? "s" : ""}`}>
                          {reflectionCount}↩
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="loom-matrix-legend">
        <span className="loom-matrix-legend-item"><span className="loom-matrix-number loom-matrix-contributed">1</span> Contributed (1st = first to speak)</span>
        <span className="loom-matrix-legend-item"><span className="loom-matrix-dot loom-matrix-error" /> Error</span>
        <span className="loom-matrix-legend-item"><span className="loom-matrix-dot loom-matrix-passed" /> Passed</span>
        <span className="loom-matrix-legend-item"><span className="loom-matrix-dot loom-matrix-none" /> Pending</span>
      </div>
    </div>
  );
});

export const ContributionTypeChart = memo(function ContributionTypeChart({ contributions }) {
  const data = useMemo(() => {
    const typeCounts = {};
    for (const c of contributions) {
      typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
    }
    const total = contributions.length;
    return Object.entries(typeCounts)
      .map(([type, count]) => ({ type, count, pct: total > 0 ? (count / total) * 100 : 0 }))
      .sort((a, b) => b.count - a.count);
  }, [contributions]);

  if (data.length === 0) return null;

  const maxCount = Math.max(...data.map((d) => d.count));
  const chartHeight = 60;
  const barWidth = 24;
  const gap = 8;

  return (
    <div className="loom-card">
      <h3 className="loom-title-sm loom-mb-sm">Contribution Types</h3>
      <div className="loom-type-chart">
        <svg
          viewBox={`0 0 ${data.length * (barWidth + gap) - gap} ${chartHeight + 20}`}
          preserveAspectRatio="xMidYMid meet"
          className="loom-type-svg"
          style={{ width: "100%", height: "auto", maxHeight: "80px" }}
        >
          {data.map((d, i) => {
            const barHeight = maxCount > 0 ? (d.count / maxCount) * chartHeight : 0;
            const x = i * (barWidth + gap);
            const y = chartHeight - barHeight;
            return (
              <g key={d.type}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={barHeight}
                  fill="var(--color-primary)"
                  rx="2"
                  opacity="0.85"
                />
                <text
                  x={x + barWidth / 2}
                  y={chartHeight + 12}
                  textAnchor="middle"
                  fontSize="8"
                  fill="var(--color-muted-foreground)"
                >
                  {d.type.slice(0, 5)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="loom-type-chart-legend">
        {data.map((d) => (
          <span key={d.type} className="loom-type-chart-legend-item">
            {d.type}: {d.count} ({Math.round(d.pct)}%)
          </span>
        ))}
      </div>
    </div>
  );
});

export const ContributionTimeline = memo(function ContributionTimeline({ contributions }) {
  const data = useMemo(() => {
    const roundCounts = {};
    for (const c of contributions) {
      roundCounts[c.round] = (roundCounts[c.round] || 0) + 1;
    }
    const rounds = Object.keys(roundCounts).map(Number).sort((a, b) => a - b);
    if (rounds.length < 2) return [];
    const maxCount = Math.max(...Object.values(roundCounts));
    return rounds.map((r) => ({ round: r, count: roundCounts[r], maxCount }));
  }, [contributions]);

  if (data.length < 2) return null;

  const chartHeight = 50;
  const chartWidth = 200;

  const points = data.map((d, i) => {
    const x = data.length > 1 ? (i / (data.length - 1)) * chartWidth : 0;
    const y = d.maxCount > 0 ? chartHeight - (d.count / d.maxCount) * chartHeight : chartHeight;
    return { x, y, ...d };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  return (
    <div className="loom-card">
      <h3 className="loom-title-sm loom-mb-sm">Activity Over Time</h3>
      <div className="loom-timeline-chart">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight + 10}`}
          preserveAspectRatio="xMidYMid meet"
          className="loom-timeline-svg"
          style={{ width: "100%", height: "auto", maxHeight: "60px" }}
        >
          <path
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth="2"
            d={linePath}
          />
          {points.map((p) => (
            <circle key={p.round} cx={p.x} cy={p.y} r="3" fill="var(--color-primary)" />
          ))}
        </svg>
        <div className="loom-timeline-chart-labels">
          <span>R{data[0].round}</span>
          <span>R{data[data.length - 1].round}</span>
        </div>
      </div>
    </div>
  );
});
