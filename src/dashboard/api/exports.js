import { parseReflections } from "../../utils/db-parsing.js";

export function exportMarkdown(meetingId) {
    const meeting = this.getState();
    const participants = this.getParticipants();
    const totalCount = this.getContributionsCount();
    const contributions = [];
    for (let offset = 0; offset < totalCount; offset += 500) {
      contributions.push(...this.getContributions(500, offset));
    }
    const turnRequests = this.getTurnRequests();
    const errors = this.getAgentErrors();
    const artifact = this.getArtifact();

    const lines = [];
    lines.push(`# Loom Deliberation Output`);
    lines.push("");
    lines.push(`**Question:** ${meeting?.question ?? "Unknown"}`);
    lines.push(`**Status:** ${meeting?.status ?? "Unknown"}`);
    lines.push(`**Rounds:** ${meeting?.round ?? 0}/${meeting?.max_rounds ?? 0}`);
    lines.push(`**Convergence:** ${meeting?.convergence ?? "Unknown"}`);
    lines.push(`**Meeting ID:** ${meetingId}`);
    if (totalCount > 500) {
      lines.push(`**Note:** Full export — ${totalCount} contributions included.`);
    }
    lines.push("");

    if (artifact?.content) {
      lines.push(`## Final Artifact`);
      lines.push("");
      lines.push(artifact.content);
      lines.push("");
    }
    lines.push(`## Participants`);
    lines.push("");
    for (const p of participants) {
      lines.push(`- **${p.name}** (${p.tier}) — ${p.provider_id ?? "unknown"}/${p.model_id ?? "unknown"}`);
    }
    lines.push("");

    const roundMap = new Map();
    for (const c of contributions) {
      if (!roundMap.has(c.round)) roundMap.set(c.round, []);
      roundMap.get(c.round).push(c);
    }

    for (const [roundNum, contribs] of [...roundMap.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`## Round ${roundNum}`);
      lines.push("");
      for (const c of contribs) {
        const participant = participants.find((p) => p.id === c.participant_id);
        const name = participant?.name ?? c.participant_id;
        lines.push(`- **[${name}]** (${c.type}): ${c.content}`);
      }
      lines.push("");
    }

    if (turnRequests.length > 0) {
      lines.push(`## Turn Requests`);
      lines.push("");
      for (const tr of turnRequests) {
        const participant = participants.find((p) => p.id === tr.participant_id);
        const name = participant?.name ?? tr.participant_id;
        lines.push(`- **[${name}]** P${tr.priority}: ${tr.content}`);
      }
      lines.push("");
    }

    if (errors.length > 0) {
      lines.push(`## Errors`);
      lines.push("");
      for (const e of errors) {
        const participant = participants.find((p) => p.id === e.participant_id);
        const name = participant?.name ?? e.participant_id;
        lines.push(`- **[${name}]** Round ${e.round}: ${e.error_type} — ${e.error_message}`);
      }
      lines.push("");
    }

    if (meeting?.fabric) {
      lines.push(`## Initial Context (fabric — legacy)`);
      lines.push("");
      lines.push(meeting.fabric);
      lines.push("");
    }

    return lines.join("\n");
  }

