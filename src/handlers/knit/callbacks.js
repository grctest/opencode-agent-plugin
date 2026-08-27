import { extractDecisionSummary } from "./utils.js";

export function createMeetingCallbacks(context, logger) {
  return {
    onContribution: (name, round, type) => {
      context.metadata({
        title: `Loom R${round}: ${name} (${type})`,
        metadata: {
          loom_last_contributor: name,
          loom_last_type: type,
          loom_round: round,
        },
      });
    },
    onRoundComplete: (round, summary) => {
      context.metadata({
        title: `Loom: Round ${round} complete`,
        metadata: {
          loom_round: round,
          loom_round_summary: summary.slice(0, 200),
        },
      });
    },
    onSynthesisStart: () => {
      context.metadata({ title: "Loom: Synthesizing final output...", metadata: { loom_status: "synthesizing" } });
    },
    onSynthesisComplete: (output) => {
      context.metadata({
        title: "Loom: Synthesis complete",
        metadata: {
          loom_status: "synthesis_complete",
          loom_output_preview: output.slice(0, 200),
        },
      });
    },
    onUpdate: (state) => {
      logger.debug("state_update", `Status: ${state.status}, Round: ${state.current_round}`, {
        activeParticipants: state.participants.filter((p) => p.status === "speaking").length,
      });
    },
  };
}

export function buildSummary(state, question, participants, meetingId, reportPath, artifact = "") {
  const decision = extractDecisionSummary(artifact);
  const lines = [
    `**Loom complete** — ${state.current_round} round${state.current_round !== 1 ? "s" : ""} (${state.status})`,
    `**Question:** ${question}`,
    `**Participants:** ${participants.length}`,
  ];
  if (decision) lines.push(`**Decision:** ${decision}`);
  lines.push(`**Meeting ID:** ${meetingId}`);
  if (reportPath) {
    lines.push("");
    lines.push(`Full report saved to \`${reportPath}\`.`);
  }
  lines.push("Run `/loom_viz` for the interactive dashboard.");
  return lines.join("\n");
}
