// The guard at the funnel, and the two provider rejections it exists to prevent.
//
// Every LLM call goes through SessionContract.prompt, so that is where the
// per-model input ceiling is enforced. Callers that can trim by block priority
// do so first; this is the backstop for everything else. Provider refusals —
// context overflow and token-budget exhaustion — are classified here so they
// degrade a turn instead of dying opaquely or being retried into a wall.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionContract } from "../src/session-contract.js";
import {
  classifyInputRejectionError,
  isInputRejectionError,
  isRetryableError,
  classifyRateLimitError,
} from "../src/utils/retry.js";

const WINDOWS = { "provider/small": 32000, "provider/giant": 1000000 };
const resolveContextLimit = (model) => WINDOWS[`${model?.providerID}/${model?.modelID}`] ?? null;

/** Fake SDK client that records the body it was handed. */
function fakeClient(result = { data: { parts: [{ type: "text", text: "ok" }] } }) {
  const sent = { body: null, count: 0 };
  return {
    sent,
    session: {
      prompt: ({ body }) => { sent.body = body; sent.count += 1; return Promise.resolve(result); },
      abort: async () => {},
    },
  };
}

const SMALL = { providerID: "provider", modelID: "small" };
const GIANT = { providerID: "provider", modelID: "giant" };

// ------------------------------------------------------- the funnel backstop

test("an over-budget prompt is cut before it reaches the provider", async () => {
  const client = fakeClient();
  const contract = new SessionContract(client, "/tmp", null, { resolveContextLimit });
  const result = await contract.prompt({
    sessionId: "s1",
    system: "SYSTEM",
    model: SMALL,
    parts: [{ type: "text", text: "T".repeat(400000) }],
  });
  assert.equal(result.ok, true);
  const body = client.sent.body;
  const chars = body.system.length + body.parts[0].text.length;
  assert.ok(chars <= 32000 * 0.85 * 4 + 1, `payload still over the 32k window: ${chars}`);
  assert.equal(body.system, "SYSTEM", "the system prompt must survive the backstop");
});

test("the limit applied is the window of the model the call actually uses", async () => {
  const client = fakeClient();
  const contract = new SessionContract(client, "/tmp", null, { resolveContextLimit });
  await contract.prompt({ sessionId: "s1", system: "", model: GIANT, parts: [{ type: "text", text: "T".repeat(400000) }] });
  // 400k chars is ~100k tokens: over a 32k window, comfortably inside 1M.
  assert.equal(client.sent.body.parts[0].text.length, 400000, "a 1M-window model must not be trimmed for this payload");
});

test("an in-budget prompt is forwarded byte-identical", async () => {
  const client = fakeClient();
  const contract = new SessionContract(client, "/tmp", null, { resolveContextLimit });
  const parts = [{ type: "text", text: "a normal sized prompt" }];
  await contract.prompt({ sessionId: "s1", system: "sys", model: SMALL, parts });
  assert.deepEqual(client.sent.body.parts, parts);
  assert.equal(client.sent.body.system, "sys");
  assert.equal(client.sent.count, 1);
});

test("no guard runs when the model's window is unknown", async () => {
  const client = fakeClient();
  const contract = new SessionContract(client, "/tmp", null, { resolveContextLimit });
  const parts = [{ type: "text", text: "T".repeat(400000) }];
  await contract.prompt({ sessionId: "s1", system: "", model: { providerID: "unknown", modelID: "unknown" }, parts });
  assert.equal(client.sent.body.parts[0].text.length, 400000);
});

test("a contract built without a resolver behaves as it did before the guard", async () => {
  const client = fakeClient();
  const contract = new SessionContract(client, "/tmp");
  const parts = [{ type: "text", text: "T".repeat(400000) }];
  const result = await contract.prompt({ sessionId: "s1", system: "", model: SMALL, parts });
  assert.equal(result.ok, true);
  assert.equal(client.sent.body.parts[0].text.length, 400000);
});

