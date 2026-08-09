/** Participant tier — determines behavior, rights, and model selection. Any string is valid. */
export type Tier = string;

export type ProviderID = string;
export type ModelID = string;
export type Client = any;

/** Signature for sending a prompt to an LLM and receiving a text response. */
export type PromptFn = (system: string, model: { providerID: ProviderID; modelID: ModelID }, message: string) => Promise<string>;

export type ContributionType =
  | "propose"
  | "challenge"
  | "refine"
  | "support"
  | "dissent"
  | "synthesize"
  | "question"
  | "interjection";

/** Deliberation rights granted to a participant based on their tier. */
export interface TierRights {
  contribute: boolean;
  interject: boolean;
  call_vote: boolean;
  veto: boolean;
  force_end: boolean;
}

/** Model configuration for a participant tier. */
export interface TierModelConfig {
  model: string;
  temperature: number;
  reasoning_effort?: "low" | "medium" | "high";
}

/** Complete tier config combining model settings, behavioral guidance, and rights. */
export interface TierConfig extends TierModelConfig {
  system_prompt_addendum: string;
  rights: TierRights;
}

/** Maps a provider/model pair to a specific tier. */
export interface ModelAssignment {
  providerID: string;
  modelID: string;
  modelName?: string;
}

/** Static configuration for a meeting participant. */
export interface ParticipantConfig {
  id: string;
  name: string;
  persona: string;
  agenda: string;
  tier: Tier;
  model?: ModelAssignment;
  reason?: string;
  domain?: string;
}

/** A reusable persona template for composing deliberation rooms. */
export interface Persona {
  name: string;
  persona: string;
  agenda: string;
  domain: string;
  expertise: string[];
}

/** A single contribution from a participant during deliberation. */
export interface Contribution {
  participant_id: string;
  content: string;
  type: ContributionType;
  targets_which: string | null;
  timestamp: number;
}

/** A request from a participant to interrupt the normal speaking order. */
export interface Interjection {
  participant_id: string;
  priority: number;
  reason: string;
  granted: boolean;
  pushback: string | null;
  resolved: "pending" | "granted" | "denied" | "contested";
}

/** Record of a single deliberation round. */
export interface Round {
  number: number;
  contributions: Contribution[];
  interjections: Interjection[];
  token_path: string[];
  summary: string;
}

/** Transcript data reconstructed from the database for synthesis. */
export interface TranscriptRound {
  number: number;
  contributions: Contribution[];
  interjections: Interjection[];
  summary: string;
}

/** Full transcript data for the synthesizer. */
export interface TranscriptData {
  rounds: TranscriptRound[];
  warp: string;
  question: string;
}

/** An unresolved objection raised during deliberation. */
export interface Objection {
  participant_id: string;
  content: string;
  unresolved: boolean;
}

/** The synthesized output of a completed deliberation. */
export interface Artifact {
  content: string;
  format: "markdown" | "json" | "text";
  decisions: string[];
  action_items: string[];
  dissent: Objection[];
  open_questions: string[];
  confidence: "high" | "medium" | "low";
}

export type LoomStatus =
  | "initializing"
  | "waiting_for_user"
  | "weaving"
  | "converged"
  | "deadlocked"
  | "max_rounds_reached"
  | "aborted";

/** Runtime state of a participant during deliberation. */
export interface ParticipantState {
  config: ParticipantConfig;
  tier_config: TierConfig;
  session_id: string;
  status: "listening" | "speaking" | "interjecting" | "passed";
  reflection: string;
  contributions_count: number;
  reason?: string;
}

/** Complete runtime state of a Loom deliberation meeting. */
export interface LoomState {
  id: string;
  parent_session_id: string;
  question: string;
  context: string;
  participants: ParticipantState[];
  warp: string;
  weft: Contribution[];
  rounds: Round[];
  current_round: number;
  max_rounds: number;
  current_speaker_idx: number;
  status: LoomStatus;
  artifact: Artifact | null;
  objections: Objection[];
  convergence_mode: "consensus" | "majority" | "moderator_forces";
}

/** Output of the room composition process. */
export interface RoomRecommendation {
  participants: ParticipantConfig[];
  estimated_rounds: number;
  reasoning: string;
}

/** Parsed response from an agent after a deliberation turn. */
export interface AgentResponse {
  participant_id: string;
  content: string;
  type: ContributionType;
  interjection: {
    priority: number;
    reason: string;
  } | null;
}

/** Shared state persisted to files for cross-session communication. */
export interface SharedMeetingState {
  meeting_id: string;
  round: number;
  warp: string;
  question: string;
  contributions: Contribution[];
  interjections: Interjection[];
  status: LoomStatus;
}
