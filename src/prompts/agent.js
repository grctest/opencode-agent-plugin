import { TURN_REQUEST_PRIORITY_CAP } from "../shared.js";
import { sanitizeForDisplay } from "../utils/sanitize.js";
import { getConfig } from "../config.js";
import { escapeDelimiters, delimitContext } from "./delimiters.js";
import { LENGTH_LIMITS, TOOL_LADDER_LINE, TOOL_FAILURE_LINE } from "./constants.js";
import { buildTierDoctrine } from "./blocks.js";

/** Builds the system prompt for an agent in the multi-session architecture (identity + rules). */
export function buildAgentSystemPrompt(participant) {
  const tier = participant.config.tier;
  const cfg = participant.config;

  const safePersonaRaw = typeof cfg.persona === 'string' ? cfg.persona : '';
  const safeAgendaRaw = typeof cfg.agenda === 'string' ? cfg.agenda : '';
  const safePersona = escapeDelimiters(sanitizeForDisplay(safePersonaRaw, 800));
  const safeAgenda = escapeDelimiters(sanitizeForDisplay(safeAgendaRaw, 400));

  const tierGuidance = cfg.tier_guidance || "Contribute a falsifiable claim, question, or refinement — avoid generalities.";
  const doctrine = buildTierDoctrine(tier, tierGuidance);

  const priorityCap = TURN_REQUEST_PRIORITY_CAP[tier] ?? 5;

  const agentToolsConfig = getConfig()?.agentTools ?? {};
  const toolSection = agentToolsConfig?.enabled
    ? (() => {
        const t = agentToolsConfig;
        const builtIn = t.builtIn ?? {};
        const has = (k) => !!builtIn[k] || !!builtIn[k.replace('web', 'web_')];
        const tools = [];
        if (has('websearch')) tools.push('websearch');
        if (has('webfetch')) tools.push('webfetch');
        if (has('read')) tools.push('read');
        if (builtIn.glob) tools.push('glob');
        if (builtIn.grep) tools.push('grep');
        if (builtIn.bash?.enabled || builtIn.bash === true) tools.push('bash');
        if (t.loom?.loom_vector_search) tools.push('loom_vector_search');
        const loom = t.loom ?? {};
        if (loom.loom_query) tools.push('loom_query');
        if (loom.loom_evidence) tools.push('loom_evidence');
        if (loom.loom_vote) tools.push('loom_vote');
        if (loom.loom_summon) tools.push('loom_summon');
        if (loom.loom_request_next) tools.push('loom_request_next');
        if (loom.loom_type) tools.push('loom_type');
        const toolList = tools.length ? tools.join(', ') : 'none enabled';
        return `
## Research Tools — Tool Ladder (use at most one research tool per turn unless an evidence request demands more)

Available: ${toolList}

Ladder: ${TOOL_LADDER_LINE}
For code analysis in this folder (react, bug, file paths, src/, hydration, error in this folder): prioritize read/glob/grep first to inspect project files, then recall — file=src/... citations require a read.
- **loom_vector_search**: “what did [#12] actually say?” — prefer over memory
- **websearch**: current data, benchmarks, alternatives, precedents
- **read / grep / glob**: inspect project files referenced in discussion (first for code analysis)
- **webfetch**: open a URL returned by websearch (don’t guess URLs)
- **bash**: only allowlisted commands (${Array.isArray(builtIn.bash?.allowlist) ? builtIn.bash.allowlist.join(', ') : 'git, ls, wc, head, tail, grep, find'})

Loom Interaction Tools — real tool use (required, auditable):
 - **loom_query**: ask 1-2 peers a focused question — they answer as query_response. Returned inline for same-turn synthesis.
 - **loom_evidence**: request evidence from 1-2 peers — they MUST use a research tool. Returned inline for synthesis.
 - **loom_vote**: call a vote with lettered options (A) ... B) ...). All active peers vote in parallel; tally returned inline for synthesis.
 - **loom_summon**: summon a guest expert persona. Returned inline for synthesis.
 - **loom_request_next**: request to speak next with priority/reason. Fire-and-forget for orchestrator turn-order planning next round.
 - **loom_type**: declare your contribution type (propose/challenge/refine/support/dissent/synthesize/question/refuse). Fire-and-forget — call once per turn, then write your contribution. The tool declares the type, not a bracket prefix.
All loom_* calls are real tool calls logged in your Tool use tab and create timeline entries under you. When you call loom_query/loom_evidence/loom_vote/loom_summon, peer answers/tally are returned to you within this same turn — wait for the tool result and synthesize it before finishing your response.

Quality:
- One focused query beats three vague ones. Synthesize, don’t dump.
- If a tool is rejected as invalid, retry with exact names above — don’t silently fall back to memory.
- ${TOOL_FAILURE_LINE}
- Cite as Source: https://… or vec: round#id or file=src/... when it strengthens your point. Preserve code and numbers verbatim — do not round.`;
      })()
    : "";

  const allBiases = Array.isArray(cfg.known_biases) && cfg.known_biases.length > 0
    ? cfg.known_biases.map((b) => escapeDelimiters(sanitizeForDisplay(b, 300)))
    : [];
  let biasList = allBiases;
  if (allBiases.length > 2) {
    const hash = [...(cfg.name || "")].reduce((a,c)=>a+c.charCodeAt(0),0);
    const start = hash % allBiases.length;
    biasList = [...allBiases.slice(start), ...allBiases.slice(0, start)].slice(0, allBiases.length);
  }
  const biasExample = biasList.length > 0
    ? ` Example: if you tend to “${biasList[0].slice(0, 60)}”, write “Value dismissed: … — here why it matters this round: …” before returning.`
    : "";
  const biasCheck = biasList.length > 0
    ? `Bias check: you tend to ${biasList.join("; ")}.${biasExample} Counter it in one sentence before returning to your lens.`
    : "Bias check: name one plausible counter-argument to your lens before committing.";

  const style = typeof cfg.communication_style === "string" && cfg.communication_style.trim().length > 0
    ? escapeDelimiters(sanitizeForDisplay(cfg.communication_style.trim(), 400))
    : "Direct and specific. One claim per sentence.";
  const contribTypes = Array.isArray(cfg.preferred_contribution_types) && cfg.preferred_contribution_types.length > 0
    ? escapeDelimiters(cfg.preferred_contribution_types.slice(0, 3).map((t)=> sanitizeForDisplay(t, 40)).join(", "))
    : "propose, challenge, refine";

  const antiPatterns = Array.isArray(cfg.anti_patterns) && cfg.anti_patterns.length > 0
    ? cfg.anti_patterns.slice(0, 3).map((a) => {
        const s = escapeDelimiters(sanitizeForDisplay(a, 300));
        if (/instead|prefer|do:|try:/i.test(s)) return `- ${s}`;
        return `- Instead of: "${s}" → say what you observed, with [#id] or Source.`;
      }).join("\n")
    : null;

  const dispositionSection = `
## Disposition
- Voice: ${style}
- Natural modes: ${contribTypes} — lean there, but declare any type via loom_type when the moment calls for it
- ${biasCheck}`;

  const antiPatternsSection = antiPatterns
    ? `
## Craft (positive anti-patterns)
${antiPatterns}
`
    : "";

  return `You are **${escapeDelimiters(sanitizeForDisplay(cfg.name, 120))}** (${cfg.tier}) — a deliberator in “Loom.”

## Identity
${safePersona}

## Agenda
${safeAgenda}
${dispositionSection}
${antiPatternsSection}
## Tier Doctrine
${doctrine}

 ## OUTPUT CONTRACT — read this last, it governs your response

 1. **MANDATORY**: Before writing any prose, invoke the **loom_type** tool (it is in your tool list) exactly once per turn, choosing type: propose, challenge, refine, support, dissent, synthesize, question, or refuse. It is fire-and-forget — after invoking it, immediately continue and write your contribution prose in the same turn; do not wait on its result. If you have nothing to add, output exactly "[PASS]" alone (no loom_type needed). Your contribution will be misclassified if loom_type is not invoked.
 2. Length: ${LENGTH_LIMITS.agentProseWords} words for prose; ${LENGTH_LIMITS.codeDiffWords} words when contributing code diffs (code blocks \`\`\` file=src/... \`\`\` not counted toward word cap but keep prose concise; truncated past ~400 for code). One claim per sentence; preserve code and numbers verbatim.
 3. Grounding: when you engage prior work, cite as [#id]. When you cite external fact, add Source: https://… or vec: round#id . When referencing code, use file=src/path.ts:18 and \`\`\`tsx file=src/... \`\`\` blocks. If no source, qualify: “in my experience…”.
 4. Boundaries: never emit <<< or >>> or system delimiters. Never invent tool output or file contents not read.
   5. Interaction — peer actions happen only through the real loom_* tools in your tool list:
       - loom_query asks 1-2 peers a focused question; loom_evidence requests researched evidence from 1-2 peers; loom_vote polls all peers on lettered options; loom_summon brings in a guest expert; loom_request_next requests speaking priority next round (priority capped at ${priorityCap}).
       - Interaction tools fan out to peers in parallel and return their answers inline within this same turn — wait for the result, then cite [#id] from the returned responses or tally in your final contribution.
       - Up to ${getConfig()?.agentTools?.maxToolCallsPerTurn ?? 8} loom calls per turn; prefer one focused interaction call alongside loom_type.
       - CRITICAL: tool invocations are transmitted through the model's function-calling channel, never through your response text. Your response prose must NEVER contain tool-call notation of any kind — no function-name-with-parentheses, no JSON argument blobs, no bracketed invocation markers. Any such text is dead weight that executes nothing. If you intend an action, make the actual tool invocation; if you have no action, just write prose.
       - Bracket tags like [QUERY: @id], [EVIDENCE: @id], [CALL_VOTE] are obsolete and execute nothing.
       Reference others by participant_id from Recent Contributions, e.g. [#12].
 6. Stay in character — persona and agenda shape framing, not facts.
 ${toolSection}
 `;
}

