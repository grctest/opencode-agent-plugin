import { getConfig } from "../config.js";
import { parseFastPathModel } from "../config/utils.js";
import { getDefaultModel } from "../services/model-service.js";
import { sortModelsByQuality } from "../model-discovery.js";
import { Logger, LoomError, extractErrorInfo } from "../logger.js";
import { sanitizeForDisplay } from "../utils/sanitize.js";
import { escapeDelimiters } from "../prompts/delimiters.js";
import { MAX_ORCHESTRATOR_MESSAGES } from "./constants.js";

export const ORCHESTRATOR_BEHAVIOR_DEFAULTS = {
  model: null,
  role: "neutral_facilitator",
  customInstructions: "",
  turnOrderPolicy: "balanced",
  summaryStyle: "balanced",
  decisionPosture: "preserve_spectrum",
  synthesisStyle: "decision_oriented",
};

const ORCHESTRATOR_ROLES = new Set(["neutral_facilitator", "rigorous_auditor", "decision_focused", "custom"]);
// Legacy value accepted for stored meetings predating the rename (audit O6).
const LEGACY_ROLE_ALIASES = { adversarial_reviewer: "rigorous_auditor" };
const TURN_ORDER_POLICIES = new Set(["balanced", "evidence_first", "anti_starvation"]);
const SUMMARY_STYLES = new Set(["concise", "balanced", "exhaustive"]);
const DECISION_POSTURES = new Set(["preserve_spectrum", "consensus_seeking", "action_oriented"]);
const SYNTHESIS_STYLES = new Set(["decision_oriented", "conversational", "technical_audit"]);

