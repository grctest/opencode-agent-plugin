import { TERMINAL_STATUSES } from "../constants.js";

/**
 * Bounded registry for live meeting engines (`activeLooms`).
 *
 * The dashboard is single-flight (409 while one runs), so this map is
 * normally ≤1 entry — the bound is defense-in-depth against litter (a crash
 * between register and the finally-delete) and any future concurrent use.
 *
 * Eviction never discards live Σ: only TERMINAL engines are evicted (their
 * state is already durable in their DB), and a registry full of live engines
 * refuses the new registration instead of growing. Discarding a live engine
 * would violate the sufficient-statistic assumption (paper §7: everything the
 * future needs must survive in state).
 */

export const MAX_ACTIVE_LOOMS = 32;

function engineStatus(engine) {
  try {
    const s = engine?.getState?.()?.status ?? engine?.getStateManager?.()?.getStatus?.();
    return typeof s === "string" ? s : null;
  } catch {
    return null;
  }
}

function isTerminalEngine(engine) {
  const status = engineStatus(engine);
  return status !== null && TERMINAL_STATUSES.has(status);
}

/**
 * Register an engine, evicting the oldest terminal entry first when at cap.
 * @returns {boolean} true when registered; false when the registry is full of
 *   live engines (caller must refuse — never evict live Σ).
 */
export function registerMeetingEngine(activeLooms, meetingId, engine, { max = MAX_ACTIVE_LOOMS, logger = null } = {}) {
  if (activeLooms.has(meetingId)) {
    activeLooms.set(meetingId, engine);
    return true;
  }
  while (activeLooms.size >= max) {
    let evicted = false;
    for (const [id, existing] of activeLooms) {
      if (!isTerminalEngine(existing)) continue;
      try {
        const r = existing.close?.();
        if (r && typeof r.catch === "function") r.catch(() => {});
      } catch {}
      activeLooms.delete(id);
      try { logger?.warn?.("engine_registry_evict", `Evicted terminal engine ${id} to make room for ${meetingId}`); } catch {}
      evicted = true;
      break;
    }
    if (!evicted) {
      try { logger?.warn?.("engine_registry_full", `Refusing ${meetingId}: ${activeLooms.size} live engines at cap ${max}`); } catch {}
      return false;
    }
  }
  activeLooms.set(meetingId, engine);
  return true;
}
