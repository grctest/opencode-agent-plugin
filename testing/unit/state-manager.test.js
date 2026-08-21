import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StateManager } from "../../src/services/state-manager.js";

function makeStateManager(initialStatus = "initializing") {
  return new StateManager({
    id: "test-meeting",
    question: "q",
    context: "",
    participants: [],
    fabric: "",
    weave: [],
    rounds: [],
    current_round: 0,
    max_rounds: 3,
    current_speaker_idx: 0,
    status: initialStatus,
    artifact: null,
    objections: [],
    tags: ["t1"],
    next_contribution_id: 0,
  });
}

describe("state-manager transition table (audit 05 LS3)", () => {
  test("initializing → weaving is legal", () => {
    const sm = makeStateManager();
    sm.transitionTo("weaving");
    assert.equal(sm.getStatus(), "weaving");
  });

  test("timeout IS reachable from initializing (stall before round 1)", () => {
    const sm = makeStateManager();
    sm.transitionTo("timeout");
    assert.equal(sm.getStatus(), "timeout");
  });

  test("weaving → weaving self-transition (extension) is a no-op, not an error", () => {
    const sm = makeStateManager();
    sm.transitionTo("weaving");
    assert.doesNotThrow(() => sm.transitionTo("weaving"));
    assert.equal(sm.getStatus(), "weaving");
  });

  test("terminal states reject all transitions", () => {
    for (const terminal of ["converged", "cancelled", "timeout", "max_rounds_reached", "aborted"]) {
      const sm = makeStateManager();
      sm.transitionTo("weaving"); // active state first — initializing can't jump to most terminals
      sm.transitionTo(terminal);
      assert.equal(sm.getStatus(), terminal);
      assert.throws(() => sm.transitionTo("weaving"), /Invalid status transition/);
    }
  });

  test("invalid transition throws", () => {
    const sm = makeStateManager();
    assert.throws(() => sm.transitionTo("converged"), /Invalid status transition: initializing -> converged/);
  });

  test("forceTransitionTo exists for the extension entry point only", () => {
    const sm = makeStateManager("converged");
    sm.forceTransitionTo("weaving");
    assert.equal(sm.getStatus(), "weaving");
  });
});

describe("state-manager getState deep-freeze (audit 05 LS4)", () => {
  test("returned projections resist mutation of nested objects", () => {
    const sm = makeStateManager();
    sm.setObjections([{ content: "objection-1", unresolved: true }]);
    sm.setArtifact({ content: "artifact text" });
    const snapshot = sm.getState();

    assert.throws(() => { snapshot.tags.push("mutated"); });
    assert.throws(() => { snapshot.objections[0].content = "hacked"; }, TypeError);
    assert.throws(() => { snapshot.artifact.content = "hacked"; }, TypeError);
    // Live state untouched
    assert.equal(sm.getState().objections[0].content, "objection-1");
    assert.equal(sm.getState().artifact.content, "artifact text");
  });
});
