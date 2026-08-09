import { z } from "zod";
import type { ContributionType } from "./types.js";

const ContributionTypeSchema = z.enum([
  "propose",
  "challenge",
  "refine",
  "support",
  "dissent",
  "synthesize",
  "question",
  "interjection",
]);

const InterjectionSchema = z.object({
  priority: z.number().int().min(1).max(10),
  reason: z.string().min(1).max(500),
});

const AgentResponseSchema = z.object({
  participant_id: z.string(),
  content: z.string(),
  type: ContributionTypeSchema,
  interjection: InterjectionSchema.nullable(),
});

export interface ValidatedAgentResponse {
  participant_id: string;
  content: string;
  type: ContributionType;
  interjection: { priority: number; reason: string } | null;
}

const TYPE_PREFIXES: Record<string, ContributionType> = {
  "[PROPOSE]": "propose",
  "[CHALLENGE]": "challenge",
  "[REFINE]": "refine",
  "[SUPPORT]": "support",
  "[DISSENT]": "dissent",
  "[SYNTHESIZE]": "synthesize",
  "[QUESTION]": "question",
};

/** Parses an agent's text response into a structured AgentResponse with type and optional interjection. */
export function parseAgentResponse(participantId: string, response: string): ValidatedAgentResponse | null {
  const text = response.trim();

  if (!text || text.length < 3) {
    return null;
  }

  if (text === "[PASS]") {
    return { participant_id: participantId, content: "[PASS]", type: "propose", interjection: null };
  }

  let type: ContributionType = "propose";
  let contentStart = 0;

  for (const [prefix, t] of Object.entries(TYPE_PREFIXES)) {
    if (text.startsWith(prefix)) {
      type = t;
      contentStart = prefix.length;
      break;
    }
  }

  const rawContent = text.slice(contentStart).trim();
  let interjection: { priority: number; reason: string } | null = null;

  const ijMatch = rawContent.match(
    /\[INTERJECT:\s*Priority:\s*(\d+),\s*Reason:\s*"([^"]+)"\]/i,
  );
  if (ijMatch) {
    const priority = Math.min(10, Math.max(1, parseInt(ijMatch[1])));
    const reason = ijMatch[2].trim();
    interjection = { priority, reason };
  }

  const cleanContent = rawContent.replace(/\[INTERJECT:\s*Priority:\s*\d+,\s*Reason:\s*"[^"]*"\]/i, "").trim();

  const result = AgentResponseSchema.safeParse({
    participant_id: participantId,
    content: cleanContent,
    type,
    interjection,
  });

  if (result.success) {
    return result.data;
  }

  return {
    participant_id: participantId,
    content: rawContent,
    type: "propose",
    interjection: null,
  };
}
