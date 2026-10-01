/**
 * Persona ranking distance helpers.
 *
 * Kept in its own module with no runtime imports so both the Node composer and
 * the browser bundle can use it. Importing it from `./room.js` instead would
 * drag the ONNX embedder into the dashboard's client bundle.
 *
 * The composer scores personas with the L2-equivalent distance the vector
 * store returns: for normalized vectors, L2 = sqrt(2 * cosineDistance), so
 * cosine similarity is recovered as 1 - distance^2 / 2. Distance 0 is a perfect
 * match and distance sqrt(2) is orthogonal.
 */

/** Cosine similarity in [0,1] for a stored persona row. */
export function similarityOf(distance) {
  const d = Number(distance);
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, Math.min(1, 1 - (d * d) / 2));
}

/** Same value, rounded to a whole percent — for display only. */
export function similarityPercent(distance) {
  return Math.round(similarityOf(distance) * 100);
}