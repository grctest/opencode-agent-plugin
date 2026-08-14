import { Logger, extractErrorInfo } from "./logger.js";

/**
 * Derives a structured state-of-play summary from the weave (contributions).
 * Captures decisions, agreements, disagreements, open questions, and key facts
 * so agents have a compact, accurate running context without O(N²) token growth.
 */
export function updateStateOfPlay(weave, question, domain) {
  if (!weave || weave.length === 0) return "";

  const decisions = [];
  const agreements = [];
  const disagreements = [];
  const openQuestions = [];
  const keyFacts = [];

  for (const c of weave) {
    if (c.type === "pass") continue;
    const content = (c.content ?? "").trim();
    if (!content) continue;
    const lower = content.toLowerCase();

    if (lower.includes("[propose]") || lower.includes("decision") || lower.includes("we should")) {
      decisions.push(content.replace(/^\[(?:PROPOSE|CHALLENGE|REFINE|SUPPORT|DISSENT|SYNTHESIZE|QUESTION|REFUSE)\]\s*/i, ""));
    } else if (lower.includes("[support]") || lower.includes("agree") || lower.includes("consensus")) {
      agreements.push(content.replace(/^\[(?:PROPOSE|CHALLENGE|REFINE|SUPPORT|DISSENT|SYNTHESIZE|QUESTION|REFUSE)\]\s*/i, ""));
    } else if (lower.includes("[dissent]") || lower.includes("[challenge]") || lower.includes("disagree") || lower.includes("concern")) {
      disagreements.push(content.replace(/^\[(?:PROPOSE|CHALLENGE|REFINE|SUPPORT|DISSENT|SYNTHESIZE|QUESTION|REFUSE)\]\s*/i, ""));
    } else if (lower.includes("[question]") || lower.includes("?")) {
      openQuestions.push(content.replace(/^\[(?:PROPOSE|CHALLENGE|REFINE|SUPPORT|DISSENT|SYNTHESIZE|QUESTION|REFUSE)\]\s*/i, ""));
    } else {
      keyFacts.push(content.replace(/^\[(?:PROPOSE|CHALLENGE|REFINE|SUPPORT|DISSENT|SYNTHESIZE|QUESTION|REFUSE)\]\s*/i, ""));
    }
  }

  return formatStateOfPlay({ decisions, agreements, disagreements, openQuestions, keyFacts }, question, domain);
}

/**
 * Formats structured state-of-play sections into a concise markdown summary.
 */
export function formatStateOfPlay(sections, question, domain) {
  const lines = [];
  if (question) lines.push(`## Question\n${question}`);
  if (domain) lines.push(`## Domain\n${domain}`);

  if (sections.decisions.length > 0) {
    lines.push(`## Decisions & Proposals\n${sections.decisions.slice(-5).map((d) => `- ${d.slice(0, 300)}`).join("\n")}`);
  }
  if (sections.agreements.length > 0) {
    lines.push(`## Agreements\n${sections.agreements.slice(-5).map((a) => `- ${a.slice(0, 300)}`).join("\n")}`);
  }
  if (sections.disagreements.length > 0) {
    lines.push(`## Disagreements & Concerns\n${sections.disagreements.slice(-5).map((d) => `- ${d.slice(0, 300)}`).join("\n")}`);
  }
  if (sections.openQuestions.length > 0) {
    lines.push(`## Open Questions\n${sections.openQuestions.slice(-5).map((q) => `- ${q.slice(0, 300)}`).join("\n")}`);
  }
  if (sections.keyFacts.length > 0) {
    lines.push(`## Key Facts\n${sections.keyFacts.slice(-5).map((f) => `- ${f.slice(0, 300)}`).join("\n")}`);
  }

  return lines.join("\n\n");
}

/** Formats transcript data from the database into a string for the synthesizer. */
export function formatTranscriptFromData(data, participants) {
  const lines = [];

  for (const round of data.rounds) {
    lines.push(`### Round ${round.number}`);

    for (const c of round.contributions) {
      const participant = participants.find((p) => p.config.id === c.participant_id);
      const name = participant?.config.name ?? c.participant_id;
      const tier = participant?.config.tier ?? "mid";
      lines.push(`**[${name}]** (${tier}, ${c.type}): ${c.content}`);
    }

    if (round.interjections.length > 0) {
      lines.push(`  **Interjections:**`);
      for (const ij of round.interjections) {
        const name = participants.find((p) => p.config.id === ij.participant_id)?.config.name ?? ij.participant_id;
        lines.push(`  - [${name}] P${ij.priority}: ${ij.reason} → ${ij.resolved}`);
        if (ij.pushback) {
          lines.push(`    Pushback: ${ij.pushback}`);
        }
      }
    }

    if (round.summary) {
      lines.push(`  *Summary:* ${round.summary}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}
