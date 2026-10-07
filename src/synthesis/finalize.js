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

  const missingSections = validateSynthesisSections(finalOutput);
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
  const unsupportedCitations = checkCitationSupport(finalOutput, weave, { minTargetChars: policy.minCitationTargetChars });
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
    engagement: computeEngagementMetrics(weave, finalOutput),
  };

  return { artifact, output: finalOutput };
}
