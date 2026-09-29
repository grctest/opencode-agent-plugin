import { parseReflections, safeParseJson } from "../../utils/db-parsing.js";

/**
 * Full-fidelity timeline extract for preservation and evaluation.
 *
 * Best-practice evaluation bundle (JSON, not truncated):
 * - setup: the full Setup-tab configuration as persisted (question, context,
 *   max_rounds, features, orchestrator config/model, seats with persona +
 *   model + guidance fields, embedding model). Nothing is summarized away so a
 *   deliberation can be re-created and its process audited.
 * - timeline: rounds in sequence, each with its ordered turns, its round
 *   summary, and its orchestrator exchanges — the same ordering the Timeline
 *   tab renders. Every turn carries the full response (content), the full
 *   tool-use details (tool_calls with input/output/error/status), and the
 *   full prompt context window (system_prompt, user_prompt, state_of_play,
 *   recent contributions used, reflection, patch outcome).
 * - Supporting evaluation tables: turn_requests, agent_errors,
 *   orchestrator_messages, artifact, forum, tool_audit, state_patches,
 *   state_patch_summary.
 * - agent_states: per-agent skill.state final projection (replayed from
 *   patches) for evaluating whether SKILL.state tracked consensus.
 * - settled_items: the meeting-level clerk-designated settled registry
 *   (retrospective P0-2) for evaluating consensus tracking.
 */
