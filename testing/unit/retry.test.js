import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isRetryableError, CircuitBreaker, withRetry } from "../../src/utils/retry.js";

describe("isRetryableError (audit 09 R5)", () => {
  test("ECONNRESET is retryable", () => {
    const err = new Error("read error");
    err.code = "ECONNRESET";
    assert.equal(isRetryableError(err), true);
  });

  test("EPIPE is retryable", () => {
    const err = new Error("broken pipe");
    err.code = "EPIPE";
    assert.equal(isRetryableError(err), true);
  });

  test("HTTP 408 request timeout is retryable", () => {
    const err = new Error("request timeout");
    err.status = 408;
    assert.equal(isRetryableError(err), true);
  });

  test("existing classifications still hold", () => {
    const refused = new Error("refused");
    refused.code = "ECONNREFUSED";
    assert.equal(isRetryableError(refused), true);

    const slow = new Error("operation timed out");
    assert.equal(isRetryableError(slow), true);

    const server = new Error("boom");
    server.status = 503;
    assert.equal(isRetryableError(server), true);

    const rate = new Error("slow down");
    rate.status = 429;
    assert.equal(isRetryableError(rate), true);
  });

  test("permanent errors are not retryable", () => {
    const auth = new Error("unauthorized");
    auth.status = 401;
    assert.equal(isRetryableError(auth), false);
    assert.equal(isRetryableError(new Error("bad request")), false);
    assert.equal(isRetryableError(null), false);
  });
});

describe("CircuitBreaker", () => {
  function makeModel(id) {
    return { providerID: "p", modelID: id };
  }

  test("opens after threshold consecutive failures and resets on success", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 10 });
    const m = makeModel("x");
    assert.equal(cb.isHealthy(m), true);
    cb.recordFailure(m);
    cb.recordFailure(m);
    assert.equal(cb.isHealthy(m), false, "breaker should be open after 2 failures");
    // Half-open after resetTimeout
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(cb.isHealthy(m), true, "half-open allows attempt after reset timeout");
  });
});