export function exportJSON(meetingId) {
    const meeting = this.getState();
    const participants = this.getParticipants();
    const totalCount = this.getContributionsCount();
    const contributions = [];
    for (let offset = 0; offset < totalCount; offset += 500) {
      contributions.push(...this.getContributions(500, offset));
    }
    const turnRequests = this.getTurnRequests();
    const errors = this.getAgentErrors();
    const artifact = this.getArtifact();
    const orchestratorMessages = this.getOrchestratorMessages(meetingId);

    const exportData = {
      meeting: {
        id: meetingId,
        question: meeting?.question ?? "Unknown",
        status: meeting?.status ?? "Unknown",
        round: meeting?.round ?? 0,
        maxRounds: meeting?.max_rounds ?? 0,
        convergence: meeting?.convergence ?? "Unknown",
        fabric: meeting?.fabric ?? "",
        createdAt: meeting?.created_at ?? null,
      },
      participants: participants.map(p => ({
        id: p.id,
        name: p.name,
        tier: p.tier,
        persona: p.persona,
        agenda: p.agenda,
        model: p.provider_id && p.model_id ? `${p.provider_id}/${p.model_id}` : null,
        status: p.status,
      })),
      contributions: contributions.map(c => ({
        id: c.id,
        round: c.round,
        participantId: c.participant_id,
        type: c.type,
        content: c.content,
        targetsWhich: c.targets_which,
        batchId: c.batch_id ?? null,
        toolCalls: c.tool_calls ?? null,
        createdAt: c.created_at,
      })),
      turn_requests: turnRequests.map(tr => ({
        id: tr.id,
        participantId: tr.participant_id,
        targetParticipantId: tr.target_participant_id,
        round: tr.round,
        priority: tr.priority,
        content: tr.content,
        createdAt: tr.created_at,
      })),
      errors: errors.map(e => ({
        id: e.id,
        participantId: e.participant_id,
        round: e.round,
        errorType: e.error_type,
        errorMessage: e.error_message,
        attempts: e.attempts,
        createdAt: e.created_at,
      })),
      artifact: artifact ? {
        content: artifact.content,
        decisions: artifact.decisions,
        actionItems: artifact.action_items,
        dissent: artifact.dissent,
        openQuestions: artifact.open_questions,
        confidence: artifact.confidence,
        createdAt: artifact.created_at,
      } : null,
      orchestratorMessages,
      totalContributions: totalCount,
      exportedAt: new Date().toISOString(),
    };

    return JSON.stringify(exportData, null, 2);
  }

  export function* exportMarkdownStream(meetingId) {
    const meeting = this.getState();
    const participants = this.getParticipants();
    const turnRequests = this.getTurnRequests();
    const errors = this.getAgentErrors();
    const artifact = this.getArtifact();

    yield `# Loom Deliberation Output\n\n`;
    yield `**Question:** ${meeting?.question ?? "Unknown"}\n`;
    yield `**Status:** ${meeting?.status ?? "Unknown"}\n`;
    yield `**Rounds:** ${meeting?.round ?? 0}/${meeting?.max_rounds ?? 0}\n`;
    yield `**Convergence:** ${meeting?.convergence ?? "Unknown"}\n`;
    yield `**Meeting ID:** ${meetingId}\n\n`;

    if (artifact?.content) {
      yield `## Final Artifact\n\n${artifact.content}\n\n`;
    }

    yield `## Participants\n\n`;
    for (const p of participants) {
      yield `- **${p.name}** (${p.tier}) — ${p.provider_id ?? "unknown"}/${p.model_id ?? "unknown"}\n`;
    }
    yield `\n`;

    // Stream contributions by round — paginated for full history
    const total = this.getContributionsCount();
    const allContributions = [];
    for (let offset = 0; offset < total; offset += 500) {
      allContributions.push(...this.getContributions(500, offset));
    }
    const roundMap = new Map();
    const roundNumbers = [];
    for (const c of allContributions) {
      if (!roundMap.has(c.round)) {
        roundMap.set(c.round, []);
        roundNumbers.push(c.round);
      }
      roundMap.get(c.round).push(c);
    }

    for (const roundNum of roundNumbers.sort((a, b) => a - b)) {
      yield `## Round ${roundNum}\n\n`;
      for (const c of roundMap.get(roundNum)) {
        const participant = participants.find((p) => p.id === c.participant_id);
        const name = participant?.name ?? c.participant_id;
        yield `- **[${name}]** (${c.type}): ${c.content}\n`;
      }
      yield `\n`;
    }

    if (turnRequests.length > 0) {
      yield `## Turn Requests\n\n`;
      for (const tr of turnRequests) {
        const participant = participants.find((p) => p.id === tr.participant_id);
        const name = participant?.name ?? tr.participant_id;
        yield `- **[${name}]** P${tr.priority}: ${tr.content}\n`;
      }
      yield `\n`;
    }

    if (errors.length > 0) {
      yield `## Errors\n\n`;
      for (const e of errors) {
        const participant = participants.find((p) => p.id === e.participant_id);
        const name = participant?.name ?? e.participant_id;
        yield `- **[${name}]** Round ${e.round}: ${e.error_type} — ${e.error_message}\n`;
      }
      yield `\n`;
    }

    if (meeting?.fabric) {
      yield `## Initial Context (fabric — legacy)\n\n${meeting.fabric}\n`;
    }
  }

