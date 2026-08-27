/**
 * Simple in-memory metrics collector for the Loom deliberation engine.
 * Tracks LLM call counts, latency buckets, degradation events (via utils/degrade.js),
 * retry exhaustion, and circuit-breaker transitions. Only live, actively-written
 * fields are kept.
 */

const counters = {
  llm_calls_by_type: {},
  retry_events: {},
  breaker_events: {},
  degradation_events: {},
};

const latencies = {
  llm_prompt_ms: [],
  synthesis_ms: [],
};

/** Records a counter increment for a keyed sub-counter (e.g., llm_calls_by_type.agent). */
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
      llm_calls_by_type: { ...counters.llm_calls_by_type },
      retry_events: { ...counters.retry_events },
      breaker_events: { ...counters.breaker_events },
      degradation_events: { ...counters.degradation_events },
    },
    latencies: Object.fromEntries(
      Object.entries(latencies).map(([k, v]) => [k, latencyStats(v)])
    ),
    timestamp: new Date().toISOString(),
  };
}