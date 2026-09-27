/**
 * Batched parallel fan-out helper — bounds provider bursts (e.g. 100 req/min)
 * while preserving request order with all-settled semantics.
 *
 * Usage: `await mapInBatches(items, fn, { batchSize: 5, delayMs: 3000, signal })`
 * returns an array aligned with `items` (never rejects; per-item `{ ok, value }`
 * or `{ ok: false, error }`).
 */

function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });
}

function isAborted(signal) {
  try {
    return !!(signal?.aborted);
  } catch {
    return false;
  }
}

/**
 * Derives the inter-batch delay from a per-minute budget.
 * @param {number} batchSize
 * @param {number} rpm - requests per minute budget
 * @returns {number} delay in ms between batches
 */
export function batchDelayForRpm(batchSize, rpm) {
  const b = Number(batchSize);
  const r = Number(rpm);
  if (!Number.isFinite(b) || b <= 0 || !Number.isFinite(r) || r <= 0) return 0;
  return Math.ceil((b / r) * 60000);
}

/**
 * Runs `fn` over `items` in sequential batches of `batchSize`, with `Promise.allSettled`
 * within each batch. Never rejects — failures surface per-item.
 * @template T,R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {{ batchSize?: number, delayMs?: number, signal?: AbortSignal|null }} opts
 * @returns {Promise<Array<{ ok: true, value: R }|{ ok: false, error: Error }>>}
 */
export async function mapInBatches(items, fn, { batchSize = 5, delayMs = 0, signal = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(batchSize) || 5));
  const delay = Math.max(0, Number(delayMs) || 0);
  const results = new Array(list.length);
  for (let start = 0; start < list.length; start += size) {
    if (isAborted(signal)) {
      const err = new DOMException("Aborted", "AbortError");
      for (let i = start; i < list.length; i++) results[i] = { ok: false, error: err };
      break;
    }
    const batch = list.slice(start, start + size);
    const settled = await Promise.allSettled(batch.map((item, offset) => fn(item, start + offset)));
    settled.forEach((s, offset) => {
      if (s.status === "fulfilled") {
        results[start + offset] = { ok: true, value: s.value };
      } else {
        const error = s.reason instanceof Error ? s.reason : new Error(String(s.reason ?? "fan-out failed"));
        results[start + offset] = { ok: false, error };
      }
    });
    const lastBatch = start + size >= list.length;
    if (delay > 0 && !lastBatch && !isAborted(signal)) {
      await sleep(delay);
    }
  }
  return results;
}