export function exportTimeline(meetingId) {
  const parse = (v, fallback = null) => safeParseJson(v, fallback);
  const parseArr = (v) => {
    const p = parse(v, []);
    return Array.isArray(p) ? p : [];
  };

  // Full meeting row (setup source of truth) — defensive column access so
  // pre-migration DBs still export instead of 500ing.
  let meetingRow = null;
  try {
    meetingRow = this._db.prepare(`SELECT * FROM meetings LIMIT 1`).get() ?? null;
  } catch {
    meetingRow = null;
  }
  const meeting = this.getState();
  const participants = this.getParticipants();

  // Full participant rows (seats) — getParticipants() already normalizes, but
  // the evaluation bundle keeps every persisted seat field verbatim.
  let seatRows = [];
  try {
    seatRows = this._db.prepare(`SELECT * FROM participants ORDER BY rowid ASC`).all();
  } catch {
    seatRows = [];
  }
  const seats = seatRows.map((r) => ({
    id: r.id,
    name: r.name,
    persona: r.persona,
    agenda: r.agenda,
    tier: r.tier,
    model: r.provider_id && r.model_id ? `${r.provider_id}/${r.model_id}` : null,
    provider_id: r.provider_id ?? null,
    model_id: r.model_id ?? null,
    session_id: r.session_id ?? null,
    session_version: r.session_version ?? null,
    status: r.status ?? null,
    reflection: parseReflections(r.reflection),
    state: parse(r.state_json, null),
    known_biases: parse(r.known_biases, []),
    communication_style: r.communication_style ?? "",
    preferred_contribution_types: parse(r.preferred_contribution_types, []),
    anti_patterns: parse(r.anti_patterns, []),
    tier_guidance: r.tier_guidance ?? "",
    reflection_guidance: r.reflection_guidance ?? "",
    tags: parse(r.tags, []),
    expertise: parse(r.expertise, []),
  }));

  const totalCount = this.getContributionsCount();
  const contributions = [];
  for (let offset = 0; offset < totalCount; offset += 500) {
    contributions.push(...this.getContributions(500, offset));
  }
  // getContributions() orders by round ASC, id ASC — the canonical turn sequence.
  contributions.sort((a, b) => (a.round - b.round) || ((a.id ?? 0) - (b.id ?? 0)));

  const turnRequests = this.getTurnRequests();
  const errors = this.getAgentErrors();
  const artifact = this.getArtifact();
  const orchestratorMessages = this.getOrchestratorMessages(meetingId);
  const roundSummaries = this.getRoundSummaries(meetingId);
  let statePatchSummary = null;
  try { statePatchSummary = this.getStatePatchSummary(); } catch { statePatchSummary = null; }

  let toolAudit = [];
  try {
    toolAudit = this._db.prepare(
      `SELECT id, participant_id, round, batch_id, tool, input, output, status, title, created_at FROM tool_audit ORDER BY id ASC`
    ).all();
  } catch { toolAudit = []; }

  let statePatches = [];
  try {
    statePatches = this._db.prepare(
      `SELECT id, participant_id, round, contribution_id, version, patch_json, applied_json, created_at FROM state_patches ORDER BY id ASC`
    ).all().map((r) => ({
      ...r,
      patch: parse(r.patch_json, null),
      applied: parse(r.applied_json, null),
    }));
  } catch { statePatches = []; }

  let roundRows = [];
  try {
    roundRows = this._db.prepare(
      `SELECT round, summary, orchestrator_config_json, created_at FROM rounds WHERE meeting_id = ? ORDER BY round ASC`
    ).all(meetingId).map((r) => ({
      round: r.round,
      summary: r.summary,
      orchestrator_config: parse(r.orchestrator_config_json, null),
      created_at: r.created_at,
    }));
  } catch { roundRows = []; }

  let forum = [];
  try {
    const topics = this.getForumTopics();
    forum = topics.map((t) => {
      try { return this.getForumTopic(t.id); } catch { return t; }
    });
  } catch { forum = []; }

  // Per-agent skill.state final projection (retrospective evaluation): replay
  // each agent's state patches in version order to reconstruct the final Σⁱ —
  // the applied_json column stores diffs, not full state, so the export derives
  // the complete final state deterministically. Includes version + updated
  // round/contribution for auditability.
  const agentStates = (() => {
    const byAgent = new Map();
    for (const p of statePatches) {
      if (!byAgent.has(p.participant_id)) byAgent.set(p.participant_id, []);
      byAgent.get(p.participant_id).push(p);
    }
    const nameById = new Map(participants.map((p) => [p.id, p.name]));
    const out = [];
    for (const [pid, patches] of byAgent) {
      patches.sort((a, b) => (a.version ?? 0) - (b.version ?? 0));
      const state = { stance: "", established: [], contested: [], open: [], facts: [], files: [] };
      let version = 0;
      for (const p of patches) {
        const patch = parse(p.patch_json, null) ?? {};
        for (const r of (patch.remove ?? [])) {
          const key = String(r).trim().toLowerCase();
          for (const bucket of ["established", "contested", "open", "facts", "files"]) {
            state[bucket] = state[bucket].filter((it) => String(it).trim().toLowerCase() !== key);
          }
          if (state.stance.trim().toLowerCase() === key) state.stance = "";
        }
        for (const bucket of ["established", "contested", "open", "facts", "files"]) {
          for (const item of (patch[`${bucket}_add`] ?? [])) {
            if (!state[bucket].includes(item)) state[bucket].push(item);
          }
        }
        if (patch.stance !== undefined) state.stance = String(patch.stance).trim();
        version = p.version ?? version;
      }
      out.push({
        participant_id: pid,
        name: nameById.get(pid) ?? pid,
        state,
        version,
        updated_round: patches.length ? (patches[patches.length - 1].round ?? null) : null,
        updated_contribution_id: patches.length ? (patches[patches.length - 1].contribution_id ?? null) : null,
      });
    }
    return out;
  })();

  // Meeting-level settled registry (retrospective P0-2) — clerk-designated
  // consensus items, for evaluating whether consensus was tracked.
  let settledItems = [];
  try {
    const raw = this._db.prepare(`SELECT settled_items FROM meetings WHERE id = ?`).get(meetingId);
    const parsed = parse(raw?.settled_items, []);
    settledItems = Array.isArray(parsed) ? parsed : [];
  } catch { settledItems = []; }

  const features = meeting?.features ?? parse(meetingRow?.feature_toggles_json, {});
  const orchestrator = meeting?.orchestrator ?? parse(meetingRow?.orchestrator_config_json, {});

  // Round-ordered timeline: turns + summary + orchestrator exchanges per round.
  const byRound = new Map();
  for (const c of contributions) {
    if (!byRound.has(c.round)) byRound.set(c.round, []);
    byRound.get(c.round).push(c);
  }
  const timeline = [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, turns]) => {
      const ordered = turns.slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).map((c) => ({
        id: c.id,
        participant_id: c.participant_id,
        round: c.round,
        type: c.type,
        // Full response text — never truncated in this export.
        content: c.content,
        targets_which: c.targets_which ?? null,
        batch_id: c.batch_id ?? null,
        // Full tool-use details per step.
        tool_calls: c.tool_calls ?? [],
        // Full context window per step.
        prompt_context: c.prompt_context ?? null,
        created_at: c.created_at,
      }));
      return {
        round,
        turns: ordered,
        turn_count: ordered.length,
        summary: roundSummaries?.[round] ?? null,
        orchestrator_messages: orchestratorMessages.filter((m) => m.round === round),
      };
    });

  return {
    format: "loom-timeline-export",
    format_version: 1,
    exported_at: new Date().toISOString(),
    meeting_id: meetingId,
    setup: {
      question: meeting?.question ?? meetingRow?.question ?? "",
      context: meeting?.context ?? meetingRow?.context ?? "",
      max_rounds: meeting?.max_rounds ?? meetingRow?.max_rounds ?? null,
      status: meeting?.status ?? meetingRow?.status ?? null,
      round: meeting?.round ?? meetingRow?.round ?? 0,
      convergence: meeting?.convergence ?? meetingRow?.convergence ?? null,
      fabric: meeting?.fabric ?? meetingRow?.fabric ?? "",
      state_of_play: meeting?.state_of_play ?? meetingRow?.state_of_play ?? null,
      tags: parse(meetingRow?.tags, []),
      features,
      features_raw: meetingRow?.feature_toggles_json ?? null,
      orchestrator,
      orchestrator_raw: meetingRow?.orchestrator_config_json ?? null,
      orchestrator_model: (meetingRow?.orchestrator_provider_id && meetingRow?.orchestrator_model_id)
        ? `${meetingRow.orchestrator_provider_id}/${meetingRow.orchestrator_model_id}`
        : (orchestrator?.model ?? null),
      seats,
      participant_count: seats.length,
      embedding_model: meetingRow?.embedding_model ?? null,
      embedding_dim: meetingRow?.embedding_dim ?? null,
      stats: meeting?.stats ?? parse(meetingRow?.stats, {}),
      semantic_degraded: meetingRow?.semantic_degraded ?? 0,
      persistence_degraded: meetingRow?.persistence_degraded ?? 0,
      created_at: meetingRow?.created_at ?? meeting?.created_at ?? null,
      updated_at: meetingRow?.updated_at ?? null,
      parent_session_id: meetingRow?.parent_session_id ?? null,
      opencode_session_id: meetingRow?.opencode_session_id ?? null,
    },
    timeline,
    contributions: contributions.map((c) => ({
      id: c.id,
      participant_id: c.participant_id,
      round: c.round,
      type: c.type,
      content: c.content,
      targets_which: c.targets_which ?? null,
      batch_id: c.batch_id ?? null,
      tool_calls: c.tool_calls ?? [],
      prompt_context: c.prompt_context ?? null,
      created_at: c.created_at,
    })),
    round_summaries: roundSummaries ?? {},
    rounds: roundRows,
    orchestrator_messages: orchestratorMessages,
    turn_requests: turnRequests,
    agent_errors: errors,
    artifact,
    state_patch_summary: statePatchSummary,
    state_patches: statePatches,
    tool_audit: toolAudit,
    forum,
    participants: participants,
    agent_states: agentStates,
    settled_items: settledItems,
    total_contributions: totalCount,
    total_rounds: timeline.length,
  };
}

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
      lines.push(`- **${p.name}** (${p.tier}) — ${p.provider_id ?? "unknown"}/${p.model_id ?? "unknown"}${p.state_stance ? ` — stance@v${p.state_version ?? 0}: ${p.state_stance}` : ""}`);
    }
    lines.push("");

    const withState = participants.filter((p) => p.state_stance);
    if (withState.length > 0) {
      lines.push(`## Agent States`);
      lines.push("");
      lines.push(`_Positions only — cite weave [#id] for contested claims._`);
      lines.push("");
      for (const p of withState) {
        lines.push(`- **${p.name}** (${p.tier}${p.state_version ? ` v${p.state_version}` : ""}): ${p.state_stance}`);
      }
      lines.push("");
    }

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
        lines.push(`- **[${name}]** P${tr.priority}: ${tr.reason ?? tr.content}`);
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
        ...(p.state_stance ? { stance: p.state_stance, state_version: p.state_version ?? 0 } : {}),
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
        content: tr.reason ?? tr.content,
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

    // Truly streaming: paginate by round, yield per-contribution without materializing all rounds
    const total = this.getContributionsCount();
    let currentRound = null;
    const participantName = (id) => participants.find((p) => p.id === id)?.name ?? id;
    for (let offset = 0; offset < total; offset += 500) {
      const batch = this.getContributions(500, offset);
      for (const c of batch) {
        if (c.round !== currentRound) {
          if (currentRound !== null) yield `\n`;
          currentRound = c.round;
          yield `## Round ${currentRound}\n\n`;
        }
        const name = participantName(c.participant_id);
        yield `- **[${name}]** (${c.type}): ${c.content}\n`;
      }
    }
    if (currentRound !== null) yield `\n`;

    if (turnRequests.length > 0) {
      yield `## Turn Requests\n\n`;
      for (const tr of turnRequests) {
        const participant = participants.find((p) => p.id === tr.participant_id);
        const name = participant?.name ?? tr.participant_id;
        yield `- **[${name}]** P${tr.priority}: ${tr.reason ?? tr.content}\n`;
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

