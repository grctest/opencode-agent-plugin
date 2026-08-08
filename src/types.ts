export type Tier = string;

export type ProviderID = string;
export type ModelID = string;
export type Client = any;
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

export interface TierRights {
  contribute: boolean;
  interject: boolean;
  call_vote: boolean;
  veto: boolean;
  force_end: boolean;
}

export interface TierModelConfig {
  model: string;
  temperature: number;
  reasoning_effort?: "low" | "medium" | "high";
}

export interface TierConfig extends TierModelConfig {
  system_prompt_addendum: string;
  rights: TierRights;
}

export interface ModelAssignment {
  providerID: string;
  modelID: string;
  modelName?: string;
}

export interface ParticipantConfig {
  id: string;
  name: string;
  persona: string;
  agenda: string;
  tier: Tier;
  model?: ModelAssignment;
}

export interface Contribution {
  participant_id: string;
  content: string;
  type: ContributionType;
  targets_which: string | null;
  timestamp: number;
}

export interface Interjection {
  participant_id: string;
  priority: number;
  reason: string;
  granted: boolean;
  pushback: string | null;
  resolved: "pending" | "granted" | "denied" | "contested";
}

export interface Round {
  number: number;
  contributions: Contribution[];
  interjections: Interjection[];
  token_path: string[];
  summary: string;
}

export interface Objection {
  participant_id: string;
  content: string;
  unresolved: boolean;
}

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

export interface ParticipantState {
  config: ParticipantConfig;
  tier_config: TierConfig;
  session_id: string;
  status: "listening" | "speaking" | "interjecting" | "passed";
  reflection: string;
  contributions_count: number;
}

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

export interface RoomRecommendation {
  participants: ParticipantConfig[];
  estimated_rounds: number;
  reasoning: string;
}

export interface AgentResponse {
  participant_id: string;
  content: string;
  type: ContributionType;
  interjection: {
    priority: number;
    reason: string;
  } | null;
}

export interface SharedMeetingState {
  meeting_id: string;
  round: number;
  warp: string;
  question: string;
  contributions: Contribution[];
  interjections: Interjection[];
  status: LoomStatus;
}
