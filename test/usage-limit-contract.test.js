import test from "node:test";
import assert from "node:assert/strict";
import { SessionContract } from "../src/session-contract.js";
import {
  reportFromSessionStatus,
  clear as clearUsageLimit,
  _resetForTests,
} from "../src/services/usage-limit-monitor.js";
import { isHardRateLimitError, isRetryableError } from "../src/utils/retry.js";

function makeClient({ hangMs = 5000 } = {}) {
  return {
    session: {
      create: async () => ({ data: { id: "ses_1" }, error: null }),
      prompt: async () => {
        // Simulate opencode holding the prompt open past any sane client budget.
        await new Promise((r) => setTimeout(r, hangMs));
        return { data: { info: { role: "assistant", text: "too late" }, parts: [] }, error: null };
      },
      abort: async () => ({ data: true, error: null }),
      delete: async () => ({ data: true, error: null }),
      messages: async () => ({ data: [], error: null }),
    },
  };
}

const FREE_STATUS = {
  type: "retry",
  attempt: 1,
  message: "FreeUsageLimitError",
  next: Date.now() + 60_000,
  action: {
    reason: "free_tier_limit",
    provider: "opencode",
    title: "Free limit reached",
    message: "Free usage exceeded, subscribe to Go",
    label: "subscribe",
    link: "https://opencode.ai/go",
  },
};

test.beforeEach(() => _resetForTests());
test.afterEach(() => _resetForTests());

test("prompt fails fast when a hard usage limit is already in effect", async () => {
  reportFromSessionStatus("ses_other", FREE_STATUS);
  const client = makeClient({ hangMs: 30_000 });
  const contract = new SessionContract(client, "/tmp", null, {});
  const started = Date.now();
  const result = await contract.prompt({
    sessionId: "ses_1",
    system: "sys",
    model: { providerID: "opencode", modelID: "glm-5.3-flash-free" },
    parts: [{ type: "text", text: "hello" }],
    timeoutMs: 120_000,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 2000, `expected fail-fast, took ${elapsed}ms`);
  assert.ok(isHardRateLimitError(result.error), "error classified as hard rate limit");
  assert.equal(isRetryableError(result.error), false, "must not enter the retry ladder");
  assert.equal(result.error.rateLimitClassification.type, "free_tier_limit");
  assert.equal(result.error.rateLimitClassification.action?.link, "https://opencode.ai/go");
});

test("an in-flight prompt is aborted when a hard usage limit lands mid-call", async () => {
  const client = makeClient({ hangMs: 10_000 });
  const contract = new SessionContract(client, "/tmp", null, {});
  const started = Date.now();
  const promptPromise = contract.prompt({
    sessionId: "ses_1",
    system: "sys",
    model: { providerID: "opencode", modelID: "glm-5.3-flash-free" },
    parts: [{ type: "text", text: "hello" }],
    timeoutMs: 60_000,
  });
  // Let the HTTP call start, then simulate the web-UI signal.
  await new Promise((r) => setTimeout(r, 50));
  reportFromSessionStatus("ses_1", FREE_STATUS);
  const result = await promptPromise;
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 3000, `expected mid-flight abort, took ${elapsed}ms`);
  assert.ok(isHardRateLimitError(result.error));
  assert.equal(result.error.name, "UsageLimitError");
});

test("clear allows a later prompt through the monitor gate", async () => {
  reportFromSessionStatus("ses_other", FREE_STATUS);
  clearUsageLimit("test-resume");
  const client = makeClient({ hangMs: 10 });
  const contract = new SessionContract(client, "/tmp", null, {});
  const result = await contract.prompt({
    sessionId: "ses_1",
    system: "sys",
    model: { providerID: "opencode", modelID: "glm-5.3-flash-free" },
    parts: [{ type: "text", text: "hello" }],
    timeoutMs: 5_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "");
});
