/**
 * List-height arithmetic for the auto-select dialog, kept in a plain .js
 * module so it can be unit tested (node:test cannot import .jsx).
 *
 * react-window needs a pixel height, so the dialog measures its wrapper and
 * feeds that back as the list's height. That number must be an idempotent,
 * floored function of what was measured — otherwise the measure/render loop
 * drifts downward every time the list unmounts and never recovers. (The other
 * half of the fix is CSS-side: a fixed dialog height keeps the wrapper's
 * height content-independent. Neither half suffices alone.)
 */

/** Minimum list height in px — enough to read as a list, not a sliver. */
export const MIN_LIST_HEIGHT = 220;

/**
 * @param {number} measuredHeight wrapper clientHeight, in px
 * @returns {number} px, never below MIN_LIST_HEIGHT, never 0 (0 means
 * "not measured yet" and gates rendering the list)
 */
export function resolveListHeight(measuredHeight) {
  if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return MIN_LIST_HEIGHT;
  return Math.max(MIN_LIST_HEIGHT, Math.round(measuredHeight));
}
