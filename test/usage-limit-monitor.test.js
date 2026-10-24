import test from "node:test";
import assert from "node:assert/strict";
import {
  reportFromSessionStatus,
  reportFromError,
  isBlocked,
  getState,
  getAbortReason,
  waitForHit,
  clear,
  onChange,
  _resetForTests,
  buildAbortError,
} from "../src/services/usage-limit-monitor.js";
import { isHardRateLimitError, isRetryableError } from "../src/utils/retry.js";

const FREE_STATUS = {
  type: "retry",
  attempt: 1,
  message: "FreeUsageLimitError: Free usage exceeded",
  next: Date.now() + 60_000,
  action: {
    reason: "free_tier_limit",
    provider: "opencode",
    title: "Free limit reached",
    message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
    label: "subscribe",
    link: "https://opencode.ai/go",
  },
};

test.beforeEach(() => _resetForTests());
test.afterEach(() => _resetForTests());

test("session.status free_tier_limit arms the monitor", () => {
  assert.equal(isBlocked(), false);
  const changed = reportFromSessionStatus("ses_abc", FREE_STATUS);
  assert.equal(changed, true);
  assert.equal(isBlocked(), true);
  const state = getState();
  assert.equal(state.type, "free_tier_limit");
  assert.equal(state.sourceSessionId, "ses_abc");
  assert.equal(state.detectedVia, "session.status");
  assert.ok(state.action?.link, "subscribe link preserved for the dashboard banner");
  // Daily free quota: estimated reset is next UTC midnight.
  assert.ok(state.retryAt != null);
  assert.ok(state.retryAt > Date.now());
  const tomorrow = new Date();
  const expected = Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate() + 1);
  assert.equal(state.retryAt, expected);
});

test("transient retry statuses without a hard action do not arm the monitor", () => {
  assert.equal(reportFromSessionStatus("ses_abc", { type: "retry", attempt: 1, message: "slow down", next: Date.now() + 1000 }), false);
  assert.equal(reportFromSessionStatus("ses_abc", { type: "busy" }), false);
  assert.equal(reportFromSessionStatus("ses_abc", { type: "idle" }), false);
  assert.equal(isBlocked(), false);
});

test("account_rate_limit uses the server retry timestamp when present", () => {
  const next = Date.now() + 300_000;
  reportFromSessionStatus("ses_go", {
    type: "retry",
    attempt: 2,
    message: "GoUsageLimitError",
    next,
    action: {
      reason: "account_rate_limit",
      provider: "opencode",
      title: "Go limit reached",
      message: "Usage limit reached.",
      label: "open settings",
      link: "https://opencode.ai/workspace/x/go",
    },
  });
  const state = getState();
  assert.equal(state.type, "account_rate_limit");
  assert.equal(state.retryAt, next);
  assert.ok(state.retryAfterMs > 0);
});

test("getAbortReason is a hard rate-limit error, not retryable", () => {
  reportFromSessionStatus("ses_abc", FREE_STATUS);
  const err = getAbortReason();
  assert.ok(err);
  assert.equal(err.name, "UsageLimitError");
  assert.ok(isHardRateLimitError(err));
  assert.equal(isRetryableError(err), false);
  assert.equal(err.rateLimitClassification.type, "free_tier_limit");
});

test("waitForHit rejects immediately when already blocked", async () => {
  reportFromSessionStatus("ses_abc", FREE_STATUS);
  const hit = waitForHit();
  await assert.rejects(hit.promise, (err) => err.name === "UsageLimitError");
  hit.dispose();
});

test("waitForHit rejects when a limit lands mid-wait", async () => {
  const hit = waitForHit();
  let settled = false;
  hit.promise.catch(() => { settled = true; });
  reportFromSessionStatus("ses_abc", FREE_STATUS);
  // allow microtask to run the rejection handlers
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, true);
  hit.dispose();
});

test("waitForHit dispose detaches so a later hit does not reject", async () => {
  const hit = waitForHit();
  hit.dispose();
  reportFromSessionStatus("ses_abc", FREE_STATUS);
  // The disposed waiter must not settle.
  const outcome = await Promise.race([
    hit.promise.then(() => "resolved", () => "rejected"),
    new Promise((r) => setTimeout(() => r("pending"), 50)),
  ]);
  assert.equal(outcome, "pending");
});

test("clear unblocks and fires change listeners", () => {
  reportFromSessionStatus("ses_abc", FREE_STATUS);
  const seen = [];
  const unsubFn = onChange((s) => seen.push(s?.type ?? null));
  assert.equal(clear("test"), true);
  assert.equal(isBlocked(), false);
  assert.ok(seen.includes(null), "clear notifies listeners with null state");
  unsubFn();
  assert.equal(clear("again"), false);
});

test("reportFromError arms the monitor from a classified prompt error", () => {
  const err = Object.assign(new Error("429 FreeUsageLimitError"), {
    status: 429,
    providerData: { responseBody: '{"type":"FreeUsageLimitError"}' },
  });
  err.rateLimitClassification = {
    type: "free_tier_limit",
    message: "Free usage exceeded, subscribe to Go",
    retryAfterMs: null,
    action: { reason: "free_tier_limit", label: "subscribe", link: "https://opencode.ai/go" },
  };
  assert.equal(reportFromError(err, "ses_xyz"), true);
  assert.equal(getState().type, "free_tier_limit");
  assert.equal(getState().sourceSessionId, "ses_xyz");
  assert.equal(getState().detectedVia, "prompt_error");
});

test("reportFromError ignores non-hard classifications", () => {
  const err = Object.assign(new Error("slow down"), {
    rateLimitClassification: { type: "transient_rate_limit", message: "slow down", retryAfterMs: 1000, action: null },
  });
  assert.equal(reportFromError(err), false);
  assert.equal(isBlocked(), false);
});

test("buildAbortError returns null when no state", () => {
  assert.equal(buildAbortError(), null);
});
