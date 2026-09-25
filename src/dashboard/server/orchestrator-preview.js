import {
  normalizeOrchestratorConfig,
  buildOrchestratorInstruction,
  getOrchestratorRoleSentence,
  getOrchestratorDecisionSentence,
  getOrchestratorCustomSentence,
  getSummaryGuidance,
  getSynthesisGuidance,
} from "../../orchestrator/models.js";
import { buildRoundSummarySystem, buildRoundSummaryUser } from "../../round-summarizer.js";
import { buildOrchestratorSynthesisSystem } from "../../synthesis-coordinator.js";
import { buildSynthesisPrompt } from "../../prompts/synthesis.js";
import { formatFinalRoundTranscript } from "../../state-of-play.js";
import { sanitizeForDisplay } from "../../utils/sanitize.js";

const MAX_PREVIEW_PARTICIPANTS = 7;
const MAX_PREVIEW_TEXT = 6000;
const KNOWN_TIERS = new Set(["junior", "mid", "senior", "principal", "civilian"]);

function previewText(value, maxLength) {
  return sanitizeForDisplay(String(value ?? ""), maxLength).trim();
}

function previewExcerpt(value) {
  const text = String(value ?? "");
  if (text.length <= MAX_PREVIEW_TEXT) return text;
  return `${text.slice(0, MAX_PREVIEW_TEXT)} …[truncated preview]`;
}

function sanitizePreviewParticipant(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const tier = KNOWN_TIERS.has(raw.tier) ? raw.tier : "mid";
  return {
    id: previewText(raw.id, 80) || `preview_${index + 1}`,
    name: previewText(raw.name, 80) || `Preview participant ${index + 1}`,
    tier,
    persona: previewText(raw.persona, 400),
    agenda: previewText(raw.agenda, 300),
  };
}

function fallbackPreviewParticipants() {
  return [
    { id: "preview_strategist", name: "Preview Strategist", tier: "senior", persona: "", agenda: "" },
    { id: "preview_operator", name: "Preview Operator", tier: "mid", persona: "", agenda: "" },
  ];
}

function sampleContributions(participants, question) {
  const topic = question || "the preview question";
  return participants.slice(0, 2).map((participant, index) => ({
    id: index + 1,
    participant_id: participant.id,
    type: index === 0 ? "contribution" : "evidence_response",
    content: index === 0
      ? `${participant.name} proposes an incremental response to ${topic}.`
      : `${participant.name} reports rollback evidence with Strength: strong. Source: https://example.com/rollback-evidence`,
    tool_calls: index === 0 ? [] : [{ tool: "read" }],
  }));
}

function sampleParticipantStates(participants) {
  return participants.slice(0, 2).map((participant) => ({
    id: participant.id,
    name: participant.name,
    tier: participant.tier,
    status: "listening",
    projected: false,
    state: {
      stance: `${participant.name} holds a provisional position.`,
      established: [],
      contested: [],
      open: [],
      facts: [],
      files: [],
      version: 1,
      updated_round: 1,
      updated_contribution_id: 1,
    },
  }));
}

function promptParticipants(participants) {
  return participants.map((participant) => ({
    config: { id: participant.id, name: participant.name, tier: participant.tier },
    status: "listening",
    contributions_count: 1,
    reflection: "",
    state_stance: "",
    state_bullets: [],
    state_version: 0,
  }));
}

