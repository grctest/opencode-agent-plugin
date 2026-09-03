/**
 * Pure function extracted from TimelineTab.jsx megafunction.
 * Builds flat virtual-list items grouped by round, preserving all
 * batch/inline/tool-call resolution logic.
 */
export function pairOrchestratorMessages(messages) {
  const groups = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "user") {
      const response = messages[i + 1]?.role === "assistant" ? messages[i + 1] : null;
      groups.push({ query: msg, response });
      i += response ? 2 : 1;
    } else {
      groups.push({ query: null, response: msg });
      i += 1;
    }
  }
  return groups;
}

export function buildFlatItems(groupedContributions, opts) {
  const {
    collapsedRounds = [],
    activeRound,
    agentErrors = [],
    turnRequests = [],
    extensions = [],
    maxRounds,
    isWeaving = false,
    thinkingParticipants = [],
    reflectingParticipants = [],
    queryingParticipants = [],
    evidenceParticipants = [],
    summoningParticipants = [],
    participantName = (id) => id,
    orchestratorMessages = [],
    roundSummaries = {},
  } = opts || {};

  const out = [];

  // Extra rounds per extension — must match MeetingExtender#deriveExtraRounds (4 fallback, else ceil(cfg/2) clamped 2-6)
  // Use same derivation as meeting-extender (importing getConfig would couple dashboard to node fs, so duplicate the 3-line formula)
  const extraPerExtension = (() => {
    try {
      // Prefer explicit global injected by dashboard server, else fallback
      const cfg = (typeof window !== "undefined" && window.__loomConfig?.defaultMaxRounds) ?? globalThis.__loomConfig?.defaultMaxRounds;
      if (Number.isFinite(cfg)) return Math.max(2, Math.min(6, Math.ceil(cfg / 2)));
    } catch {}
    return 4;
  })();
  for (const [round, contribs] of groupedContributions) {
    const isCollapsed = collapsedRounds.includes(round);
    const roundErrors = agentErrors.filter((e) => e.round === round);
    const showExtensionMarker = extensions.length > 0 && round === (maxRounds ? maxRounds - (extensions.length * extraPerExtension) : 0) + 1;

    const visibleContribsCount = contribs.filter(c => c.type !== "vote_tally").length;
    const segItems = [];
    segItems.push({
      type: "header",
      round,
      isCollapsed,
      isActive: round === activeRound,
      contribsCount: visibleContribsCount,
      errorsCount: roundErrors.length,
      showExtensionMarker,
    });

    if (!isCollapsed) {
      const roundTurnRequests = turnRequests.filter((tr) => {
        if (contribs.length === 0) return false;
        const contribTimes = contribs.map((c) => c.created_at ? new Date(c.created_at).getTime() : 0).filter(Boolean);
        if (contribTimes.length === 0) return true;
        const roundStart = Math.min(...contribTimes);
        const trTime = tr.created_at ? new Date(tr.created_at).getTime() : 0;
        return trTime >= roundStart;
      });

      const regularByAgent = new Map();
      const reflectionsByTarget = new Map();
      const consumedReflectionIds = new Set();
      const queryResponsesByTarget = new Map();
      const consumedQueryIds = new Set();
      const evidenceResponsesByTarget = new Map();
      const consumedEvidenceIds = new Set();
      const summonedResponses = [];
      const consumedSummonIds = new Set();
      const votesByTarget = new Map();
      const consumedVoteIds = new Set();
      const queryByBatch = new Map();
      const evidenceByBatch = new Map();
      const votesByBatch = new Map();
      const summonByBatch = new Map();

      for (const c of contribs) {
        if (c.type === "vote_tally") continue;
        if (c.type === "reflection") {
          const targetId = c.targets_which;
          if (targetId != null) {
            if (!reflectionsByTarget.has(targetId)) reflectionsByTarget.set(targetId, []);
            reflectionsByTarget.get(targetId).push(c);
          }
        } else if (c.type === "query_response") {
          const targetId = c.targets_which;
          if (targetId != null) {
            if (!queryResponsesByTarget.has(targetId)) queryResponsesByTarget.set(targetId, []);
            queryResponsesByTarget.get(targetId).push(c);
          } else if (c.batch_id) {
            if (!queryByBatch.has(c.batch_id)) queryByBatch.set(c.batch_id, []);
            queryByBatch.get(c.batch_id).push(c);
          }
        } else if (c.type === "perspective_response") {
          const targetId = c.targets_which;
          if (targetId != null) {
            if (!queryResponsesByTarget.has(targetId)) queryResponsesByTarget.set(targetId, []);
            queryResponsesByTarget.get(targetId).push(c);
          } else if (c.batch_id) {
            if (!queryByBatch.has(c.batch_id)) queryByBatch.set(c.batch_id, []);
            queryByBatch.get(c.batch_id).push(c);
          }
        } else if (c.type === "critique_response") {
          const targetId = c.targets_which;
          if (targetId != null) {
            if (!queryResponsesByTarget.has(targetId)) queryResponsesByTarget.set(targetId, []);
            queryResponsesByTarget.get(targetId).push(c);
          } else if (c.batch_id) {
            if (!queryByBatch.has(c.batch_id)) queryByBatch.set(c.batch_id, []);
            queryByBatch.get(c.batch_id).push(c);
          }
        } else if (c.type === "evidence_response") {
          const targetId = c.targets_which;
          if (targetId != null) {
            if (!evidenceResponsesByTarget.has(targetId)) evidenceResponsesByTarget.set(targetId, []);
            evidenceResponsesByTarget.get(targetId).push(c);
          } else if (c.batch_id) {
            if (!evidenceByBatch.has(c.batch_id)) evidenceByBatch.set(c.batch_id, []);
            evidenceByBatch.get(c.batch_id).push(c);
          }
        } else if (c.type === "summoned_response") {
          if (c.batch_id) {
            if (!summonByBatch.has(c.batch_id)) summonByBatch.set(c.batch_id, []);
            summonByBatch.get(c.batch_id).push(c);
          } else {
            summonedResponses.push(c);
          }
        } else if (c.type === "vote_response") {
          const targetId = c.targets_which;
          if (targetId != null) {
            if (!votesByTarget.has(targetId)) votesByTarget.set(targetId, []);
            votesByTarget.get(targetId).push(c);
          } else if (c.batch_id) {
            if (!votesByBatch.has(c.batch_id)) votesByBatch.set(c.batch_id, []);
            votesByBatch.get(c.batch_id).push(c);
          } else {
            // No batch (legacy or reused drift) - still surface as timeline row via orphan handling
            const orphanKey = `__orphan_${c.round}_${c.participant_id}`;
            if (!votesByBatch.has(orphanKey)) votesByBatch.set(orphanKey, []);
            votesByBatch.get(orphanKey).push(c);
          }
        } else {
          const key = c.participant_id;
          if (!regularByAgent.has(key)) regularByAgent.set(key, []);
          regularByAgent.get(key).push(c);
        }
      }

      const batchToInvoker = new Map();
      for (const [, rcs] of regularByAgent) {
        for (const c of rcs) if (c.batch_id) batchToInvoker.set(c.batch_id, c.participant_id);
      }
      // Also index source_batch_id from responses so reused batches (drift) resolve without strict batch match
      for (const [, list] of votesByBatch) {
        for (const v of list) {
          const sb = v.prompt_context?.source_batch_id;
          const sid = v.prompt_context?.source_participant_id;
          if (sb && sid && !batchToInvoker.has(sb)) batchToInvoker.set(sb, sid);
        }
      }
      for (const [, list] of queryByBatch) {
        for (const qr of list) {
          const sb = qr.prompt_context?.source_batch_id;
          const sid = qr.prompt_context?.source_participant_id;
          if (sb && sid && !batchToInvoker.has(sb)) batchToInvoker.set(sb, sid);
        }
      }
      for (const [, list] of summonByBatch) {
        for (const sr of list) {
          const sb = sr.prompt_context?.source_batch_id;
          const sid = sr.prompt_context?.source_participant_id;
          if (sb && sid && !batchToInvoker.has(sb)) batchToInvoker.set(sb, sid);
        }
      }
      const findInvokerIdForResponse = (resp) => {
        // Prefer stable source_participant_id over batch_id — batch drifts on retry (reused:true)
        // so reused vote/query responses must still resolve to invoker and appear as timeline rows.
        const srcId = resp.prompt_context?.source_participant_id ?? resp.prompt_context?.sourceParticipantId ?? resp.prompt_context?.source_participant_name;
        if (srcId && srcId !== "caller" && srcId !== "unknown" && srcId !== "Unknown") {
          // Allow IDs with spaces when they are display names — try to resolve via participantName map
          // Prefer ID shape (alphanumeric + _ -) but fall back to name lookup
          if (!srcId.includes(" ") || srcId.length < 50) {
            // Check if srcId matches a known participant id directly
            if (regularByAgent.has(srcId)) return srcId;
            // Try to resolve display name -> id via participantName reverse lookup
            for (const [pid] of regularByAgent) {
              if (participantName(pid) === srcId) return pid;
            }
            if (srcId.length < 30 && !srcId.includes(" ")) return srcId;
            // Still return srcId if it looks like an id (no parenthetical)
            if (!srcId.includes("(") && srcId.length < 50) return srcId;
          }
        }
        if (resp.prompt_context?.source_participant_id && resp.prompt_context.source_participant_id !== "caller" && resp.prompt_context.source_participant_id !== "unknown") return resp.prompt_context.source_participant_id;
        if (resp.prompt_context?.sourceParticipantId && resp.prompt_context.sourceParticipantId !== "caller" && resp.prompt_context.sourceParticipantId !== "unknown") return resp.prompt_context.sourceParticipantId;
        // Fallback to batch mapping for non-reused or legacy rows where source may be missing
        if (resp.batch_id && batchToInvoker.has(resp.batch_id)) {
          const v = batchToInvoker.get(resp.batch_id);
          if (v && v !== "caller" && v !== "unknown") return v;
        }
        const srcBatch = resp.prompt_context?.source_batch_id;
        if (srcBatch && batchToInvoker.has(srcBatch)) {
          const v = batchToInvoker.get(srcBatch);
          if (v && v !== "caller" && v !== "unknown") return v;
        }
        let best = null;
        let bestId = -1;
        for (const [, rContribs] of regularByAgent) {
          for (const c of rContribs) {
            if (c.id >= resp.id) continue;
            const calls = c.tool_calls ?? [];
            for (const tc of calls) {
              const tool = tc.tool ?? tc.attempted_tool;
              if (!tool) continue;
              try {
                const input = typeof tc.input === "string" ? JSON.parse(tc.input) : tc.input;
                if (tool === "loom_query" || tool === "loom_evidence") {
                  const queries = input.queries ?? (Array.isArray(input.targets) ? input.targets.map(t => ({target: t})) : []);
                  const targets = queries.map(q => q.target ?? q.targetId).filter(Boolean);
                  if (targets.includes(resp.participant_id)) {
                    if (c.id > bestId) { bestId = c.id; best = c.participant_id; }
                  }
                } else if (tool === "loom_vote") {
                  if (resp.type === "vote_response" && resp.round === c.round) {
                    if (c.id > bestId) { bestId = c.id; best = c.participant_id; }
                  }
                } else if (tool === "loom_summon") {
                  if (resp.type === "summoned_response" && resp.round === c.round) {
                    if (c.id > bestId) { bestId = c.id; best = c.participant_id; }
                  }
                }
              } catch {}
            }
          }
        }
        return best;
      };

      const sortedAgentEntries = [...regularByAgent.entries()].sort((a, b) => {
        const aFirst = a[1][0];
        const bFirst = b[1][0];
        const aId = aFirst?.id ?? 0;
        const bId = bFirst?.id ?? 0;
        if (aId !== bId) return aId - bId;
        const aTime = aFirst?.created_at ? new Date(aFirst.created_at).getTime() : 0;
        const bTime = bFirst?.created_at ? new Date(bFirst.created_at).getTime() : 0;
        return aTime - bTime;
      });

      for (const [agentId, agentContribs] of sortedAgentEntries) {
        segItems.push({ type: "agent_turn", agentId, round, contributions: agentContribs });
        // loom_invocation rows intentionally not inserted — tool evidence lives in
        // the invoker's dialog Tool use tab; timeline shows only result rows
        // (query_response / evidence_response etc) for the invoked agents.
        if (round === activeRound && isWeaving) {
          for (const c of agentContribs) {
            if ((c.type === "challenge" || c.type === "dissent") && !reflectionsByTarget.has(c.id)) {
              for (const p of reflectingParticipants) {
                if (p.id !== c.participant_id) {
                  segItems.push({ type: "thinking_reflection", triggerContributionId: c.id, triggerType: c.type, triggerAgentName: participantName(c.participant_id), reflectorName: p.name, round });
                }
              }
            }
          }
          const queriedTargets = new Set();
          const evidenceTargets = new Set();
          const hasSummonCall = agentContribs.some(agc => (agc.tool_calls ?? []).some(tc => (tc.tool ?? tc.attempted_tool) === "loom_summon"));
          for (const c of agentContribs) {
            for (const tc of (c.tool_calls ?? [])) {
              const tool = tc.tool ?? tc.attempted_tool;
              if (!tool) continue;
              try {
                const input = typeof tc.input === "string" ? JSON.parse(tc.input) : tc.input;
                if (tool === "loom_query" || tool === "loom_evidence") {
                  const queries = input.queries ?? (Array.isArray(input.targets) ? input.targets.map(t => ({ target: t })) : []);
                  const qs = Array.isArray(queries) ? queries : [];
                  for (const q of qs) {
                    const tid = q.target ?? q.targetId;
                    if (tid) {
                      if (q.mode === "evidence" || tool === "loom_evidence") { evidenceTargets.add(tid); queriedTargets.delete(tid); }
                      else queriedTargets.add(tid);
                    }
                  }
                  if (input.target && !input.queries) {
                    const tid = input.target;
                    if (tool === "loom_evidence" || input.mode === "evidence") evidenceTargets.add(tid);
                    else queriedTargets.add(tid);
                  }
                }
              } catch {}
            }
          }
          for (const qp of queryingParticipants) {
            if (!queriedTargets.has(qp.id)) continue;
            const hasResponded = contribs.some(c => {
              if (!["query_response","perspective_response","critique_response"].includes(c.type)) return false;
              if (c.participant_id !== qp.id) return false;
              const invoker = findInvokerIdForResponse(c);
              return invoker === agentId;
            });
            if (!hasResponded) segItems.push({ type: "thinking_query", queriedAgentName: qp.name, round, invokerId: agentId });
          }
          for (const ep of evidenceParticipants) {
            if (!evidenceTargets.has(ep.id)) continue;
            const hasResponded = contribs.some(c => c.type === "evidence_response" && c.participant_id === ep.id && findInvokerIdForResponse(c) === agentId);
            if (!hasResponded) segItems.push({ type: "thinking_evidence", evidenceAgentName: ep.name, round, invokerId: agentId });
          }
          if (hasSummonCall) {
            const hasResponded = contribs.some(c => c.type === "summoned_response" && findInvokerIdForResponse(c) === agentId);
            if (!hasResponded && summoningParticipants.length > 0) {
              for (const sp of summoningParticipants) {
                segItems.push({ type: "thinking_summon", summonName: sp.name, round, invokerId: agentId });
                break;
              }
            }
          }
        }

        for (const c of agentContribs) {
          if (reflectionsByTarget.has(c.id)) {
            for (const r of reflectionsByTarget.get(c.id)) {
              consumedReflectionIds.add(r.id);
              segItems.push({ type: "reflection", reflection: r, round });
            }
          }
          if (queryResponsesByTarget.has(c.id)) {
            for (const qr of queryResponsesByTarget.get(c.id)) {
              consumedQueryIds.add(qr.id);
              segItems.push({ type: "query_response", queryResponse: qr, round });
            }
          }
          if (evidenceResponsesByTarget.has(c.id)) {
            for (const er of evidenceResponsesByTarget.get(c.id)) {
              consumedEvidenceIds.add(er.id);
              segItems.push({ type: "evidence_response", evidenceResponse: er, round });
            }
          }
          if (votesByTarget.has(c.id)) {
            for (const v of votesByTarget.get(c.id)) {
              consumedVoteIds.add(v.id);
              segItems.push({ type: "vote_response", voteResponse: v, round });
            }
          }
          if (c.batch_id) {
            if (queryByBatch.has(c.batch_id)) {
              for (const qr of queryByBatch.get(c.batch_id)) {
                if (!consumedQueryIds.has(qr.id)) {
                  consumedQueryIds.add(qr.id);
                  segItems.push({ type: qr.type, queryResponse: qr, perspectiveResponse: qr, critiqueResponse: qr, round, invokerId: c.participant_id });
                }
              }
            }
            if (evidenceByBatch.has(c.batch_id)) {
              for (const er of evidenceByBatch.get(c.batch_id)) {
                if (!consumedEvidenceIds.has(er.id)) {
                  consumedEvidenceIds.add(er.id);
                  segItems.push({ type: "evidence_response", evidenceResponse: er, round, invokerId: c.participant_id });
                }
              }
            }
            if (votesByBatch.has(c.batch_id)) {
              for (const v of votesByBatch.get(c.batch_id)) {
                if (!consumedVoteIds.has(v.id)) {
                  consumedVoteIds.add(v.id);
                  segItems.push({ type: "vote_response", voteResponse: v, round, invokerId: c.participant_id });
                }
              }
            }
            if (summonByBatch.has(c.batch_id)) {
              for (const sr of summonByBatch.get(c.batch_id)) {
                if (!consumedSummonIds.has(sr.id)) {
                  consumedSummonIds.add(sr.id);
                  segItems.push({ type: "summoned_response", summonedResponse: sr, round, invokerId: c.participant_id });
                }
              }
            }
          }
        }
        for (const [, list] of queryResponsesByTarget) {
          for (const qr of list) {
            if (consumedQueryIds.has(qr.id)) continue;
            const invoker = findInvokerIdForResponse(qr);
            if (invoker === agentId) {
              consumedQueryIds.add(qr.id);
              segItems.push({ type: qr.type, queryResponse: qr, perspectiveResponse: qr, critiqueResponse: qr, round, invokerId: agentId });
            }
          }
        }
        for (const [bid, list] of queryByBatch) {
          for (const qr of list) {
            if (consumedQueryIds.has(qr.id)) continue;
            const invoker = findInvokerIdForResponse(qr);
            if (invoker === agentId) {
              consumedQueryIds.add(qr.id);
              segItems.push({ type: qr.type, queryResponse: qr, perspectiveResponse: qr, critiqueResponse: qr, round, invokerId: agentId });
            }
          }
        }
        for (const [, list] of evidenceResponsesByTarget) {
          for (const er of list) {
            if (consumedEvidenceIds.has(er.id)) continue;
            const invoker = findInvokerIdForResponse(er);
            if (invoker === agentId) {
              consumedEvidenceIds.add(er.id);
              segItems.push({ type: "evidence_response", evidenceResponse: er, round, invokerId: agentId });
            }
          }
        }
        for (const [bid, list] of evidenceByBatch) {
          for (const er of list) {
            if (consumedEvidenceIds.has(er.id)) continue;
            const invoker = findInvokerIdForResponse(er);
            if (invoker === agentId) {
              consumedEvidenceIds.add(er.id);
              segItems.push({ type: "evidence_response", evidenceResponse: er, round, invokerId: agentId });
            }
          }
        }
        for (const [, list] of votesByTarget) {
          for (const v of list) {
            if (consumedVoteIds.has(v.id)) continue;
            const invoker = findInvokerIdForResponse(v);
            if (invoker === agentId) {
              consumedVoteIds.add(v.id);
              segItems.push({ type: "vote_response", voteResponse: v, round, invokerId: agentId });
            }
          }
        }
        for (const [bid, list] of votesByBatch) {
          for (const v of list) {
            if (consumedVoteIds.has(v.id)) continue;
            const invoker = findInvokerIdForResponse(v);
            if (invoker === agentId) {
              consumedVoteIds.add(v.id);
              segItems.push({ type: "vote_response", voteResponse: v, round, invokerId: agentId });
            }
          }
        }
        for (const [bid, list] of summonByBatch) {
          for (const sr of list) {
            if (consumedSummonIds.has(sr.id)) continue;
            const invoker = findInvokerIdForResponse(sr);
            if (invoker === agentId) {
              consumedSummonIds.add(sr.id);
              segItems.push({ type: "summoned_response", summonedResponse: sr, round, invokerId: agentId });
            }
          }
        }
        for (const sr of summonedResponses) {
          if (consumedSummonIds.has(sr.id)) continue;
          const invoker = findInvokerIdForResponse(sr);
          if (invoker === agentId) {
            consumedSummonIds.add(sr.id);
            segItems.push({ type: "summoned_response", summonedResponse: sr, round, invokerId: agentId });
          }
        }
        for (const [, list] of reflectionsByTarget) {
          for (const r of list) {
            if (consumedReflectionIds.has(r.id)) continue;
            const target = contribs.find(c => c.id === r.targets_which);
            if (target && target.participant_id === agentId) {
              consumedReflectionIds.add(r.id);
              segItems.push({ type: "reflection", reflection: r, round });
            }
          }
        }
      }

      // Thinking placeholders for not-yet-spoken agents — flat, padded left, directly
      // after the last finished agent's indented sub-tasks (per user request).
      // Previously this was prepended before all agent_turns, causing "is thinking..."
      // to appear ABOVE the prior agent (e.g., Librarian thinking above Enthusiast).
      if (round === activeRound && isWeaving && thinkingParticipants.length > 0) {
        const agentIdsInRound = new Set(regularByAgent.keys());
        const pendingThinking = thinkingParticipants.filter((p) => !agentIdsInRound.has(p.id));
        for (const p of pendingThinking) {
          segItems.push({ type: "thinking_turn", participant: p, round });
        }
      }

      for (const [, reflections] of reflectionsByTarget) {
        for (const r of reflections) {
          if (!consumedReflectionIds.has(r.id)) segItems.push({ type: "reflection", reflection: r, round });
        }
      }
      for (const [, queryResponses] of queryResponsesByTarget) {
        for (const qr of queryResponses) {
          if (!consumedQueryIds.has(qr.id)) {
            const invoker = findInvokerIdForResponse(qr);
            segItems.push({ type: qr.type, queryResponse: qr, perspectiveResponse: qr, critiqueResponse: qr, round, invokerId: invoker });
          }
        }
      }
      for (const [, evidenceResponses] of evidenceResponsesByTarget) {
        for (const er of evidenceResponses) {
          if (!consumedEvidenceIds.has(er.id)) {
            const invoker = findInvokerIdForResponse(er);
            segItems.push({ type: "evidence_response", evidenceResponse: er, round, invokerId: invoker });
          }
        }
      }
      for (const sr of summonedResponses) {
        if (!consumedSummonIds.has(sr.id)) {
          const invoker = findInvokerIdForResponse(sr);
          segItems.push({ type: "summoned_response", summonedResponse: sr, round, invokerId: invoker });
        }
      }
      for (const [, srs] of summonByBatch) {
        for (const sr of srs) {
          if (!consumedSummonIds.has(sr.id)) {
            const invoker = findInvokerIdForResponse(sr);
            segItems.push({ type: "summoned_response", summonedResponse: sr, round, invokerId: invoker });
            consumedSummonIds.add(sr.id);
          }
        }
      }
      for (const [, votes] of votesByTarget) {
        for (const v of votes) {
          if (!consumedVoteIds.has(v.id)) {
            const invoker = findInvokerIdForResponse(v);
            segItems.push({ type: "vote_response", voteResponse: v, round, invokerId: invoker });
          }
        }
      }
      for (const [, votes] of votesByBatch) {
        for (const v of votes) {
          if (!consumedVoteIds.has(v.id)) {
            const invoker = findInvokerIdForResponse(v);
            segItems.push({ type: "vote_response", voteResponse: v, round, invokerId: invoker });
            consumedVoteIds.add(v.id);
          }
        }
      }
      for (const [, qrs] of queryByBatch) {
        for (const qr of qrs) {
          if (!consumedQueryIds.has(qr.id)) {
            const invoker = findInvokerIdForResponse(qr);
            segItems.push({ type: qr.type, queryResponse: qr, perspectiveResponse: qr, critiqueResponse: qr, round, invokerId: invoker });
            consumedQueryIds.add(qr.id);
          }
        }
      }
      for (const [, ers] of evidenceByBatch) {
        for (const er of ers) {
          if (!consumedEvidenceIds.has(er.id)) {
            const invoker = findInvokerIdForResponse(er);
            segItems.push({ type: "evidence_response", evidenceResponse: er, round, invokerId: invoker });
            consumedEvidenceIds.add(er.id);
          }
        }
      }

      for (const tr of roundTurnRequests) segItems.push({ type: "turn_request", turnRequest: tr });
      for (const err of roundErrors) if (err.error_type === "model_fallback") segItems.push({ type: "model_fallback", error: err, round });

      const roundOrchestratorMessages = orchestratorMessages
        ? orchestratorMessages.filter((m) => m.round === round && (m.role === "user" || m.role === "assistant")).sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
        : [];
      const orchestratorGroups = pairOrchestratorMessages(roundOrchestratorMessages);
      for (const og of orchestratorGroups) segItems.push({ type: "orchestrator", group: og });

      const roundSummary = roundSummaries[round];
      const summaryMsgs = roundOrchestratorMessages.filter((m) => m.type === "summary");
      if (roundSummary && summaryMsgs.length === 0) {
        segItems.push({ type: "round_summary", round, summary: roundSummary, group: { query: null, response: { type: "summary", role: "assistant", content: roundSummary, created_at: null } } });
      }
    }

    out.push(...segItems);
  }

  return out;
}
