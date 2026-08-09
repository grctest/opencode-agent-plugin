import type { ParticipantConfig, RoomRecommendation, Tier } from "./types.js";

const JUNIOR_PERSONAS = [
  {
    name: "Devil's Advocate",
    persona: "You challenge every assumption. You play the role of a skeptical user who will break things. You ask 'what could go wrong?' about everything.",
    agenda: "Surface risks and blind spots that others miss. Ensure no proposal goes unchallenged.",
  },
  {
    name: "Fresh Eyes",
    persona: "You have no legacy context. You ask naive questions that expose hidden complexity. You think like a new hire on day one.",
    agenda: "Ensure proposals are explainable to newcomers. Identify unnecessary complexity.",
  },
  {
    name: "Creative Disruptor",
    persona: "You think outside the box. You propose unconventional solutions. You've studied how other industries solve similar problems.",
    agenda: "Bring fresh perspectives from outside the domain. Challenge 'we've always done it this way'.",
  },
];

const MID_PERSONAS = [
  {
    name: "Systems Engineer",
    persona: "You build production systems. You think about edge cases, failure modes, and observability. You've debugged distributed systems at 3am.",
    agenda: "Ensure proposals are implementable and operable. Flag reliability concerns early.",
  },
  {
    name: "Product Manager",
    persona: "You own the user experience. You think about tradeoffs between features, time, and quality. You've shipped products that users love.",
    agenda: "Keep the discussion grounded in user value. Ensure we solve the right problem, not just the fun problem.",
  },
  {
    name: "Data Analyst",
    persona: "You back decisions with evidence. You think about metrics, measurement, and validation. You've seen too many decisions made on gut feeling.",
    agenda: "Demand evidence for claims. Ensure success is measurable. Propose experiments over assumptions.",
  },
];

const SENIOR_PERSONAS = [
  {
    name: "Staff Architect",
    persona: "You design systems that last decades. You've seen technology fads come and go. You think in terms of evolution, not revolution.",
    agenda: "Ensure architectural coherence. Prevent over-engineering. Protect long-term maintainability over short-term speed.",
  },
  {
    name: "Security Engineer",
    persona: "You assume breach. You think about threat models, attack surfaces, and defense in depth. You've responded to incidents.",
    agenda: "Identify security implications of every proposal. Ensure we don't trade safety for convenience.",
  },
  {
    name: "Performance Engineer",
    persona: "You measure everything. You think about latency percentiles, throughput bottlenecks, and capacity planning. You've optimized systems under load.",
    agenda: "Ensure proposals consider performance implications. Demand benchmarks over assumptions.",
  },
];

const PRINCIPAL_PERSONAS = [
  {
    name: "Technical Director",
    persona: "You own the technical strategy. You balance innovation with stability. You've led engineering organizations through change.",
    agenda: "Drive toward a clear, actionable decision. Ensure the outcome aligns with organizational goals. Cut through circular debate.",
  },
  {
    name: "Engineering Lead",
    persona: "You ship. You know the difference between perfect and good enough. You've delivered complex projects on time.",
    agenda: "Ensure we reach a decision and move forward. Prevent analysis paralysis. Protect team velocity.",
  },
];

const HIGH_STAKES_KEYWORDS = [
  "migration",
  "architecture",
  "security",
  "compliance",
  "data loss",
  "downtime",
  "production",
  "irreversible",
  "deprecate",
  "shutdown",
  "financial",
  "revenue",
  "customer data",
  "gdpr",
  "hipaa",
];

const MEDIUM_STAKES_KEYWORDS = [
  "refactor",
  "redesign",
  "framework",
  "library",
  "api design",
  "performance",
  "optimization",
  "testing",
  "ci/cd",
  "deployment",
];

/** Classifies the stakes of a question based on keywords (e.g., "migration", "security"). */
function detectStakes(question: string): "high" | "medium" | "low" {
  const q = question.toLowerCase();
  if (HIGH_STAKES_KEYWORDS.some((k) => q.includes(k))) return "high";
  if (MEDIUM_STAKES_KEYWORDS.some((k) => q.includes(k))) return "medium";
  return "low";
}

/** Picks a random unused persona for a given tier. Returns null if all personas are used. */
function pickPersona(tier: Tier, used: Set<string>): ParticipantConfig | null {
  const pool =
    tier === "junior"
      ? JUNIOR_PERSONAS
      : tier === "mid"
        ? MID_PERSONAS
        : tier === "senior"
          ? SENIOR_PERSONAS
          : PRINCIPAL_PERSONAS;

  const available = pool.filter((p) => !used.has(p.name));
  const choice = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : pool[Math.floor(Math.random() * pool.length)];

  used.add(choice.name);

  return {
    id: `${tier}_${choice.name.toLowerCase().replace(/\s+/g, "_")}`,
    name: choice.name,
    persona: choice.persona,
    agenda: choice.agenda,
    tier,
  };
}

/** Composes a deliberation room by analyzing the question and generating appropriate participants. */
export function composeRoom(question: string, desiredCount?: number): RoomRecommendation {
  const stakes = detectStakes(question);
  const used = new Set<string>();
  const participants: ParticipantConfig[] = [];

  const defaultCount = stakes === "high" ? 5 : stakes === "medium" ? 4 : 3;
  const count = desiredCount ?? defaultCount;

  const roles = generateRoles(count, stakes);

  for (const role of roles) {
    const p = pickPersona(role, used);
    if (p) participants.push(p);
  }

  const estimated_rounds = Math.min(5, participants.length);

  return {
    participants,
    estimated_rounds,
    reasoning: `${count}-person deliberation for ${stakes}-stakes topic: ${roles.join(", ")}.`,
  };
}

/** Generates a list of role names for the deliberation based on participant count and stakes. */
function generateRoles(count: number, stakes: string): string[] {
  const roles: string[] = [];

  if (stakes === "high") {
    roles.push("principal", "senior", "senior");
    while (roles.length < count) {
      roles.push(roles.length % 2 === 0 ? "mid" : "junior");
    }
  } else if (stakes === "medium") {
    roles.push("senior", "mid");
    while (roles.length < count) {
      roles.push(roles.length % 2 === 0 ? "mid" : "junior");
    }
  } else {
    roles.push("mid", "junior");
    while (roles.length < count) {
      roles.push("junior");
    }
  }

  return roles.slice(0, count);
}

/** Formats the room composition as a markdown preview for user approval. */
export function formatRoomPreview(room: RoomRecommendation): string {
  const lines = [
    "## Proposed Deliberation Room",
    "",
    room.reasoning,
    "",
    "| # | Name | Tier | Agenda |",
    "|---|------|------|--------|",
  ];
  room.participants.forEach((p, i) => {
    lines.push(`| ${i + 1} | ${p.name} | ${p.tier} | ${p.agenda} |`);
  });
  lines.push("");
  lines.push(`Estimated rounds: ${room.estimated_rounds}`);
  lines.push("");
  lines.push("To start, confirm this room or specify changes (e.g. 'add a security expert', 'make the architect a principal').");
  return lines.join("\n");
}