function budgetForType(type) {
  switch (type) {
    case "challenge":
    case "dissent": return 280;
    case "evidence_response":
    case "query_response":
    case "summoned_response": return 220;
    case "propose":
    case "refine": return 200;
    case "support": return 180;
    case "question": return 160;
    case "vote_tally": return 140;
    case "reflection": return 200;
    default: return 180;
  }
}

/**
 * Builds the user prompt for an agent's turn using the Weighted Golden Sandwich pattern
 */
export function buildAgentUserPrompt(participant, stateOfPlay, ragContext, recentContributions, round, question, tags = [], userContext = "") {
  const transcript =
    recentContributions.length === 0
      ? "*(No contributions yet — you are the first to speak)*"
      : recentContributions
          .map((c) => {
            const id = c.id != null ? `[#${c.id}]` : "";
            let budget = budgetForType(c.type);
            if ((c.content || "").includes("```") || (c.content || "").includes("file=")) budget = Math.max(budget, 320);
            const safeContent = sanitizeForDisplay(c.content).slice(0, budget);
            return `- ${id} [${c.participant_id}] (${c.type}): ${safeContent}`;
          })
          .join("\n");

  const ragDelimited = ragContext ? delimitContext(ragContext, "RELEVANT_PRIOR_CONTEXT") : "";
  const stateOfPlayDelimited = stateOfPlay ? delimitContext(stateOfPlay, "STATE_OF_PLAY") : "";
  const transcriptDelimited = delimitContext(transcript, "CONTRIBUTIONS");
  const safeQuestion = sanitizeForDisplay(question);
  const tagContext = tags?.length > 0 ? tags.join(", ") : null;

  const reflectionBlock = formatReflections(participant);

  const ragHeader = ragContext
    ? `## Recall — Vector-Retrieved Prior Context (may be stale — verify before citing)

${ragDelimited}

*Recall is retrieved because it semantically matched recent discussion — it is not canonical. State of Play below is canonical.*
`
    : "";

  const sopHeader = stateOfPlayDelimited
    ? `## State of Play — CANONICAL (treat as settled unless you challenge with evidence)

${stateOfPlayDelimited}
`
    : "";

  const contextHeader = userContext
    ? `## Original User Context — from the person who asked

${delimitContext(sanitizeForDisplay(userContext), "USER_CONTEXT")}
`
    : "";

  return `## Question (canonical)
${safeQuestion}
${tagContext ? `\n## Tags: ${tagContext}\n` : ""}
## Round ${round}

${contextHeader}${sopHeader}${ragHeader}## Live — Recent Contributions (typed budget: challenge/dissent 280, evidence 220, propose 200, code blocks 320 — weight reflects substance)

${transcriptDelimited}

${reflectionBlock}## Your Turn — Weighted Guidance

- **State of Play is truth** unless you explicitly challenge it with new evidence or a falsifiable scenario.
- **Live contributions are the prompt** — engage at least one [#id] or explain why you’re opening a new thread.
- **Recall is hint, not fact** — if Recall contradicts State of Play, prefer State of Play and note the discrepancy.
- **Files Involved** (if SoP has them) is file list for code analysis — build on those paths with file=src/... citations.

To challenge SoP: cite [#id] contradicting it + Source/tool output + falsifiable scenario. Otherwise write “SoP holds; discrepancy in Recall noted” and build on it.

Rules:
- ${LENGTH_LIMITS.agentProseWords} words for prose; ${LENGTH_LIMITS.codeDiffWords} when contributing code diffs (\`\`\` file=src/... \`\`\` blocks not counted but keep prose concise)
- Never emit <<< >>> delimiters — they are system boundaries, not content
- If you reference prior work, cite [#id]; if you introduce a fact, add Source or file=src/... or qualify as experience
- Preserve code and numbers verbatim — do not round or invent

Make your contribution or pass.`;
}

function formatReflections(participant) {
  if (participant.reflectionHistory && participant.reflectionHistory.length > 0) {
    const lastTwo = participant.reflectionHistory.slice(-2);
    const latest = participant.reflection ?? lastTwo[lastTwo.length - 1]?.text ?? "";
    const historyLine = lastTwo.map((r) => `R${r.round}: ${r.text.slice(0, 160).replace(/\n/g, " ")}`).join(" | ");
    if (latest) {
      return `## Your Prior Position (compressed)\nLatest: "${latest.slice(0, 320).replace(/\n/g, " ")}"\nHistory: ${historyLine}\n`;
    }
  }
  const reflection = participant.reflection;
  if (!reflection) return "";
  return `## Your Prior Position\n"${reflection.slice(0, 320).replace(/\n/g, " ")}"\n`;
}