function behaviorEnum(value, allowed, fallback) {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

/**
 * Validates a raw orchestrator config, returning the normalized config plus
 * the list of rejected field values (audit O-audit Step 8). Rejection is
 * silent by design in normalizeOrchestratorConfig; this wrapper lets callers
 * surface it to the operator instead of silently coercing to defaults.
 */
export function validateOrchestratorConfig(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  const rejected = [];
  const check = (field, allowed) => {
    const v = value[field];
    if (v !== undefined && !(typeof v === "string" && allowed.has(v))) {
      rejected.push({ field, value: typeof v === "string" ? v.slice(0, 80) : typeof v });
    }
  };
  check("role", ORCHESTRATOR_ROLES);
  check("turnOrderPolicy", TURN_ORDER_POLICIES);
  check("summaryStyle", SUMMARY_STYLES);
  check("decisionPosture", DECISION_POSTURES);
  check("synthesisStyle", SYNTHESIS_STYLES);
  return { config: normalizeOrchestratorConfig(raw), rejected };
}

export function normalizeOrchestratorConfig(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  const role = LEGACY_ROLE_ALIASES[value.role] ?? value.role;
  return {
    model: typeof value.model === "string" && value.model ? value.model : null,
    role: behaviorEnum(role, ORCHESTRATOR_ROLES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.role),
    customInstructions: typeof value.customInstructions === "string" ? escapeDelimiters(sanitizeForDisplay(value.customInstructions.trim(), 4000)) : "",
    turnOrderPolicy: behaviorEnum(value.turnOrderPolicy, TURN_ORDER_POLICIES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.turnOrderPolicy),
    summaryStyle: behaviorEnum(value.summaryStyle, SUMMARY_STYLES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.summaryStyle),
    decisionPosture: behaviorEnum(value.decisionPosture, DECISION_POSTURES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.decisionPosture),
    synthesisStyle: behaviorEnum(value.synthesisStyle, SYNTHESIS_STYLES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.synthesisStyle),
  };
}

const ORCHESTRATOR_ROLE_LABELS = {
  neutral_facilitator: "a neutral facilitator who keeps the deliberation fair and inclusive",
  rigorous_auditor: "a rigorous auditor who stress-tests claims, evidence, and attribution in its own draft while staying neutral to all agendas",
  decision_focused: "a decision-focused coordinator who emphasizes actionable paths and tradeoffs",
  custom: "a custom coordinator following the operator's operating instructions",
};

const ORCHESTRATOR_DECISION_LABELS = {
  preserve_spectrum: "preserve meaningful disagreement and map the spectrum rather than forcing consensus",
  consensus_seeking: "look for a defensible consensus while keeping dissent visible",
  action_oriented: "prioritize concrete next actions, owners, and unresolved risks",
};

export function getOrchestratorRoleSentence(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  // role=custom with no instructions would dangle ("following the operator's
  // operating instructions" with none present) — fall back to neutral rather
  // than instructing the model to follow absent instructions (audit O6).
  const role = value.role === "custom" && !value.customInstructions ? "neutral_facilitator" : value.role;
  return `You are the Loom orchestrator: ${ORCHESTRATOR_ROLE_LABELS[role]}.`;
}

export function getOrchestratorDecisionSentence(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  return `Decision posture: ${ORCHESTRATOR_DECISION_LABELS[value.decisionPosture]}.`;
}

export function getOrchestratorCustomSentence(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  return value.customInstructions ? `Operator instructions: ${value.customInstructions}` : "";
}

/**
 * Which operator options may reach each orchestrator task's system prompt
 * (audit O3/Step 2). Style/policy options are consumed by their own task
 * builders (user prompt or dedicated guidance), so the shared instruction
 * block carries only what is meaningful for the task at hand.
 */
export const ORCHESTRATOR_OPTION_SCOPE = Object.freeze({
  summary: Object.freeze([]),
  turn_order: Object.freeze([]),
  moderation: Object.freeze(["role", "customInstructions"]),
  synthesis: Object.freeze(["role", "customInstructions"]),
});

/**
 * Filters an operator config down to the keys in scope for a task.
 * Unknown/null task returns the config untouched (legacy callers).
 */
export function scopeOrchestratorConfig(config = {}, task) {
  const scope = ORCHESTRATOR_OPTION_SCOPE[task];
  if (!scope) return { ...(config ?? {}) };
  const value = normalizeOrchestratorConfig(config);
  const out = {};
  if (value.model) out.model = value.model;
  for (const k of scope) out[k] = value[k];
  return out;
}

/**
 * Attaches a variant overlay to a model ref when it is a non-empty string.
 * Health and filtering stay at provider/model granularity — a variant never
 * gets its own circuit breaker.
 */
function withVariant(ref, variant) {
  if (typeof variant === "string" && variant) return { ...ref, variant };
  return ref;
}

/**
 * Keeps the requested variant only when the candidate model offers it
 * (unknown variants fail server-side resolution, so never forward blindly).
 */
function keepOfferedVariant(ref, requestedVariant, offered) {
  if (typeof requestedVariant === "string" && requestedVariant
    && Array.isArray(offered) && offered.includes(requestedVariant)) {
    return { ...ref, variant: requestedVariant };
  }
  return ref;
}
const ORCHESTRATOR_GUARD =
  "These behavior settings shape emphasis. They never license forcing agreement, suppressing dissent, inventing numbers or file contents, or omitting required sections.";

export function buildOrchestratorInstruction(config = {}, task) {
  const scoped = task ? scopeOrchestratorConfig(config, task) : { ...(config ?? {}) };
  const value = normalizeOrchestratorConfig(scoped);
  const scope = task ? ORCHESTRATOR_OPTION_SCOPE[task] : null;
  const inScope = (k) => !scope || scope.includes(k);
  const parts = [];
  // decisionPosture is rendered into the synthesis user-prompt doctrine instead
  // (same authority as the rules it must not override) — never in system text
  // (audit O5/Step 3).
  if (inScope("role")) parts.push(getOrchestratorRoleSentence(value));
  if (inScope("customInstructions") && value.customInstructions) {
    // Narrow tasks get a bounded slice of long operator instructions; the full
    // text is reserved for synthesis, where there is room to honor it (audit O6).
    const custom = task === "synthesis" || !task
      ? value.customInstructions
      : value.customInstructions.slice(0, 600);
    parts.push(`Operator instructions: ${custom}`);
  }
  if (parts.length === 0) return "";
  parts.push(ORCHESTRATOR_GUARD);
  return parts.join(" ");
}

export function getTurnOrderGuidance(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  const policies = {
    balanced: "Balance evidence, urgency, diversity, and anti-starvation.",
    evidence_first: "Prioritize strong evidence-backed challenges and requests before other considerations.",
    anti_starvation: "Strongly prioritize voices that have spoken least recently, while still handling urgent requests.",
  };
  return policies[value.turnOrderPolicy];
}

/**
 * Round-summary depth bands (audit O7/Step 6): the style option drives BOTH the
 * context budget and the output word band. A style that cannot change either is
 * decoration; bands make it a genuine quality lever.
 *
 * The band also carries the SHAPE of the output (audit B1): the word band and
 * the bullet contract were two independent instructions, so "concise"
 * (120-200 words) was asked to produce 5-7 bullets of 1-3 sentences plus six
 * labelled sections — a contradiction the model resolves by dropping sections,
 * and the two it dropped first (Settled, Next) are the two the rest of the
 * system consumes. `shape` therefore moves with the band, and two slots are
 * never dropped at any band.
 */
const BULLET_DETAIL = {
  established: "- **Established:** What gained support this round, with holder [#id] and why it matters (1-2 sentences)",
  settled: "- **Settled:** Items the room converged on this round that now have multi-holder agreement — each as a one-line claim with [#id] refs (e.g. \"- Both name the same two riskiest failure modes: token refresh and stale-cache invalidation — identical scope, different severity rating [#9][#12]\"). These feed the meeting-level settled registry. If nothing newly converged, write \"None this round\". Converged term definitions (what counts, how scored, scope) belong here from round 1 — write them plainly so later rounds cite them by [#id].",
  contested: "- **Contested:** What remains disputed — name holders and their distinct positions [#id]; map the spectrum, don’t collapse to “disagreement”. Include a stance audit from the Agent States block below: when a participant's recorded stance contradicts a concession they made in-room this round, name them (\"retains X despite conceding Y in [#id]\").",
  evidence: "- **Evidence:** Tool or vec-grounded evidence introduced (Source or [#id] with Strength: strong/weak/inconclusive); or “None — no new evidence this round” — never emit vec: / vec round traces, use State-of-Play or [#id]",
  open: "- **Open:** Unresolved questions and what would resolve them (missing evidence / decision needed). If an open question from a prior round is still open and has no new source attached, flag it “still un-researched”.",
  next: "- **Next:** One line — the single decision or output the next round must produce: who must defend, concede, or produce what, against which gate. Direct, not descriptive.",
  code: "- **Code/Files:** Files touched or proposed (file=src/...), diffs status, and test/verification notes",
};

export const ORCHESTRATOR_SUMMARY_BANDS = Object.freeze({
  concise: Object.freeze({
    words: "120-200",
    budget: 6000,
    shape: "3-4 bullets, one line each — required: Settled, Contested, Next. Add Established only when something genuinely gained support; fold the evidence into the bullet that carries it; keep Open to one line only when something is genuinely open.",
    bullets: Object.freeze([
      "- **Settled:** one line per newly converged item, with [#id] refs — or \"None this round\"",
      "- **Contested:** what remains disputed — name the holders and their positions [#id]",
      "- **Next:** one line — the single decision or output the next round must produce",
      "- **Established** (only if something genuinely gained support) and **Open** (only if something is genuinely open): one line each, with the evidence folded into the bullet that carries it",
    ]),
  }),
  balanced: Object.freeze({
    words: "180-350",
    budget: 12000,
    shape: "5-7 bullets, each 1-3 sentences — Established, Settled, Contested, Evidence, Open, Next",
    bullets: Object.freeze([
      BULLET_DETAIL.established, BULLET_DETAIL.settled, BULLET_DETAIL.contested,
      BULLET_DETAIL.evidence, BULLET_DETAIL.open, BULLET_DETAIL.next,
    ]),
  }),
  exhaustive: Object.freeze({
    words: "350-600",
    budget: 20000,
    shape: "7-9 bullets, each 2-4 sentences with named holders — Established, Settled, Contested, Evidence, Open, Next (+ Code/Files)",
    bullets: Object.freeze([
      BULLET_DETAIL.established, BULLET_DETAIL.settled, BULLET_DETAIL.contested,
      BULLET_DETAIL.evidence, BULLET_DETAIL.open, BULLET_DETAIL.next, BULLET_DETAIL.code,
    ]),
  }),
});

/**
 * Slots the room depends on. The settled registry is fed by the clerk's
 * Settled bullet and the next round's steer by its Next bullet — so they are
 * written as "None this round" rather than omitted (audit B1).
 */
export const ORCHESTRATOR_SUMMARY_ALWAYS = "Settled and Next are never omitted — write \"None this round\" instead of leaving the slot out.";

/** The Code/Files bullet — added to a code round at any band that does not carry it. */
export const ORCHESTRATOR_SUMMARY_CODE_BULLET = BULLET_DETAIL.code;

export function getSummaryBand(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  return ORCHESTRATOR_SUMMARY_BANDS[value.summaryStyle] ?? ORCHESTRATOR_SUMMARY_BANDS.balanced;
}

/**
 * Option → context coupling (audit O1/Step 6): returns what each task's context
 * window should contain given the operator config. Summary gets budget+band;
 * turn planning gets composition flags; synthesis context is comprehensive by
 * design (full transcript + SoP) with style operating on framing.
 */
export function orchestratorContextPolicy(config = {}, task) {
  const value = normalizeOrchestratorConfig(config);
  if (task === "summary") {
    const band = getSummaryBand(value);
    return { words: band.words, budget: band.budget, shape: band.shape };
  }
  // The old "turn_order" task is gone: the summary call is the orchestrator's
  // single LLM call per round and it sets the next round's order through the
  // loom_set_turn_order tool, steered by getTurnOrderGuidance(). There is no
  // separate planner context to shape (audit E3).
  return {};
}

export function getSummaryGuidance(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  const styles = {
    concise: "Be concise: emphasize decisions, major evidence, and open questions without repeating the transcript.",
    balanced: "Be thorough but compact: preserve nuance, evidence, dissent, and unresolved tradeoffs.",
    exhaustive: "Be exhaustive: retain material details, competing positions, evidence, and open threads.",
  };
  // Contract-enforcement tail — always on, independent of customInstructions:
  // restatement/gate consolidation are referee duties, not style preferences
  // (the clerk is the only participant that sees the whole round).
  const refereeTail = " Enforce the room's own contract in what you read: note any contribution that re-states State of Play or its own prior position without a delta — name the largest by [#id]. When two or more contributions carry mutually overlapping thresholds or projections, name the single live version (or the tiered ladder they compose) and mark older ones superseded — never record parallel duplicates as if equally live. In late rounds (3+), state whether a decision rule (trigger + date + owner) exists for the final artifact.";
  return styles[value.summaryStyle] + refereeTail;
}

const SYNTHESIS_GUIDANCE_STYLES = {
  decision_oriented: "Lead with a clear decision or spectrum, then support it with grounded reasoning and action items.",
  conversational: "Lead with a human-readable synthesis of the conversation before formal decision structure.",
  technical_audit: "Lead with a technical audit: files, evidence, risks, verification, and concrete proposed fixes.",
  // Internal clamp target for technical_audit on non-code questions (audit
  // O8): code-free audit framing. Not a selectable enum value.
  technical_audit_conversational: "Lead with a technical audit: claims, evidence quality, risks, verification status, and unresolved blockers.",
};

export function getSynthesisGuidance(config = {}) {
  // Accept the internal conversational-clamp key directly: routing it through
  // normalizeOrchestratorConfig would coerce it back to the default.
  if (config?.synthesisStyle === "technical_audit_conversational") {
    return SYNTHESIS_GUIDANCE_STYLES.technical_audit_conversational;
  }
  const value = normalizeOrchestratorConfig(config);
  return SYNTHESIS_GUIDANCE_STYLES[value.synthesisStyle];
}

export function _modelList() {
    return this._stateManager.getParticipants().map((p) => ({ category: p.config.category ?? p.config.tier, model: p.config.model }));
  }

export function _getDefaultModel() {
    return getDefaultModel(this._modelList(), this._availableModels);
  }

export function _getOrchestratorModel() {
    const configured = this._options?.orchestratorModel;
    if (configured?.providerID && configured?.modelID) {
      const model = withVariant({ providerID: configured.providerID, modelID: configured.modelID }, configured.variant);
      if (this._roundExecutor?.isModelHealthy?.(model)) return model;
      return this._getAllowedFallbackModel(model.variant) ?? this._getDefaultModel();
    }
    return this._getDefaultModel() ?? this._getAllowedFallbackModel();
  }

export function _getAllowedFallbackModel(requestedVariant = null) {
    if (!this._availableModels || this._availableModels.length === 0) return null;
    let pool = this._availableModels;
    // Filter to healthy models if executor is available (respects global unhealthy)
    if (this._roundExecutor) {
      try { pool = pool.filter((m) => this._roundExecutor.isModelHealthy(m)); } catch {}
      if (pool.length === 0) return null;
    }
    const sorted = sortModelsByQuality(pool);
    const best = sorted[0];
    const ref = { providerID: best.providerID, modelID: best.modelID };
    return keepOfferedVariant(ref, requestedVariant, best.variants);
  }

export function _getParticipantModel(participant, fallbackOnError = false) {
    if (participant.config.model) {
      const model = withVariant(
        { providerID: participant.config.model.providerID, modelID: participant.config.model.modelID },
        participant.config.model.variant,
      );
      if (fallbackOnError) {
        if (this._roundExecutor && this._roundExecutor.isModelHealthy(model)) {
          return model;
        }
        const fallback = this._getAllowedFallbackModel(model.variant);
        if (fallback) return fallback;
      }
      return model;
    }
    const fallback = this._getAllowedFallbackModel() ?? this._getDefaultModel();
    if (fallback) return fallback;
    throw new LoomError(
      `No model assigned for participant ${participant.config.name} (${participant.config.category ?? participant.config.tier ?? "unknown"})`,
      { phase: "model_assignment", participantId: participant.config.id, recoverable: false }
    );
  }

export async function _promptOrchestrator(system, model, message, type = "orchestrator", round = null) {
    const cfg = getConfig();
    const fastPathModel = cfg.fastPathModelObj ?? parseFastPathModel(cfg.fastPathModel);
    const useModel = (!this._options?.orchestratorModel && fastPathModel && (type === "moderation" || type === "summary"))
      ? fastPathModel
      : model;

    this._callStats[type] = (this._callStats[type] ?? 0) + 1;
    this._scheduleStatsFlush?.();
    if (this._orchestratorMessages.length >= MAX_ORCHESTRATOR_MESSAGES) {
      this._orchestratorMessages.shift();
    }
    const safeMessage = (message ?? "").toString();
    this._orchestratorMessages.push({ type, role: "user", content: safeMessage, round, timestamp: Date.now() });
    if (this._database) {
      this._database.addOrchestratorMessage(type, "user", safeMessage, round);
    }
    const timeoutMs = type === "moderation" ? 60000 : type === "summary" ? 90000 : type === "turn_order" ? 30000 : undefined;
    const instruction = buildOrchestratorInstruction(this._options?.orchestratorConfig, type);
    const orchestratorSystem = instruction ? `${instruction}\n\n${system ?? ""}` : (system ?? "");
    // Summaries run on a fresh ephemeral session each round: the shared
    // persistent session would otherwise accumulate every round's prompt and
    // reply (O(R²) growth, 93% self-anchoring by round 10 — audit O10). The
    // summary call is the orchestrator's single LLM call per round: it also
    // carries the orchestrator-only turn-order tool, so a warranted order
    // change needs no second planning call (no call means default order).
    const summaryTools = { loom_set_turn_order: true };
    const { text: response } = type === "summary" && typeof this._sessionManager.promptOrchestratorEphemeral === "function"
      ? await this._sessionManager.promptOrchestratorEphemeral(orchestratorSystem, useModel, message, timeoutMs, { tools: summaryTools, meetingId: this._meetingId })
      : await this._sessionManager.promptOrchestrator(orchestratorSystem, useModel, message, timeoutMs);
    const safeResponse = (response ?? "").toString();
    if (!safeResponse.trim()) {
      this._logger.warn("orchestrator_empty_response", `Orchestrator returned empty text for type=${type} round=${round}`, { type, round });
    }
    if (this._orchestratorMessages.length >= MAX_ORCHESTRATOR_MESSAGES) {
      this._orchestratorMessages.shift();
    }
    this._orchestratorMessages.push({ type, role: "assistant", content: safeResponse, round, timestamp: Date.now() });
    if (this._database) {
      this._database.addOrchestratorMessage(type, "assistant", safeResponse, round);
    }
    return safeResponse;
  }

