/**
 * Final artifact assembly: grounding checks, detectors, reconciliation,
 * confidence roll-up. Detector sections ship only when explicitly enabled.
 */
import { parseSplitConfidence, rollupConfidence } from "../utils/confidence.js";
import { getConfig } from "../config.js";
import { incrementKeyedCounter } from "../metrics.js";
import { computeEngagementMetrics } from "../round-summarizer.js";
import {
  deriveConfidence,
  deriveSplitConfidence,
  parseConfidence,
  findStraddlingBands,
} from "./confidence.js";
import {
  supplementMissingSections,
  validateSynthesisSections,
  extractSection,
  normalizeVecTraces,
} from "./sections.js";
import { reconcileNumericalConflicts } from "./reconciliation.js";
import { checkCitationSupport, CITATION_MIN_TARGET_CHARS } from "./citations.js";

/**
 * The reference index — finalize's human-resolvability pass.
 *
 * The artifact cites contributions as [#N] because that is how the deliberation
 * cites: agents cite peers, the clerk names holders, the citation checks parse
 * the ids. But a bare id resolves only for the pipeline — a human reading the
 * artifact sees [#2][#4][#7] and nothing to resolve them against. The synthesis
 * prompt (rule 1b) teaches a ## References index with the participant's name
 * and a one-line gist per id; this pass makes the guarantee deterministic:
 *
 *   - every id cited in the final output that the index does not already
 *     cover is backfilled with a mechanical line — name, round, first ~120
 *     characters of the cited contribution — in the codebase's own deterministic
 *     repair style (audit F's repairInventedHandoffs, the appended Refusals);
 *   - no LLM call, so it cannot invent a gist, a name, or a round;
 *
 * Returns the text with the index guaranteed present.
 */
const REFERENCE_EXCERPT_CHARS = 120;

function locateReferenceSection(text) {
  const lines = String(text).split("\n");
  const start = lines.findIndex((l) => /^#{2,}\s*References\b/i.test(l.trim()));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,}\s/.test(lines[i].trim())) { end = i; break; }
  }
  return { start, end, lines };
}

/**
 * The reference index is a map, not evidence — its body carries no claims of
 * its own, so its ids must not enter the citation-support scan as candidates
 * (a paraphrased gist over zero shared keywords would mis-count the same id
 * as "unsupported" the body already supported).
 */
function stripReferenceIndex(text) {
  const section = locateReferenceSection(text);
  if (!section) return text;
  return [...section.lines.slice(0, section.start + 1), ...section.lines.slice(section.end)].join("\n");
}

