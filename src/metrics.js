/**
 * Simple in-memory metrics collector for the Loom deliberation engine.
 * Tracks LLM call counts, latencies, contribution stats, and meeting gauges.
 */

const counters = {
  llm_calls_by_type: {},
  llm_errors_by_type: {},
  contributions_by_type: {},
  turn_requests_granted: 0,
  turn_requests_denied: 0,
  reflections_generated: 0,
  convergence_checks: 0,
  syntheses_completed: 0,
  syntheses_failed: 0,
  meetings_started: 0,
  meetings_completed: 0,
  meetings_failed: 0,
  session_recreations: 0,
  input_tokens: 0,
  output_tokens: 0,
};

const latencies = {
  llm_prompt_ms: [],
  reflection_ms: [],
  synthesis_ms: [],
};

const gauges = {
  active_meetings: 0,
  active_sessions: 0,
};

/** Records a counter increment. */
export function incrementCounter(name, amount = 1) {
  if (typeof counters[name] === 'number') {
    counters[name] += amount;
  }
}

/** Records a counter increment for a keyed sub-counter (e.g., llm_calls_by_type.orchestrator). */
export function incrementKeyedCounter(category, key, amount = 1) {
  if (counters[category]) {
    counters[category][key] = (counters[category][key] ?? 0) + amount;
  }
}

/** Records a latency sample (in milliseconds). Keeps last 100 samples per bucket. */
export function recordLatency(bucket, ms) {
  if (!latencies[bucket]) return;
  latencies[bucket].push(ms);
  if (latencies[bucket].length > 100) {
    latencies[bucket].shift();
  }
}

/** Sets a gauge value. */
export function setGauge(name, value) {
  gauges[name] = value;
}

/** Increments a gauge. */
export function incrementGauge(name, amount = 1) {
  gauges[name] = (gauges[name] ?? 0) + amount;
}

/** Decrements a gauge. */
export function decrementGauge(name, amount = 1) {
  gauges[name] = Math.max(0, (gauges[name] ?? 0) - amount);
}

/** Records token usage. */
export function recordTokens(input, output) {
  counters.input_tokens += input ?? 0;
  counters.output_tokens += output ?? 0;
}

/** Computes summary stats for a latency bucket. */
function latencyStats(samples) {
  if (samples.length === 0) return { count: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    avg: Math.round(sum / sorted.length),
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted[sorted.length - 1],
  };
}

/** Returns a snapshot of all current metrics. */
export function getMetricsSnapshot() {
  return {
    counters: {
      ...counters,
      llm_calls_by_type: { ...counters.llm_calls_by_type },
      llm_errors_by_type: { ...counters.llm_errors_by_type },
      contributions_by_type: { ...counters.contributions_by_type },
    },
    latencies: Object.fromEntries(
      Object.entries(latencies).map(([k, v]) => [k, latencyStats(v)])
    ),
    gauges: { ...gauges },
    timestamp: new Date().toISOString(),
  };
}

/** Resets all metrics (for testing). */
export function resetMetrics() {
  for (const key of Object.keys(counters)) {
    if (typeof counters[key] === 'number') {
      counters[key] = 0;
    } else {
      counters[key] = {};
    }
  }
  for (const key of Object.keys(latencies)) {
    latencies[key] = [];
  }
  for (const key of Object.keys(gauges)) {
    gauges[key] = 0;
  }
}
