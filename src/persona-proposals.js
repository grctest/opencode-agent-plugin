import { sanitizeForDisplay } from "./utils/sanitize.js";
import { extractAgentResponse } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";

const proposalsLogger = new Logger();

const MAX_PERSONAS = 12;
const PROPOSAL_TIMEOUT_MS = 120000;

/**
 * Post-synthesis persona proposals (T6): one bounded LLM call per meeting
 * reads the final artifact and proposes persona-file updates (anti_patterns /
 * known_biases additions) grounded in what actually happened. Output is a
 * human-readable review file — never auto-applied. Best-effort throughout:
 * a missed or malformed proposal run must not touch the meeting outcome.
 */

function personaCard(p) {
  const cfg = p?.config ?? p ?? {};
  const lines = [
    `- Name: ${sanitizeForDisplay(String(cfg.name ?? cfg.id ?? "unknown"), 80)}`,
    `  Category: ${sanitizeForDisplay(String(cfg.category ?? cfg.tier ?? ""), 20)}`,
    `  Persona: ${sanitizeForDisplay(String(cfg.persona ?? ""), 400).replace(/\n/g, " ")}`,
    `  Agenda: ${sanitizeForDisplay(String(cfg.agenda ?? ""), 300).replace(/\n/g, " ")}`,
  ];
  const biases = Array.isArray(cfg.known_biases) ? cfg.known_biases.filter(Boolean).slice(0, 4) : [];
  if (biases.length > 0) lines.push(`  Known biases: ${sanitizeForDisplay(biases.join("; "), 400)}`);
  const anti = Array.isArray(cfg.anti_patterns) ? cfg.anti_patterns.filter(Boolean).slice(0, 4) : [];
  if (anti.length > 0) lines.push(`  Anti-patterns: ${sanitizeForDisplay(anti.join("; "), 500)}`);
  return lines.join("\n");
}

export function buildPersonaProposalPrompt(participants, artifact) {
  const seats = (participants ?? []).slice(0, MAX_PERSONAS);
  const artifactText = sanitizeForDisplay(String(artifact?.content ?? artifact ?? ""), 12000);
  return `You review persona definitions after a deliberation. For each persona below, propose additions to its anti_patterns (at most 2) and known_biases (at most 1) — ONLY when this deliberation exposed a concrete failure: a repeated behavior that hurt the deliberation and is visible in the artifact (dissent, missed evidence, forced consensus, naked numbers, re-litigation).

Rules:
- Grounded-only: every proposal cites the artifact moment that justifies it ("seen when …"). No generic advice.
- Never propose removals or rewrites — additions only.
- A persona with nothing concrete to fix gets empty arrays, not filler.
- Keep each proposed string under 200 chars, lowercase continuation style ("assumes X", "may over-weight Y").

Personas:
${seats.map(personaCard).join("\n")}

Deliberation artifact:
${artifactText}

Respond with ONLY a JSON array, one object per persona that earned a proposal:
[{"name": "<exact persona name>", "anti_patterns_add": ["..."], "known_biases_add": ["..."], "rationale": "<artifact-grounded reason, 1-2 sentences>" }]
An empty array [] is a valid answer when nothing earned a proposal.`;
}

/** Extracts the first balanced JSON array (bracket-aware, string-literal safe). */
export function extractBalancedJsonArray(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function asStringArray(v, cap = 2) {
  const arr = Array.isArray(v) ? v : (typeof v === "string" && v ? [v] : []);
  return arr.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 200)).slice(0, cap);
}

/**
 * Parses and sanitizes a proposal response. Unknown personas, over-long
 * lists, and malformed entries are dropped — never repaired by guessing.
 */
