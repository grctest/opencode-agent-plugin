import { parseAgentResponse } from "../src/validation.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

console.log("Testing validation...");

const pass = parseAgentResponse("p1", "[PASS]");
assert(pass.content === "[PASS]", "PASS detected");
assert(pass.type === "propose", "PASS type is propose");
assert(pass.interjection === null, "PASS has no interjection");

const propose = parseAgentResponse("p1", "[PROPOSE] We should use event-driven architecture");
assert(propose.content === "We should use event-driven architecture", "PROPOSE content parsed");
assert(propose.type === "propose", "PROPOSE type detected");

const challenge = parseAgentResponse("p2", "[CHALLENGE] This won't scale beyond 1000 req/s");
assert(challenge.type === "challenge", "CHALLENGE type detected");
assert(challenge.content === "This won't scale beyond 1000 req/s", "CHALLENGE content parsed");

const refine = parseAgentResponse("p3", "[REFINE] Add a cache layer in front of the database");
assert(refine.type === "refine", "REFINE type detected");

const support = parseAgentResponse("p1", "[SUPPORT] I agree with the event-driven approach");
assert(support.type === "support", "SUPPORT type detected");

const dissent = parseAgentResponse("p4", "[DISSENT] This adds unnecessary complexity");
assert(dissent.type === "dissent", "DISSENT type detected");

const question = parseAgentResponse("p2", "[QUESTION] What happens during network partitions?");
assert(question.type === "question", "QUESTION type detected");

const withInterjection = parseAgentResponse(
  "p3",
  "[CHALLENGE] Security concern [INTERJECT: Priority: 9, Reason: \"This has a critical auth bypass\"]",
);
assert(withInterjection.type === "challenge", "Type detected with interjection");
assert(withInterjection.interjection !== null, "Interjection detected");
assert(withInterjection.interjection?.priority === 9, "Interjection priority parsed");
assert(withInterjection.interjection?.reason.includes("auth bypass"), "Interjection reason parsed");
assert(withInterjection.content === "Security concern", "Content cleaned of interjection");

const malformed = parseAgentResponse("p1", "Just some random text without tags");
assert(malformed.type === "propose", "Default type for untagged text");
assert(malformed.content === "Just some random text without tags", "Untagged text preserved");

const empty = parseAgentResponse("p1", "");
assert(empty.content === "", "Empty string handled");

const whitespace = parseAgentResponse("p1", "   [PROPOSE]   Trimmed content   ");
assert(whitespace.content === "Trimmed content", "Whitespace trimmed");

console.log("  All validation tests PASS");
console.log("\nAll validation tests passed!");
