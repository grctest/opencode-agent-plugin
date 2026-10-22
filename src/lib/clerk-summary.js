/**
 * The round clerk's summary, parsed.
 *
 * The clerk's output format is fixed — `- **Established:** …`, `- **Settled:** …`,
 * `- **Contested:** …`, `- **Evidence:** …`, `- **Open:** …`, `- **Next:** …` —
 * so its account can be read structurally instead of as prose.
 *
 * This matters because prose prefixes cut the wrong part. The room received
 * the first 600 characters of a 4,000-6,500 character summary, and in the
 * recorded 10-round meeting that prefix contained only the `Established`
 * bullet: `Settled`, `Contested` and `Next` — the three lines that change what
 * an agent does next — never reached the participants who could act on them
 * (audit C). The same prefix, taken at 400 characters, is what the synthesis
 * digest carried for earlier rounds, so the synthesizer never saw the
 * orchestrator's judgement of what was contested either.
 *
 * Pure functions only — no I/O.
 */

const BULLET_RE = /^\s*[-*]?\s*\*\*([A-Za-z][A-Za-z/ ]{0,20}):\*\*\s*(.*)$/;
const LABELS = ["established", "settled", "contested", "evidence", "open", "next", "code"];

/**
 * @param {string} summary the clerk's summary markdown
 * @returns {{established: string[], settled: string[], contested: string[], evidence: string[], open: string[], next: string[], code: string[]}}
 */
export function extractClerkBullets(summary) {
  const out = { established: [], settled: [], contested: [], evidence: [], open: [], next: [], code: [] };
  const text = String(summary ?? "");
  if (!text.trim()) return out;
  for (const line of text.split("\n")) {
    const m = BULLET_RE.exec(line);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const body = m[2].trim();
    if (!body) continue;
    if (key === "code" || key.startsWith("code/")) out.code.push(body);
    else if (LABELS.includes(key)) out[key].push(body);
  }
  return out;
}

/**
 * The three bullets the room can act on: what is settled (build on it), what
 * is contested (engage it), and what this round must produce (do it).
 *
 * @param {string} summary the clerk's summary markdown
 * @param {{maxChars?: number}} [opts]
 * @returns {string} the account text, or the raw summary when it has no
 *   parseable bullets (so an unexpected format degrades to "the whole thing")
 */
export function renderClerkAccount(summary, { maxChars = 2400 } = {}) {
  const bullets = extractClerkBullets(summary);
  const lines = [];
  for (const [key, label] of [["settled", "Settled"], ["contested", "Contested"], ["next", "Next"]]) {
    for (const body of bullets[key]) lines.push(`**${label}:** ${body}`);
  }
  if (lines.length === 0) return String(summary ?? "").slice(0, maxChars);
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

/**
 * The same three bullets as a compact one-line-per-bullet digest, for the
 * synthesis transcript's earlier rounds (where a full summary does not fit but
 * the orchestrator's judgement must still reach the synthesizer).
 *
 * @param {string} summary the clerk's summary markdown
 * @param {{maxChars?: number}} [opts]
 * @returns {string}
 */
export function renderClerkDigest(summary, { maxChars = 900 } = {}) {
  const bullets = extractClerkBullets(summary);
  const parts = [];
  for (const [key, label] of [["settled", "Settled"], ["contested", "Contested"], ["next", "Next"]]) {
    const body = bullets[key].join(" ").trim();
    if (body) parts.push(`${label}: ${body}`);
  }
  if (parts.length === 0) return String(summary ?? "").slice(0, maxChars);
  const text = parts.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}