export function parseProposalResponse(text, participants) {
  const raw = extractBalancedJsonArray(String(text ?? ""));
  if (!raw) return { proposals: [], parseError: "no JSON array found" };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { proposals: [], parseError: "JSON array did not parse" };
  }
  if (!Array.isArray(parsed)) return { proposals: [], parseError: "top level is not an array" };
  const known = new Set((participants ?? []).map((p) => p?.config?.name ?? p?.name).filter(Boolean));
  const proposals = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name : "";
    if (!name || !known.has(name)) continue;
    const anti = asStringArray(entry.anti_patterns_add, 2);
    const biases = asStringArray(entry.known_biases_add, 1);
    if (anti.length === 0 && biases.length === 0) continue;
    proposals.push({
      name,
      anti_patterns_add: anti,
      known_biases_add: biases,
      rationale: typeof entry.rationale === "string" ? entry.rationale.slice(0, 500) : "",
    });
  }
  return { proposals, parseError: null };
}

export function formatProposalFile({ meetingId, question, proposals, rawText, parseError }) {
  const lines = [
    `# Persona Proposals — meeting ${meetingId}`,
    "",
    `**Question:** ${sanitizeForDisplay(String(question ?? ""), 500)}`,
    "",
    "> Human review required. Nothing here is applied automatically: copy an",
    "> entry into the persona file, run the corpus lints, and commit.",
    "",
  ];
  if (parseError) {
    lines.push(`_The proposal call did not yield usable JSON (${parseError}) — raw output preserved below._`, "");
  }
  if (proposals.length === 0 && !parseError) {
    lines.push("No persona earned a proposal this meeting — nothing observed that warrants a file change.", "");
    return lines.join("\n");
  }
  for (const p of proposals) {
    lines.push(`## ${p.name}`, "");
    if (p.rationale) lines.push(`Rationale: ${p.rationale}`, "");
    for (const a of p.anti_patterns_add) {
      lines.push("```diff", `+ anti_patterns: "${a}"`, "```", "");
    }
    for (const b of p.known_biases_add) {
      lines.push("```diff", `+ known_biases: "${b}"`, "```", "");
    }
  }
  if (parseError && rawText) {
    lines.push("## Raw model output", "", "```", String(rawText).slice(0, 4000), "```", "");
  }
  return lines.join("\n");
}

/**
 * Runs the proposal pass: one bounded LLM call, file written beside the
 * meeting report. Returns the file path or null. Never throws.
 */
export async function generatePersonaProposals({ sessionManager, participants, artifact, model, meetingId, directory, question, writeFile }) {
  try {
    const seats = (participants ?? []).filter((p) => p?.status !== "failed");
    if (seats.length === 0 || !model?.providerID || !model?.modelID) return null;
    const prompt = buildPersonaProposalPrompt(seats, artifact);
    const res = await sessionManager.runEphemeralPrompt(
      { config: { id: "persona_reviewer", name: "Persona Reviewer" } },
      {
        system: "You review persona definitions after a deliberation. Respond with ONLY the requested JSON array.",
        model,
        parts: [{ type: "text", text: prompt }],
        tools: {},
        timeoutMs: PROPOSAL_TIMEOUT_MS,
      },
      meetingId ?? null,
    );
    if (!res?.ok) {
      proposalsLogger.warn("persona_proposals_failed", "Proposal call failed — skipping", extractErrorInfo(res?.error));
      return null;
    }
    const { text } = extractAgentResponse(res.data);
    const { proposals, parseError } = parseProposalResponse(text ?? "", seats);
    const file = formatProposalFile({ meetingId, question, proposals, rawText: text, parseError });
    try {
      const path = await writeFile(meetingId, file);
      if (path) proposalsLogger.info("persona_proposals_written", `Wrote ${proposals.length} persona proposal(s)`, { meetingId: String(meetingId).slice(0, 8) });
      return path;
    } catch (err) {
      proposalsLogger.warn("persona_proposals_write_failed", "Could not write proposal file", extractErrorInfo(err));
      return null;
    }
  } catch (err) {
    proposalsLogger.warn("persona_proposals_error", "Proposal pass failed — meeting outcome unaffected", extractErrorInfo(err));
    return null;
  }
}
