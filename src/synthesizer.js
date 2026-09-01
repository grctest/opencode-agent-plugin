function supplementMissingSections(text, missingSections) {
  const note = `> **Note:** The synthesizer did not generate the following sections: ${missingSections.join(", ")}. Consider reviewing the raw deliberation transcript for additional context.`;
  return `${text}\n\n${note}`;
}

/** Derives a confidence level — dissent is valuable, not penalized; thoroughness matters. */
export function deriveConfidence(weave, dissentCount, totalParticipants = 0, activeParticipants = 0) {
  const totalContribs = weave.length;
  if (totalContribs === 0) return "low";

  const hasGroundedClaim = weave.some(c => {
    const s = String(c.content || "");
    // vec: is internal retrieval trace, not a grounded cite — require [#id] / Source / file=
    return /\[#\d+\]|Source:\s*https?:\/\/|file=src\//i.test(s) || (c.tool_calls && c.tool_calls.length > 0);
  });
  const participationRate = totalParticipants > 0 ? activeParticipants / totalParticipants : 1;
  const challengeWordsRe = /\b(challenge|dissent|disagree|concern|oppose|object|critique|dispute|contradict|refuse)\b/i;
  function isChallengeLike(c) {
    if (c.type === "challenge" || c.type === "dissent" || c.type === "critique_response") return true;
    const content = (c.content || "").toLowerCase();
    return challengeWordsRe.test(content);
  }
  const challengeRatio = weave.filter(isChallengeLike).length / Math.max(totalContribs, 1);

  // High: thorough + grounded, even with dissent if well-bounded
  if (hasGroundedClaim && participationRate >= 0.6 && totalContribs >= 4) {
    // Allow dissent to remain high if exploration was thorough
    if (dissentCount <= 2 || (dissentCount > 2 && challengeRatio < 0.5)) return "high";
  }
  if (hasGroundedClaim && participationRate >= 0.4 && totalContribs >= 2) return "medium";
  // Still medium if exploration thorough but many passes
  if (participationRate >= 0.5 && totalContribs >= 3) return "medium";
  return "low";
}

/** Parses the Confidence section — anchors to the Confidence heading block to avoid picking a stray High in body. */
export function parseConfidence(text) {
  // Find the Confidence section block, then search for the confidence word inside it
  const sectionRe = /^#{2,}\s*Confidence\b([\s\S]*?)(?=^#{2,}\s|\z)/im;
  const secMatch = text.match(sectionRe);
  const searchScope = secMatch ? secMatch[1] : text;
  // Look for the confidence word on its own line or as a label (avoid matching "High risk" in body unless it's the answer)
  const lineMatch = searchScope.match(/^\s*(High|Medium|Low)\s*$/im);
  if (lineMatch) return lineMatch[1].toLowerCase();
  // Fallback: first occurrence inside the Confidence block
  const anyMatch = searchScope.match(/\b(High|Medium|Low)\b/i);
  return anyMatch ? anyMatch[1].toLowerCase() : null;
}

/** Validates that all required sections exist — flexible for open-ended (Decision optional if Executive Summary present).
 * Core: Executive Summary + Reasoning + Confidence always required. Decision OR synthesis table satisfies decision requirement.
 * Action Items / Proposed Fix: at least one must be present. Dissenting Views and Open Questions remain required.
 */
export function validateSynthesisSections(text) {
  const hasExecutive = (() => {
    const esc = "Executive Summary".replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^#{2,}\\s*${esc}\\b`, "im").test(text);
  })();
  const coreRequired = hasExecutive ? ["Reasoning", "Confidence"] : ["Decision", "Reasoning", "Confidence"];
  // Still require Decision if no Executive Summary; if Executive present, Decision is optional (open-ended spectrum)
  if (hasExecutive && !new RegExp(`^#{2,}\\s*Decision\\b`, "im").test(text)) {
    // No warning — open-ended map is allowed when Executive Summary exists
  } else if (!hasExecutive) {
    // coreRequired already includes Decision
  }
  const atLeastOneOf = [["Action Items", "Proposed Fix"]];
  const alwaysRequired = ["Dissenting Views", "Open Questions"];
  const warnings = [];
  function hasSection(section) {
    const esc = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^#{2,}\\s*${esc}\\b`, "im");
    return re.test(text);
  }
  for (const section of coreRequired) {
    if (!hasSection(section)) {
      warnings.push(section);
    }
  }
  // If Executive Summary missing, still require Decision via coreRequired; no extra check needed
  for (const section of alwaysRequired) {
    if (!hasSection(section)) {
      warnings.push(section);
    }
  }
  for (const group of atLeastOneOf) {
    const hasOne = group.some(s => hasSection(s));
    if (!hasOne) {
      warnings.push(group[0]);
    }
  }
  // If Executive Summary present but no Decision, don't warn — open-ended valid
  return warnings.filter(w => !(hasExecutive && w === "Decision"));
}

/** Extracts list items from a named section of a markdown document — accepts ## or ###. */
export function extractSection(text, sectionName) {
  const lines = text.split("\n");
  const results = [];
  let inSection = false;
  let paragraph = "";
  const isHeading = (l) => /^#{2,}\s/.test(l);

  const flushParagraph = () => {
    const trimmed = paragraph.trim();
    if (trimmed && !isHeading(trimmed)) {
      results.push(trimmed);
    }
    paragraph = "";
  };

  const headerMatches = (line, name) => {
    if (!isHeading(line)) return false;
    return line.replace(/^#{2,}\s*/, "").toLowerCase().includes(name.toLowerCase());
  };

  for (const line of lines) {
    if (headerMatches(line, sectionName)) {
      inSection = true;
      continue;
    }
    if (inSection && isHeading(line)) {
      flushParagraph();
      inSection = false;
      continue;
    }
    if (!inSection) continue;

    if (line.trim().startsWith("- ")) {
      flushParagraph();
      results.push(line.trim().slice(2));
    } else if (/^\d+\./.test(line.trim())) {
      flushParagraph();
      results.push(line.trim().replace(/^\d+\.\s*/, ""));
    } else if (line.trim() === "") {
      flushParagraph();
    } else {
      paragraph += (paragraph ? " " : "") + line.trim();
    }
  }
  flushParagraph();

  return results;
}

const NEUTRAL_SYNTHESIZER_SYSTEM = `You are a synthesis auditor, not a participant. You are neutral to all agendas — including the synthesizer persona you may have borrowed. Human-readable first, then auditable detail. Concise but thorough.

Rules:
1. Lead with Executive Summary — plain narrative, no citations, human-first (120-180w). Then group citations per block for Decision/Action/Proposed Fix — cite once per block as [#id] or State-of-Play or Source: https://…, never vec: / vec round. If you synthesize a novel fix/code not present verbatim, mark it “Proposed — synthesized from [#id]”. Do not invent file contents not read via tool; if no file read, qualify “Proposed (unverified — no tool read)”. For open-ended, mapping the spectrum is correct — don’t force a single Decision. Decision table cells concise: Evidence 30-35w + one grouped cite, Tradeoff 30-35w.
2. Every Dissenting View must name holder (name + tier) + [#id] + one-line evidence (≤30w). Unresolved Objections are mandatory dissent. Merge duplicates from same holder on same evidence. Dissent is valuable — High confidence may still have bounded dissent.
3. Do not invent numbers, dates, costs, tool results, or participant positions not in transcript/State-of-Play. If evidence conflicts, state both and set Confidence accordingly. For code, do not invent file contents not read via tool. Deduplicate: Decision maps positions, Reasoning explains why — don’t repeat same numbers thrice.
4. Resolved Concerns must NOT reappear as Dissenting Views; summarize resolved items in ≤30w each, don’t dump full critique verbatim.
5. Never emit <<< or >>> delimiters. Be concise but thorough — 1500-3500w welcome; use the 200k window. Preserve code and numbers verbatim. Never emit vec: / vec round traces.`;

/** Normalizes internal vec: traces before final checks — replaces vec leak with State-of-Play reference. */
function normalizeVecTraces(text) {
  // Replace vec: round#X / vec round X / [Round X vec ...] with State-of-Play
  return text
    .replace(/\bvec:\s*round#?\s*\d+\b/gi, "State-of-Play")
    .replace(/\bvec\s+round\s*\d+\b/gi, "State-of-Play")
    .replace(/\[Round\s+\d+\s+vec[^\]]*\]/gi, "State-of-Play");
}

/** Summarizes a long objection to one line — preserves holder + core claim, caps to 200 chars. */
function summarizeObjection(o, max = 200) {
  const holder = o.participant_id ?? "unknown";
  const raw = String(o.content || "").replace(/\s+/g, " ").trim();
  const snippet = raw.slice(0, max).replace(/;$/, "");
  return `- ${holder}: ${snippet}${raw.length > max ? " …" : ""}`;
}

/** Post-processes raw synthesis text into the final artifact: objections, missing-section notes, confidence, structured fields. */
export function finalizeSynthesis(artifactText, transcriptData, participants, objections) {
  // Normalize vec traces in the draft before any validation — auto-fix per user Q4
  artifactText = normalizeVecTraces(artifactText);
  const unresolvedObjections = (objections ?? []).filter((o) => o.unresolved);
  const resolvedObjections = (objections ?? []).filter((o) => !o.unresolved);
  const objectionsText = unresolvedObjections.map((o) => summarizeObjection(o, 200)).join("\n");
  const resolvedText = resolvedObjections.map((o) => summarizeObjection({ ...o, content: `${o.content} (resolved)` }, 200)).join("\n");
  
  // Collect refusals from the transcript
  const weave = transcriptData.rounds.flatMap((r) => r.contributions);
  const refusals = weave.filter((c) => c.type === "refuse");
  const refusalsText = refusals.map((r) => {
    const p = participants.find((pp) => pp.config.id === r.participant_id);
    return `${p?.config.name ?? r.participant_id}: ${r.content}`;
  }).join("\n");
  
  let finalOutput = artifactText;
  
  // Only append unresolved/resolved summaries if not already in the draft (avoid duplication)
  const hasUnresolvedSection = /^##\s*Unresolved Objections\b/im.test(finalOutput);
  const hasResolvedSection = /^##\s*Resolved Concerns\b/im.test(finalOutput);
  if (objectionsText && !hasUnresolvedSection) {
    finalOutput = `${finalOutput}\n\n## Unresolved Objections\n${objectionsText}`;
  }
  if (resolvedText && !hasResolvedSection) {
    // Keep resolved concise — one line each, not full critique dump
    finalOutput = `${finalOutput}\n\n## Resolved Concerns\n${resolvedText}`;
  }
  
  if (refusalsText) {
    finalOutput = `${finalOutput}\n\n## Refusals\n${refusalsText}`;
  }

  const missingSections = validateSynthesisSections(finalOutput);
  if (missingSections.length > 0) {
    finalOutput = supplementMissingSections(finalOutput, missingSections);
  }

  // Grounded synthesis check: Decision section should cite at least one [#id] per block (not per line spam).
  // Grouped citations are valid — only flag if the entire Decision section lacks any valid weave citation.
  const weaveIds = new Set(weave.map((c) => String(c.id)));
  const decisions = extractSection(finalOutput, "Decision");
  const hasExecutive = new RegExp(`^#{2,}\\s*Executive Summary\\b`, "im").test(finalOutput);
  let inFence = false;
  let decisionHasValidCite = false;
  for (const line of decisions) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const cites = [...line.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]);
    if (cites.some((id) => weaveIds.has(id))) { decisionHasValidCite = true; break; }
  }
  // Also consider citations in Reasoning as grounding if Decision is a spectrum table (open-ended)
  const reasoning = extractSection(finalOutput, "Reasoning");
  let reasoningHasValidCite = false;
  for (const line of reasoning) {
    const cites = [...line.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]);
    if (cites.some((id) => weaveIds.has(id))) { reasoningHasValidCite = true; break; }
  }
  const overallGrounded = decisionHasValidCite || (hasExecutive && reasoningHasValidCite);
  if (!overallGrounded && decisions.length > 0) {
    const ungrounded = decisions.filter((line) => {
      const trimmed = line.trim();
      if (/^```/.test(trimmed)) return false;
      const cites = [...line.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]);
      return cites.length === 0 || cites.every((id) => !weaveIds.has(id));
    });
    if (ungrounded.length === decisions.length) {
      finalOutput += `\n\n## Needs Verification\nThe Decision section lacks a valid [#id] citation to the transcript and should be verified before acting. Consider checking State of Play or transcript.\n${ungrounded.slice(0, 5).map((l) => `- ${l.slice(0, 200)}`).join("\n")}`;
    }
  }

  const parsedConfidence = parseConfidence(finalOutput);
  const activeParticipants = participants.filter((p) => p.status !== "failed").length;
  const heuristicConfidence = deriveConfidence(weave, unresolvedObjections.length, participants.length, activeParticipants);
  const confidence = parsedConfidence ?? heuristicConfidence;

  const artifact = {
    content: finalOutput,
    format: "markdown",
    decisions: extractSection(finalOutput, "Decision"),
    action_items: extractSection(finalOutput, "Action Items"),
    proposed_fix: extractSection(finalOutput, "Proposed Fix"),
    files_involved: extractSection(finalOutput, "Files Involved"),
    dissent: unresolvedObjections,
    refusals: refusals.map(r => ({
      participant_id: r.participant_id,
      content: r.content,
    })),
    open_questions: extractSection(finalOutput, "Open Questions"),
    confidence,
  };

  return { artifact, output: finalOutput };
}

export { NEUTRAL_SYNTHESIZER_SYSTEM };