function collectCitedRefs(text) {
  const contribution = new Set();
  for (const m of String(text).matchAll(/\[#(\d+)\]/g)) contribution.add(m[1]);
  return [...contribution].sort((a, b) => Number(a) - Number(b));
}

function ensureReferenceIndex(finalOutput, weave, participants, opts = {}) {
  const citedIds = collectCitedRefs(finalOutput);
  const section = locateReferenceSection(finalOutput);
  if (citedIds.length === 0) {
    // Nothing cited: the contract still guarantees the section, so it exists
    // stating that rather than triggering a "did not generate" repair note.
    if (section) return finalOutput;
    return `${finalOutput}\n\n## References\nNone — the artifact cites no contribution ids.\n`;
  }
  // The index must be one contiguous section: "## References" at the top and
  // the next heading close it. The synthesizer's own entries are preserved —
  // only ids it missed get mechanical lines appended inside it. Coverage is
  // measured against the INDEX BODY ONLY: when no section exists, nothing is
  // covered — scanning the artifact text would let a citation "cover" itself.
  const indexedText = section
    ? section.lines.slice(section.start + 1, section.end).join("\n")
    : "";
  const coveredIds = new Set([...indexedText.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]));

  const participantsById = new Map(
    (participants ?? []).map((p) => [String(p?.config?.id ?? ""), p?.config?.name ?? p?.config?.id]),
  );
  const contributionByRound = opts?.roundOf ?? null;

  const roundLabelFor = (id) => {
    const round = contributionByRound?.get?.(String(id));
    return Number.isFinite(Number(round)) && round !== null ? `Round ${round}` : "round unknown";
  };
  const excerptFor = (id) => {
    const c = weave.find((w) => String(w.id) === String(id));
    if (!c) return "cited contribution";
    const raw = String(c.content ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return "(empty contribution)";
    return raw.length <= REFERENCE_EXCERPT_CHARS ? raw : `${raw.slice(0, REFERENCE_EXCERPT_CHARS).trimEnd()}…`;
  };

  const backfilled = [];
  for (const id of citedIds) {
    if (coveredIds.has(id)) continue;
    const c = weave.find((w) => String(w.id) === String(id));
    const name = (c && participantsById.get(String(c.participant_id))) ?? c?.participant_id ?? "unknown participant";
    backfilled.push(`- [#${id}] — ${name}, ${roundLabelFor(id)} — "${excerptFor(id)}"`);
  }

  const body = [...backfilled].join("\n");
  if (!body) return finalOutput;
  if (section) {
    const insertAt = section.end;
    section.lines.splice(insertAt, 0, body);
    return section.lines.join("\n");
  }
  const heading = "\n\n## References\n_Mechanically backfilled — the synthesizer did not list these ids (rule 1b)._\n";
  return `${finalOutput}${heading}${body}\n`;
}

export function resolveDetectorPolicy(overrides) {
  let configured = {};
  try { configured = getConfig()?.detectors ?? {}; } catch {}
  const cfg = { ...configured, ...(overrides ?? {}) };
  const enabled = (name) => cfg[name] === true;
  return {
    needsVerification: enabled("needsVerification"),
    citationWarnings: enabled("citationWarnings"),
    dryRun: cfg.dryRun !== false,
    dryRunMeetings: Number(cfg.dryRunMeetings) || 2,
    precisionFloor: Number(cfg.precisionFloor) || 0.9,
    minCitationTargetChars: Number.isFinite(Number(cfg.minCitationTargetChars)) ? Number(cfg.minCitationTargetChars) : CITATION_MIN_TARGET_CHARS,
  };
}

/**
 * Repairs invented handoff targets.
 *
 * The synthesis prompt forbids "@handle" placeholders — and its OWN TEMPLATE
 * used to offer one ("proposed: X → handoff to @role"), so two of the three
 * recorded artifacts shipped targets that do not exist (@technical-analysis,
 * @trackside-ops, @systems_engineer_6). The repair is deterministic and
 * narrow: only action-item lines (a "- " bullet that names an owner or a
 * handoff) are touched, and only the handle is replaced — with the rule's own
 * form. No LLM call, no false positives (audit F).
 */
function repairInventedHandoffs(text, participants) {
  const known = new Set(
    (participants ?? [])
      .map((p) => String(p?.config?.name ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (!text || !text.includes("@")) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!/^\s*-\s/.test(line)) return line;
      if (!/owner:|handoff to/i.test(line)) return line;
      if (!/@[A-Za-z]/.test(line)) return line;
      return line.replace(/@([A-Za-z][\w-]*)/g, (m, handle) => {
        const cleaned = handle.toLowerCase();
        if (known.has(cleaned) || known.has(cleaned.replace(/[_-]/g, " "))) return m;
        return "a participant with domain Y";
      });
    })
    .join("\n");
}

export function finalizeSynthesis(artifactText, transcriptData, participants, opts = {}) {
  const policy = resolveDetectorPolicy(opts.detectors);
  const shipNeedsVerification = policy.needsVerification && !policy.dryRun;
  const shipCitationWarnings = policy.citationWarnings && !policy.dryRun;
  const detectorReport = {
    policy,
    needsVerification: { candidates: 0, shipped: false },
    citationWarnings: { candidates: 0, shipped: false },
  };
  artifactText = normalizeVecTraces(artifactText);
  // Invented handoff targets are repaired before anything else reads the text
  // (the citation and section checks see the repaired version).
  artifactText = repairInventedHandoffs(artifactText, participants);
  const weave = transcriptData.rounds.flatMap((r) => r.contributions);
  const refusals = weave.filter((c) => c.type === "refuse");
  const refusalsText = refusals.map((r) => {
    const p = participants.find((pp) => pp.config.id === r.participant_id);
    return `${p?.config.name ?? r.participant_id}: ${r.content}`;
  }).join("\n");

  let finalOutput = artifactText;

  if (refusalsText) {
    finalOutput = `${finalOutput}\n\n## Refusals\n${refusalsText}`;
  }

  // The reference index runs before section validation, so the contract sees
  // the guaranteed section rather than a note about one it then repairs.
  // The id→round map is built once from the rounds; the synthesizer's own
  // entries are preserved verbatim — only ids it missed get mechanical lines.
  const roundOf = new Map(
    (transcriptData.rounds ?? []).flatMap((r, i) =>
      (r.contributions ?? []).map((c) => [String(c.id), Number.isFinite(Number(r.number)) ? Number(r.number) : i + 1]),
    ),
  );
  finalOutput = ensureReferenceIndex(finalOutput, weave, participants, { roundOf });

  // Style-aware: the "Decision Rule" requirement is only checked for the
  // decision_oriented style, and dropping the style here let an artifact
  // without the rule pass the final check (audit B4).
  const missingSections = validateSynthesisSections(finalOutput, opts.synthesisStyle ?? null);
  if (missingSections.length > 0) {
    finalOutput = supplementMissingSections(finalOutput, missingSections);
  }

  const weaveIds = new Set(weave.map((c) => String(c.id)));
  const sectionHasValidCite = (lines) => {
    let inFence = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const cites = [...line.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]);
      if (cites.some((id) => weaveIds.has(id))) return true;
    }
    return false;
  };
  const ungroundedLines = (lines) => lines.filter((line) => {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) return false;
    if (/synthesized from/i.test(trimmed)) return false;
    const cites = [...trimmed.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]);
    return cites.length === 0 || cites.every((id) => !weaveIds.has(id));
  });
  const decisions = extractSection(finalOutput, "Decision");
  const hasExecutive = new RegExp(`^#{2,}\\s*Executive Summary\\b`, "im").test(finalOutput);
  const decisionHasValidCite = sectionHasValidCite(decisions);
  const reasoning = extractSection(finalOutput, "Reasoning");
  const reasoningHasValidCite = sectionHasValidCite(reasoning);
  const overallGrounded = decisionHasValidCite || (hasExecutive && reasoningHasValidCite);
  const needsVerificationBodies = [];
  if (!overallGrounded && decisions.length > 0) {
    const ungrounded = ungroundedLines(decisions);
    if (ungrounded.length === decisions.length) {
      needsVerificationBodies.push(`## Needs Verification\nThe Decision section lacks a valid [#id] citation to the transcript and should be verified before acting. Consider checking State of Play or transcript.\n${ungrounded.slice(0, 5).map((l) => `- ${l.slice(0, 200)}`).join("\n")}`);
    }
  }
  const actionItems = extractSection(finalOutput, "Action Items");
  if (overallGrounded && actionItems.length > 0 && !sectionHasValidCite(actionItems)) {
    const ungroundedActions = ungroundedLines(actionItems);
    if (ungroundedActions.length === actionItems.length) {
      needsVerificationBodies.push(`## Needs Verification\nThe Action Items below cite no valid [#id] from the transcript — they assign work, so verify ownership and basis before acting.\n${ungroundedActions.slice(0, 5).map((l) => `- ${l.slice(0, 200)}`).join("\n")}`);
    }
  }
  const reasoningUngrounded = ungroundedLines(reasoning);
  if (reasoning.length > 0 && reasoningUngrounded.length === reasoning.length && !reasoningHasValidCite) {
    needsVerificationBodies.push(`## Needs Verification\nThe Reasoning section carries no valid [#id] citation to the transcript (and no “synthesized from” marker) — verify each claim against the transcript before acting.\n${reasoningUngrounded.slice(0, 5).map((l) => `- ${l.slice(0, 200)}`).join("\n")}`);
  }
  const unsupportedCitations = checkCitationSupport(stripReferenceIndex(finalOutput), weave, { minTargetChars: policy.minCitationTargetChars });
  detectorReport.citationWarnings.candidates = unsupportedCitations.length;
  if (unsupportedCitations.length > 0 && shipCitationWarnings) {
    detectorReport.citationWarnings.shipped = true;
    finalOutput += `\n\n## Citation Warnings\nThe following [#id] citations do not resolve to a contribution that supports the cited claim — verify before acting:\n${unsupportedCitations.slice(0, 5).map((u) => `- [#${u.id}] — ${u.sentence}`).join("\n")}`;
  }

  const reconciliation = reconcileNumericalConflicts(weave);
  const versionedConflicts = reconciliation.conflicts.filter((c) => c.status === "versioned");
  if (versionedConflicts.length > 0) {
    const lines = versionedConflicts.map((c) => {
      const v1 = c.versions[0];
      const v2 = c.versions[1];
      const unit = c.unit ? ` ${c.unit}` : "";
      const label = c.label ? `${c.quantity} (${c.label})` : c.quantity;
      return `- ${label}: v1 = ${v1.value}${unit} [#${v1.contributionId}] vs v2 = ${v2.value}${unit} [#${v2.contributionId}] — ${c.reconciliationRule} (falsifier: ${c.falsifier.method} — ${c.falsifier.detail})`;
    });
    needsVerificationBodies.push(`## Needs Verification\n${reconciliation.versionedCount} numerical conflict(s) are stated with competing values — versioned here with reconciliation rules; cite the latest version:\n${lines.join("\n")}\n`);
  }

  const straddlingBands = findStraddlingBands(finalOutput);
  if (straddlingBands.length > 0) {
    const bandList = straddlingBands.map((s) => `${s.band[0]}–${s.band[1]} vs threshold ${s.threshold}`).join(", ");
    needsVerificationBodies.push(`## Needs Verification\nThe numeric band(s) ${bandList} straddle the decision threshold — degrade to threshold analysis (state the band and what evidence would move it) instead of a point estimate.\n`);
  }
  detectorReport.needsVerification.candidates = needsVerificationBodies.length;
  if (needsVerificationBodies.length > 0 && shipNeedsVerification) {
    detectorReport.needsVerification.shipped = true;
    for (const body of needsVerificationBodies) finalOutput += `\n\n${body}`;
  }
  if (policy.dryRun) {
    try {
      for (const [name, report] of Object.entries(detectorReport)) {
        if (name === "policy") continue;
        if (report.candidates > 0) {
          incrementKeyedCounter("detector_dry_run", `${name}:${report.candidates}`);
        }
      }
    } catch { /* counters are best-effort */ }
  }

  const parsedConfidence = parseConfidence(finalOutput);
  const activeParticipants = participants.filter((p) => p.status !== "failed").length;
  const heuristicConfidence = deriveConfidence(weave, participants.length, activeParticipants);
  const rankConfidence = (c) => ({ high: 2, medium: 1, low: 0 })[String(c ?? "").toLowerCase()] ?? -1;
  let confidence = heuristicConfidence;
  if (parsedConfidence && rankConfidence(parsedConfidence) >= 0 && rankConfidence(heuristicConfidence) >= 0) {
    confidence = rankConfidence(parsedConfidence) - rankConfidence(heuristicConfidence) > 1
      ? heuristicConfidence
      : parsedConfidence;
  }

  const { confidence_name, confidence_number } = deriveSplitConfidence(weave, participants.length, activeParticipants);
  const proseSplit = parseSplitConfidence(finalOutput);
  const splitName = proseSplit.name ?? confidence_name;
  const splitNumber = proseSplit.number ?? confidence_number;
  const rolledUp = rollupConfidence(splitName, splitNumber);

  const artifact = {
    content: finalOutput,
    format: "markdown",
    decisions: extractSection(finalOutput, "Decision"),
    action_items: extractSection(finalOutput, "Action Items"),
    proposed_fix: extractSection(finalOutput, "Proposed Fix"),
    files_involved: extractSection(finalOutput, "Files Involved"),
    refusals: refusals.map((r) => ({
      participant_id: r.participant_id,
      content: r.content,
    })),
    open_questions: extractSection(finalOutput, "Open Questions"),
    dissenting_views: extractSection(finalOutput, "Dissenting Views"),
    confidence: rolledUp ?? confidence,
    confidence_name: splitName ?? null,
    confidence_number: splitNumber ?? null,
    confidence_reported: parsedConfidence,
    confidence_derived: heuristicConfidence,
    reconciliation: {
      resolvedCount: reconciliation.resolvedCount,
      versionedCount: reconciliation.versionedCount,
      reserveRoundRecommended: reconciliation.reserveRoundRecommended,
      reserveRoundReason: reconciliation.reserveRoundReason,
      conflicts: reconciliation.conflicts.map((c) => ({
        quantity: c.quantity,
        label: c.label ?? null,
        unit: c.unit,
        values: c.values,
        status: c.status,
        resolution: c.resolution,
        versions: c.versions,
        reconciliationRule: c.reconciliationRule,
        falsifier: c.falsifier,
      })),
    },
    detector_report: detectorReport,
    // Coverage measures the artifact's BODY engagement, not its appendix: a
    // mechanically backfilled index line is not the same as citing the peer.
    engagement: computeEngagementMetrics(weave, stripReferenceIndex(finalOutput)),
  };

  return { artifact, output: finalOutput };
}