export function buildOrchestratorPromptPreview(input = {}) {
  const config = normalizeOrchestratorConfig(input.orchestrator);
  const question = previewText(input.question, 5000) || "Should the team use the preview configuration?";
  const context = previewText(input.context, 2000);
  const supplied = Array.isArray(input.participants) ? input.participants : [];
  const participants = supplied.map(sanitizePreviewParticipant).filter(Boolean).slice(0, MAX_PREVIEW_PARTICIPANTS);
  const usedSetupParticipants = participants.length >= 2;
  const usedSetupQuestion = String(input.question ?? "").trim().length > 0;
  const usedSetupContext = String(input.context ?? "").trim().length > 0;
  const sampleParticipants = usedSetupParticipants ? participants.slice(0, 2) : fallbackPreviewParticipants();
  const contributions = sampleContributions(sampleParticipants, question);
  const participantStates = sampleParticipantStates(sampleParticipants);
  const sampleRound = { number: 1, contributions, turn_requests: [] };
  const sampleState = { question, tags: [] };
  const transcriptData = { question, tags: [], rounds: [{ number: 1, contributions }] };
  const sampleStateOfPlay = `Established: ${sampleParticipants[0].name} proposed an incremental response. Contested: ${sampleParticipants[1].name} requested rollback evidence.`;
  const objections = [{ participant_id: sampleParticipants[1].id, content: "Rollback evidence is missing.", unresolved: true }];
  // Mirror the runtime composition exactly: _promptOrchestrator injects only the
  // in-scope options, and role/posture/custom are out of scope for summaries —
  // so the previewed system is the clerk instruction alone (audit O3/Step 2).
  const summaryInstruction = buildOrchestratorInstruction(config, "summary");
  const roundSystem = summaryInstruction
    ? `${summaryInstruction}\n\n${buildRoundSummarySystem(config)}`
    : buildRoundSummarySystem(config);
  const roundUser = buildRoundSummaryUser(sampleRound, sampleState, participantStates);
  const synthesisSystem = buildOrchestratorSynthesisSystem(config);
  const synthesisUser = buildSynthesisPrompt(
    question,
    formatFinalRoundTranscript(transcriptData, promptParticipants(sampleParticipants)),
    promptParticipants(sampleParticipants),
    [],
    sampleStateOfPlay,
    objections,
    context,
    { decisionPosture: config.decisionPosture },
  );
  const customSentence = getOrchestratorCustomSentence(config);
  return {
    staticPreview: true,
    model: config.model,
    config,
    roundSummary: {
      title: "Round summary",
      appliesTo: "Called after each round with that round's transcript and agent states.",
      system: previewExcerpt(roundSystem),
      user: previewExcerpt(roundUser),
      impacts: [
        {
          key: "model",
          label: "Model",
          value: config.model ?? "Not selected",
          excerpt: config.model ?? "",
          effect: "The selected model performs the round-summary call when it is enabled and healthy.",
        },
        {
          key: "role",
          label: "Role / Persona",
          value: config.role,
          excerpt: getOrchestratorRoleSentence(config),
          effect: "Does not reach the round-summary prompt; applies to final synthesis (before the neutral synthesis auditor role).",
        },
        {
          key: "customInstructions",
          label: "Custom instructions",
          value: customSentence || "Not provided",
          excerpt: customSentence,
          effect: "Does not reach the round-summary prompt; applies to final synthesis when provided.",
        },
        {
          key: "decisionPosture",
          label: "Decision posture",
          value: config.decisionPosture,
          excerpt: getOrchestratorDecisionSentence(config),
          effect: "Does not reach the round-summary prompt; shapes final synthesis emphasis via the user-prompt doctrine.",
        },
        {
          key: "summaryStyle",
          label: "Summary style",
          value: config.summaryStyle,
          excerpt: getSummaryGuidance(config),
          effect: "Changes the round-summary system instruction from compact to thorough or exhaustive.",
        },
      ],
    },
    finalSynthesis: {
      title: "Final synthesis",
      appliesTo: "Called once with the final transcript, State of Play, objections, and user context.",
      system: previewExcerpt(synthesisSystem),
      user: previewExcerpt(synthesisUser),
      impacts: [
        {
          key: "model",
          label: "Model",
          value: config.model ?? "Not selected",
          excerpt: config.model ?? "",
          effect: "The selected model performs the final synthesis draft and critique when it is enabled and healthy.",
        },
        {
          key: "role",
          label: "Role / Persona",
          value: config.role,
          excerpt: getOrchestratorRoleSentence(config),
          effect: "Prepended to the final synthesis system instruction before the neutral synthesis auditor role.",
        },
        {
          key: "customInstructions",
          label: "Custom instructions",
          value: customSentence || "Not provided",
          excerpt: customSentence,
          effect: "Appended as operator instructions in the final synthesis system instruction when provided.",
        },
        {
          key: "decisionPosture",
          label: "Decision posture",
          value: config.decisionPosture,
          excerpt: getOrchestratorDecisionSentence(config),
          effect: "Shapes whether the final synthesis preserves disagreement, seeks consensus, or emphasizes actions.",
        },
        {
          key: "synthesisStyle",
          label: "Synthesis style",
          value: config.synthesisStyle,
          excerpt: getSynthesisGuidance(config),
          effect: "Changes whether synthesis leads with a decision, conversation, or technical audit.",
        },
      ],
    },
    unusedByThesePrompts: [
      {
        key: "turnOrderPolicy",
        label: "Turn-order policy",
        value: config.turnOrderPolicy,
        reason: "Turn-order policy changes next-round speaker planning, not the round-summary or final-synthesis prompt context.",
      },
    ],
    sampleProvenance: [
      { field: "Question", source: usedSetupQuestion ? "Current Step 1 draft" : "Synthetic fallback" },
      { field: "Context", source: usedSetupContext ? "Current Step 1 draft" : "Not provided" },
      { field: "Participant names", source: usedSetupParticipants ? "Current Step 3 seats" : "Synthetic fallback" },
      { field: "Contributions, states, objections, and State of Play", source: "Short synthetic fixture" },
    ],
    boundaryNote: "Internal LOOM data-boundary markers identify escaped deliberation data. They are context for the model, not instructions to follow.",
    notes: [
      "This preview uses a short synthetic deliberation and does not call a model.",
      `The round-summary excerpt uses the configured question${context ? " and context" : ""}.`,
      "Actual runtime text changes with real contributions, agent states, objections, degradation, and round number.",
    ],
  };
}
