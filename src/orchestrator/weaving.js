
import { TUNING } from "../config/defaults.js";
import { getConfig } from "../config.js";

export async function runMeeting() {
    await this.initialize();

    const participantItems = this._stateManager.getParticipants()
      .map((p) => `  - ${p.config.name} (${p.config.tier}${p.config.tags?.length ? ", " + p.config.tags.join(", ") : ""})`)
      .join("\n");
    await this._sessionManager.postProgress(
      `🎬 Loom started — ${this._stateManager.getParticipants().length} participants:\n${participantItems}`
    );

     this._stallWatchdog.start(
       () => {
         const status = this._stateManager.getStatus();
         return status === "initializing" || status === "weaving" ? status : "weaving";
       },
       () => this._cancelled,
     );
     try {
       await this._runWeavingLoop();
       return await this._synthesize();
     } finally {
       this._stallWatchdog.stop();
     }
  }

  export async function extendMeeting(newPrompt, additionalRounds) {
    this._startTime = Date.now();
    this._cancelled = false;
    this._stallWatchdog.reset();
    try { this._sessionManager?.clearOrchestratorSession?.(); } catch {}
    // Start watchdog BEFORE extend so stall is detected even if extend hangs; extend itself is short DB work
    this._stallWatchdog.start(
      () => this._stateManager.getStatus(),
      () => this._cancelled,
    );
    try {
      await this._meetingExtender.extend({
        database: this._database,
        stateManager: this._stateManager,
        sessionManager: this._sessionManager,
        newPrompt,
        ...(additionalRounds !== undefined && additionalRounds !== null
          ? { extraRounds: additionalRounds }
          : {}),
      });
      // Clear breaker history so previously failed models can be retried in new rounds.
      // Keep current model selection — do not reassign provider_id/model_id.
      try { this._roundExecutor?.clearBreakerHistory?.(); } catch {}
      // Note: fabric RAG removed — extension prompt is already in weave / State of Play
    } catch (e) {
      // Extend failed — keep watchdog running for loop, but surface error
      throw e;
    }
    let output;
    try {
      await this._runWeavingLoop();
      output = await this._synthesize();
    } finally {
      this._stallWatchdog.stop();
    }
    return output;
  }

  /**
   * Resume a meeting interrupted by a sudden server kill. Caller must have
   * run initialize() first (restores DB state into memory).
   *
   * Unlike runMeeting() (fresh start) this first continues the interrupted
   * round in place — re-driving only its missing speakers and finalizing it —
   * so a partial round is completed rather than abandoned. Returns the final
   * synthesized output like runMeeting().
   */
  export async function resumeMeeting() {
    try { await this._sessionManager.postProgress(`🧵 Resuming interrupted deliberation — continuing from round ${this._stateManager.getCurrentRound()}.`); } catch {}
    this._stallWatchdog.start(
      () => {
        const status = this._stateManager.getStatus();
        return status === "initializing" || status === "weaving" ? status : "weaving";
      },
      () => this._cancelled,
    );
    try {
      const continued = await this._continueInterruptedRound();
      if (continued === false) return await this._synthesize();
      await this._runWeavingLoop();
      return await this._synthesize();
    } finally {
      this._stallWatchdog.stop();
    }
  }

export async function _runWeavingLoop() {
    let continueWeaving = true;
    let iterations = 0;
    const maxRounds = this._stateManager?.getMaxRounds?.() ?? 10;
    const tuningMax = getConfig()?.tuning?.MAX_ITERATIONS ?? TUNING.MAX_ITERATIONS;
    const MAX_ITERATIONS = Math.max(tuningMax, maxRounds + 5);
    while (continueWeaving) {
      if (++iterations > MAX_ITERATIONS) {
        this._logger.error("weaving_loop_guard", `Weaving loop exceeded ${MAX_ITERATIONS} iterations — forcing timeout (possible max_rounds corruption)`);
        this._stateManager.transitionTo("timeout");
        break;
      }
      if (this._cancelled) {
        const terminal = this._stallWatchdog.stallCancelled ? "timeout" : "cancelled";
        this._stateManager.transitionTo(terminal);
        try { await this._sessionManager.postProgress(
          this._stallWatchdog.stallCancelled
            ? "⏱️ Loom stopped due to no activity — generating output from collected contributions."
            : "🛑 Loom cancelled by user."
        ); } catch {}
        this._logger.info(this._stallWatchdog.stallCancelled ? "stall_timeout" : "cancelled", "Meeting stopped before weaving loop completed");
        break;
      }

        if (this._tokenBudgetExceeded()) {
          this._stateManager.transitionTo("timeout");
          const spentBefore = (this._callStats.input_tokens ?? 0) + (this._callStats.output_tokens ?? 0);
          try { await this._sessionManager.postProgress(`💰 Token budget reached (${spentBefore} ≥ ${this._maxTotalTokens}) — ending deliberation and generating output.`, "warn"); } catch {}
          break;
        }

       continueWeaving = await this.runRound();
      this._notifyUpdate();
      if (continueWeaving && this._tokenBudgetExceeded()) {
        this._stateManager.transitionTo("timeout");
        const spent = (this._callStats.input_tokens ?? 0) + (this._callStats.output_tokens ?? 0);
        try { await this._sessionManager.postProgress(`💰 Token budget reached (${spent} ≥ ${this._maxTotalTokens}) — ending deliberation and generating output.`, "warn"); } catch {}
        break;
      }
      if (continueWeaving) await new Promise((r) => setImmediate(r));
    }
  }

  export function _tokenBudgetExceeded() {
    if (!this._maxTotalTokens || this._maxTotalTokens <= 0) return false;
    // Merge agent round stats (RoundExecutor tracks agent tokens separately)
    let agentTokens = 0;
    try {
      const rs = this._roundExecutor?.getCallStats?.();
      agentTokens = (rs?.input_tokens ?? 0) + (rs?.output_tokens ?? 0);
    } catch {}
    const spent = (this._callStats.input_tokens ?? 0) + (this._callStats.output_tokens ?? 0) + agentTokens;
    return spent >= this._maxTotalTokens;
  }

export function _raceWithGuardTimer(promise, timeoutMs, label) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`${label}: invalid timeout ${timeoutMs}`);
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      if (timer.unref) timer.unref();
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
  }



