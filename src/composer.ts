import type { ParticipantConfig, RoomRecommendation, Tier } from "./types.js";

const JUNIOR_PERSONAS = [
  {
    name: "Creative Intern",
    persona: "You bring unconventional perspectives and aren't bound by industry assumptions.",
    agenda: "Challenge conventional thinking and propose bold alternatives",
  },
  {
    name: "Fresh Graduate",
    persona: "You have academic knowledge but limited industry experience. You ask fundamental questions others might skip.",
    agenda: "Ensure foundational assumptions are validated",
  },
];

const MID_PERSONAS = [
  {
    name: "Practicing Engineer",
    persona: "You have hands-on experience building and shipping similar systems.",
    agenda: "Ensure proposals are practical and implementable",
  },
  {
    name: "Product Thinker",
    persona: "You focus on user needs, business value, and market fit.",
    agenda: "Keep the deliberation grounded in real user outcomes",
  },
  {
    name: "Operations Specialist",
    persona: "You own deployment, monitoring, and reliability.",
    agenda: "Ensure solutions can be operated safely in production",
  },
];

const SENIOR_PERSONAS = [
  {
    name: "Senior Architect",
    persona: "You design large-scale systems and have seen multiple technology cycles.",
    agenda: "Prevent over-engineering and ensure long-term maintainability",
  },
  {
    name: "Principal Engineer",
    persona: "You have deep technical expertise and organizational influence.",
    agenda: "Identify the highest-leverage solution and drive toward decision",
  },
];

const PRINCIPAL_PERSONAS = [
  {
    name: "Decision Maker",
    persona: "You own the final call. You have the full context of business constraints.",
    agenda: "Ensure a clear, actionable decision is reached",
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

function detectStakes(question: string): "high" | "medium" | "low" {
  const q = question.toLowerCase();
  if (HIGH_STAKES_KEYWORDS.some((k) => q.includes(k))) return "high";
  if (MEDIUM_STAKES_KEYWORDS.some((k) => q.includes(k))) return "medium";
  return "low";
}

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
  if (available.length === 0) return null;

  const choice = available[Math.floor(Math.random() * available.length)];
  used.add(choice.name);

  return {
    id: `${tier}_${choice.name.toLowerCase().replace(/\s+/g, "_")}`,
    name: choice.name,
    persona: choice.persona,
    agenda: choice.agenda,
    tier,
  };
}

export function composeRoom(question: string): RoomRecommendation {
  const stakes = detectStakes(question);
  const used = new Set<string>();
  const participants: ParticipantConfig[] = [];

  if (stakes === "high") {
    for (const tier of ["senior", "senior", "mid", "mid", "principal"] as Tier[]) {
      const p = pickPersona(tier, used);
      if (p) participants.push(p);
    }
  } else if (stakes === "medium") {
    for (const tier of ["senior", "mid", "mid", "junior"] as Tier[]) {
      const p = pickPersona(tier, used);
      if (p) participants.push(p);
    }
  } else {
    for (const tier of ["mid", "junior", "junior"] as Tier[]) {
      const p = pickPersona(tier, used);
      if (p) participants.push(p);
    }
  }

  const estimated_rounds = Math.min(5, participants.length);

  return {
    participants,
    estimated_rounds,
    reasoning:
      stakes === "high"
        ? "High-stakes topic. Senior-heavy room with principal decision authority."
        : stakes === "medium"
          ? "Medium complexity. Balanced room with senior oversight and junior creativity."
          : "Exploratory topic. Lean room with fresh perspectives.",
  };
}

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