test("a trim is reported rather than applied silently", async () => {
  const client = fakeClient();
  const contract = new SessionContract(client, "/tmp", null, { resolveContextLimit });
  const trims = [];
  contract.onPromptTrimmed = (chars, model) => trims.push({ chars, model: `${model.providerID}/${model.modelID}` });
  await contract.prompt({ sessionId: "s1", system: "", model: SMALL, parts: [{ type: "text", text: "T".repeat(400000) }] });
  assert.equal(trims.length, 1);
  assert.ok(trims[0].chars > 0);
  assert.equal(trims[0].model, "provider/small");
});

// -------------------------------------------------- provider input rejections

test("context overflow is classified, and is not a rate limit", () => {
  for (const message of [
    "This model's maximum context length is 8192 tokens",
    "context_length_exceeded",
    "prompt is too long: 300000 tokens > 100000 maximum",
    "input length and `max_tokens` exceed context limit",
    "reduce the length of the messages",
  ]) {
    const classification = classifyInputRejectionError({ status: 400, message });
    assert.equal(classification?.type, "context_overflow", `should classify as context_overflow: ${message}`);
    assert.equal(isRetryableError({ status: 400, message }), false, "a refused prompt must not be retried as-is");
    assert.equal(classifyRateLimitError({ status: 400, message }), null, "it is not a throttle, so it must not back off");
  }
});

test("provider token-budget exhaustion is classified and is not a rate limit", () => {
  for (const message of [
    "You exceeded your current quota, please check your plan and billing details",
    "insufficient credits to complete this request",
    "Your credit balance is too low to access the Anthropic API",
    "monthly token quota exhausted",
  ]) {
    const classification = classifyInputRejectionError({ status: 400, message });
    assert.equal(classification?.type, "token_budget_exhausted", `should classify as token_budget_exhausted: ${message}`);
    assert.equal(isRetryableError({ status: 400, message }), false);
    assert.equal(classifyRateLimitError({ status: 400, message }), null);
  }
});

test("token-budget exhaustion arriving on a 429 is not misread as a transient rate limit", () => {
  const err = { status: 429, message: "insufficient credits to complete this request" };
  assert.equal(classifyInputRejectionError(err)?.type, "token_budget_exhausted");
  // It is still hard-limited for retry purposes, so the meeting is not stalled
  // on a wait that will not help.
  assert.equal(isRetryableError(err), false);
});

test("throttling is still classified as throttling — the guard did not swallow rate limits", () => {
  const transient = { status: 429, message: "Too many requests" };
  assert.equal(classifyRateLimitError(transient)?.type, "transient_rate_limit");
  assert.equal(isInputRejectionError(transient), false, "a 429 throttle is not an input rejection");
  assert.equal(isRetryableError(transient), true, "throttling must still back off and retry");

  const freeTier = { status: 429, message: "limit", providerData: { responseBody: '{"type":"FreeUsageLimitError"}' } };
  assert.equal(classifyRateLimitError(freeTier)?.type, "free_tier_limit");
  assert.equal(isRetryableError(freeTier), false);
});

test("unrelated failures are not swept into the input-rejection bucket", () => {
  for (const err of [
    { status: 500, message: "Internal server error" },
    { status: 400, message: "invalid model" },
    { status: 0, code: "ECONNRESET" },
    { name: "TimeoutError" },
    null,
  ]) {
    assert.equal(isInputRejectionError(err), false, `${JSON.stringify(err)} should not be an input rejection`);
  }
});

test("a context overflow surfacing mid-generation is classified and reported", async () => {
  const client = fakeClient({
    data: {
      info: { error: { name: "ProviderAuthError", data: { message: "This model's maximum context length is 8192 tokens", statusCode: 400 } } },
      parts: [],
    },
  });
  const contract = new SessionContract(client, "/tmp", null, { resolveContextLimit });
  const seen = [];
  contract.onInputRejected = (classification, model) => seen.push({ type: classification.type, model: model.modelID });
  const result = await contract.prompt({ sessionId: "s1", system: "", model: SMALL, parts: [{ type: "text", text: "hi" }] });
  assert.equal(result.ok, false);
  assert.equal(result.error.inputRejectionClassification.type, "context_overflow");
  assert.deepEqual(seen, [{ type: "context_overflow", model: "small" }]);
});
