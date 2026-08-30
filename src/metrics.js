import { TUNING } from "./config/defaults.js";
import { getConfig } from "./config.js";
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

// Circular buffers per latency bucket — O(1) push
const latencyBuffers = {
  llm_prompt_ms: { buf: new Array(TUNING.LATENCY_SAMPLE_LIMIT), head: 0, count: 0 },
  synthesis_ms: { buf: new Array(TUNING.LATENCY_SAMPLE_LIMIT), head: 0, count: 0 },
};
const latencies = latencyBuffers;

/** Records a counter increment for a keyed sub-counter (e.g., llm_calls_by_type.agent). */
export function incrementKeyedCounter(category, key, amount = 1) {
  if (counters[category]) {
    counters[category][key] = (counters[category][key] ?? 0) + amount;
  }
}

function getLatencyCap() { try { return getConfig()?.tuning?.LATENCY_SAMPLE_LIMIT ?? TUNING.LATENCY_SAMPLE_LIMIT; } catch { return TUNING.LATENCY_SAMPLE_LIMIT; } }
function ensureLatencyBuffer(bucket) {
  if (!latencyBuffers[bucket]) latencyBuffers[bucket] = { buf: new Array(getLatencyCap()), head: 0, count: 0 };
  const cap = getLatencyCap();
  const b = latencyBuffers[bucket];
  if (b.buf.length !== cap) {
    // Resize preserving order
    const ordered = [];
    for (let i = 0; i < b.count; i++) ordered.push(b.buf[(b.head - b.count + i + b.buf.length) % b.buf.length] ?? b.buf[(b.head + i) % b.buf.length]);
    // Simpler: collect via helper
    const vals = getLatencyValues(bucket);
    b.buf = new Array(cap);
    b.head = 0;
    b.count = 0;
    for (const v of vals.slice(-cap)) { b.buf[b.head] = v; b.head = (b.head+1)%cap; if (b.count<cap) b.count++; }
  }
  return b;
}
function getLatencyValues(bucket) {
  const b = latencyBuffers[bucket];
  if (!b || b.count===0) return [];
  const cap = b.buf.length;
  const out = [];
  const start = b.count < cap ? 0 : b.head;
  for (let i=0;i<b.count;i++) out.push(b.buf[(start+i)%cap]);
  return out;
}
/** Records a latency sample (in milliseconds). Keeps last N samples per bucket (tunable) — O(1). */
export function recordLatency(bucket, ms) {
  const b = ensureLatencyBuffer(bucket);
  if (!b) return;
  const cap = getLatencyCap();
  b.buf[b.head] = ms;
  b.head = (b.head + 1) % cap;
  if (b.count < cap) b.count++;
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
      Object.entries(latencyBuffers).map(([k, _]) => [k, latencyStats(getLatencyValues(k))])
    ),
    timestamp: new Date().toISOString(),
  };
}