import test from "node:test";
import assert from "node:assert/strict";
import {
  reportFromSessionStatus,
  getState,
  getAbortReason,
  isBlocked,
  _resetForTests,
} from "../src/services/usage-limit-monitor.js";
import { isHardRateLimitError } from "../src/utils/retry.js";
import { createEventHandlers } from "../src/plugin/hooks.js";

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

function makeEngine() {
  return {
    calls: { haltForUsageLimit: 0, cancel: 0 },
    haltForUsageLimit(classification) {
      this.calls.haltForUsageLimit++;
      this.lastClassification = classification;
    },
    cancel() { this.calls.cancel++; },
  };
}

test("plugin event hook halts active meetings on free_tier_limit session.status", async () => {
  const engine = makeEngine();
  const activeLooms = new Map([["m1", engine]]);
  const handlers = createEventHandlers({ directory: "/tmp", activeLooms, resolveMeeting: null });

  await handlers.event({
    event: {
      type: "session.status",
      properties: {
        sessionID: "ses_child",
        status: FREE_STATUS,
      },
    },
  });

  assert.equal(isBlocked(), true);
  assert.equal(engine.calls.haltForUsageLimit, 1);
  assert.equal(engine.calls.cancel, 0);
  assert.equal(engine.lastClassification?.type, "free_tier_limit");
  assert.equal(engine.lastClassification?.retryAfterMs > 0, true, "daily reset hint passed through");
  assert.equal(engine.lastClassification?.action?.link, "https://opencode.ai/go");
});

test("plugin event hook ignores busy/idle/transient retry statuses", async () => {
  const engine = makeEngine();
  const activeLooms = new Map([["m1", engine]]);
  const handlers = createEventHandlers({ directory: "/tmp", activeLooms, resolveMeeting: null });

  for (const status of [
    { type: "busy" },
    { type: "idle" },
    { type: "retry", attempt: 1, message: "slow down", next: Date.now() + 1000 },
  ]) {
    await handlers.event({ event: { type: "session.status", properties: { sessionID: "ses", status } } });
  }

  assert.equal(isBlocked(), false);
  assert.equal(engine.calls.haltForUsageLimit, 0);
  assert.equal(engine.calls.cancel, 0);
});

test("plugin event hook falls back to cancel when engine lacks haltForUsageLimit", async () => {
  const engine = { calls: { cancel: 0 }, cancel() { this.calls.cancel++; } };
  const activeLooms = new Map([["m1", engine]]);
  const handlers = createEventHandlers({ directory: "/tmp", activeLooms, resolveMeeting: null });
  await handlers.event({
    event: { type: "session.status", properties: { sessionID: "ses", status: FREE_STATUS } },
  });
  assert.equal(engine.calls.cancel, 1);
});

test("haltForUsageLimit on a minimal orchestrator-shaped object sets sticky halt + rate_limited", async () => {
  // Exercise the real method without booting the full composition root.
  const { MeetingOrchestrator } = await import("../src/orchestrator.js");
  // Build a bare instance and overwrite heavy collaborators.
  const orch = Object.create(MeetingOrchestrator.prototype);
  orch._closed = false;
  orch._halted = false;
  orch._cancelled = false;
  orch._haltController = new AbortController();
  orch._rateLimitError = null;
  orch._rateLimitRetryAt = null;
  orch._logger = { warn() {}, info() {}, debug() {}, error() {} };
  orch._sessionManager = { postProgress: async () => {} };
  orch._stateManager = {
    _status: "weaving",
    getStatus() { return this._status; },
    transitionTo(s) { this._status = s; },
    getState() { return {}; },
  };
  orch._database = { setRateLimitState() {} };
  let abortedInflight = false;
  orch._roundExecutor = { _abortInflight() { abortedInflight = true; } };

  // Pull in the real methods via the prototype; patch persist to avoid DB.
  orch._persistRateLimitState = MeetingOrchestrator.prototype._persistRateLimitState.bind(orch);
  orch._setRateLimitError = MeetingOrchestrator.prototype._setRateLimitError.bind(orch);
  orch.haltForUsageLimit = MeetingOrchestrator.prototype.haltForUsageLimit.bind(orch);

  reportFromSessionStatus("ses_1", FREE_STATUS);
  const s = getState();
  orch.haltForUsageLimit({ type: s.type, message: s.message, retryAfterMs: s.retryAfterMs, action: s.action });

  assert.equal(orch._halted, true, "sticky halt");
  assert.equal(orch._cancelled, true, "weaving loop stops");
  assert.ok(abortedInflight, "in-flight prompts aborted");
  assert.ok(orch._rateLimitError, "rate limit recorded for the banner");
  assert.equal(orch._rateLimitError.rateLimitClassification.type, "free_tier_limit");
  assert.ok(isHardRateLimitError(orch._rateLimitError));
  assert.equal(orch._stateManager.getStatus(), "rate_limited");
});

test("resetHalt clears the usage-limit monitor so resume can retry immediately", async () => {
  const { MeetingOrchestrator } = await import("../src/orchestrator.js");
  const orch = Object.create(MeetingOrchestrator.prototype);
  orch._halted = true;
  orch._cancelled = true;
  orch._haltController = new AbortController();
  orch._haltController.abort();
  orch._roundExecutor = { setHaltSignal() {} };
  orch._synthesisCoordinator = { setHaltSignal() {} };
  orch.resetHalt = MeetingOrchestrator.prototype.resetHalt.bind(orch);

  reportFromSessionStatus("ses_1", FREE_STATUS);
  assert.equal(isBlocked(), true);
  orch.resetHalt();
  assert.equal(isBlocked(), false, "monitor cleared on resume/extend");
  assert.equal(orch._halted, false);
  assert.equal(orch._cancelled, false);
  assert.equal(orch._haltController.signal.aborted, false, "fresh halt controller");
});

test("hard rate-limit errors are not retried (ladder gate)", () => {
  reportFromSessionStatus("ses_1", FREE_STATUS);
  const err = getAbortReason();
  assert.ok(err);
  assert.equal(isHardRateLimitError(err), true);
  assert.equal(getState().type, "free_tier_limit");
});
