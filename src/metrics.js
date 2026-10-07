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
  // N6 — meeting_degraded_reasons: a named, countable reason a meeting ran
  // degraded. Liveness and health were conflated: a run where a third of state
  // writes were rejected reported `agent_errors: 0` and 100% of tool_audit
  // rows `completed`. These reasons are recorded at the point of refusal, where
  // the information actually exists.
  meeting_degraded_reasons: {},
};

// meetingId -> Set<reason>, so a meeting's health travels with its row rather
// than with the process.
const degradedReasonsByMeeting = new Map();

/**
 * N6 — record that a meeting ran degraded for a named reason. Call this at the
 * point of refusal, never inferred from prose after the fact.
 * @param {string} meetingId
 * @param {string} reason stable key, e.g. "state_patch_rejected"
 * @param {number} [count=1]
 */
export function recordMeetingDegradedReason(meetingId, reason, count = 1) {
  if (!meetingId || !reason) return;
  if (!degradedReasonsByMeeting.has(meetingId)) degradedReasonsByMeeting.set(meetingId, new Set());
  degradedReasonsByMeeting.get(meetingId).add(reason);
  incrementKeyedCounter("meeting_degraded_reasons", reason, count);
}

/** The named reasons a meeting ran degraded, sorted for stable output. */
export function getMeetingDegradedReasons(meetingId) {
  return [...(degradedReasonsByMeeting.get(meetingId) ?? [])].sort();
}

/** Drops a meeting's degraded-reason set (meeting deleted). */
export function clearMeetingDegradedReasons(meetingId) {
  degradedReasonsByMeeting.delete(meetingId);
}

// Circular buffers per latency bucket — O(1) push
const latencyBuffers = {
  llm_prompt_ms: { buf: new Array(TUNING.LATENCY_SAMPLE_LIMIT), head: 0, count: 0 },
  synthesis_ms: { buf: new Array(TUNING.LATENCY_SAMPLE_LIMIT), head: 0, count: 0 },
};

/** Records a counter increment for a keyed sub-counter (e.g., llm_calls_by_type.agent). */
export function incrementKeyedCounter(category, key, amount = 1) {
  if (counters[category]) {
    counters[category][key] = (counters[category][key] ?? 0) + amount;
  }
}

// Per-meeting call/latency breakdown (T1): the process-global buckets above
// mix meetings together, so a per-meeting report cannot be derived from them.
// These maps attribute each LLM call to its meeting at the point of the call.
// meetingId -> { type -> count }
const meetingCalls = new Map();
// meetingId -> Map<bucket, { sum, count, max }>
const meetingLatencies = new Map();

/**
 * Records one LLM call of a given type against a meeting. Best-effort and
 * additive: never throws, never affects the call itself.
 * @param {string} meetingId
 * @param {string} type e.g. "agent", "agent_synthesis", "patch_tail", "turn_order", "summary", "synthesis"
 * @param {number} [amount=1]
 */
export function recordMeetingCall(meetingId, type, amount = 1) {
  try {
    if (!meetingId || !type) return;
    let entry = meetingCalls.get(meetingId);
    if (!entry) { entry = {}; meetingCalls.set(meetingId, entry); }
    entry[type] = (entry[type] ?? 0) + amount;
  } catch { /* telemetry must never break a turn */ }
}

/**
 * Records a latency sample (ms) against a meeting.
 * @param {string} meetingId
 * @param {string} bucket e.g. "llm_prompt_ms", "llm_synthesis_ms", "llm_patch_tail_ms", "turn_order_ms", "summary_ms", "synthesis_ms"
 * @param {number} ms
 */
export function recordMeetingLatency(meetingId, bucket, ms) {
  try {
    if (!meetingId || !bucket || !Number.isFinite(ms)) return;
    let entry = meetingLatencies.get(meetingId);
    if (!entry) { entry = new Map(); meetingLatencies.set(meetingId, entry); }
    let agg = entry.get(bucket);
    if (!agg) { agg = { sum: 0, count: 0, max: 0 }; entry.set(bucket, agg); }
    agg.sum += ms;
    agg.count += 1;
    if (ms > agg.max) agg.max = ms;
  } catch { /* telemetry must never break a turn */ }
}

/**
 * Per-meeting latency/call breakdown for reports and the meeting-metrics row.
 * @param {string} meetingId
 * @returns {{ calls: Record<string, number>, latencies: Record<string, {count:number, avg:number, max:number}> }}
 */
export function getMeetingBreakdown(meetingId) {
  const calls = { ...(meetingCalls.get(meetingId) ?? {}) };
  const latencies = {};
  for (const [bucket, agg] of (meetingLatencies.get(meetingId) ?? new Map()).entries()) {
    latencies[bucket] = {
      count: agg.count,
      avg: agg.count > 0 ? Math.round(agg.sum / agg.count) : 0,
      max: agg.max,
    };
  }
  return { calls, latencies };
}

/** Drops a meeting's breakdown (meeting deleted). */
export function clearMeetingBreakdown(meetingId) {
  meetingCalls.delete(meetingId);
  meetingLatencies.delete(meetingId);
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
      meeting_degraded_reasons: { ...counters.meeting_degraded_reasons },
    },
    latencies: Object.fromEntries(
      Object.entries(latencyBuffers).map(([k, _]) => [k, latencyStats(getLatencyValues(k))])
    ),
    timestamp: new Date().toISOString(),
  };
}