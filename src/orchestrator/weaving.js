
export async function runMeeting() {
    await this.initialize();

    const participantItems = this._stateManager.getParticipants()
      .map((p) => `  - ${p.config.name} (${p.config.tier}${p.config.tags?.length ? ", " + p.config.tags.join(", ") : ""})`)
      .join("\n");
    await this._sessionManager.postProgress(
      `🎬 Loom started — ${this._stateManager.getParticipants().length} participants:\n${participantItems}`
    );

    this._stallWatchdog.start(
      () => this._stateManager.getStatus(),
      () => this._cancelled,
    );
    try {
      await this._runWeavingLoop();
    } finally {
      this._stallWatchdog.stop();
    }

    const output = await this._synthesize();
    return output;
  }

 export async function extendMeeting(newPrompt) {
    this._startTime = Date.now();
    if (this._timeBudget) this._timeBudget.reset(this._startTime, this._meetingTimeoutMs);
    this._cancelled = false;
    this._stallWatchdog.reset();

    await this._meetingExtender.extend({
      database: this._database,
      stateManager: this._stateManager,
      sessionManager: this._sessionManager,
      newPrompt,
    });

    this._stallWatchdog.start(
      () => this._stateManager.getStatus(),
      () => this._cancelled,
    );
    try {
      await this._runWeavingLoop();
    } finally {
      this._stallWatchdog.stop();
    }
    const output = await this._synthesize();
    return output;
  }

export async function _runWeavingLoop() {
    let continueWeaving = true;
    while (continueWeaving) {
      if (this._cancelled) {
        const terminal = this._stallWatchdog.stallCancelled ? "timeout" : "cancelled";
        this._stateManager.transitionTo(terminal);
        await this._sessionManager.postProgress(
          this._stallWatchdog.stallCancelled
            ? "⏱️ Loom stopped due to no activity — generating output from collected contributions."
            : "🛑 Loom cancelled by user."
        );
        this._logger.info(this._stallWatchdog.stallCancelled ? "stall_timeout" : "cancelled", "Meeting stopped before weaving loop completed");
        break;
      }

      if (this._remainingMs() <= 0) {
        this._stateManager.transitionTo("timeout");
        await this._sessionManager.postProgress("⏱️ Loom timed out — generating output from collected contributions.", "warn");
        this._logger.warn("timeout", "Meeting timed out", { elapsed: Date.now() - this._startTime, limit: this._meetingTimeoutMs });
        break;
      }

      continueWeaving = await this.runRound();
      this._notifyUpdate();
      if (continueWeaving && this._tokenBudgetExceeded()) {
        this._stateManager.transitionTo("timeout");
        const spent = (this._callStats.input_tokens ?? 0) + (this._callStats.output_tokens ?? 0);
        await this._sessionManager.postProgress(`💰 Token budget reached (${spent} ≥ ${this._maxTotalTokens}) — ending deliberation and generating output.`, "warn");
        break;
      }
    }
  }

  export function _tokenBudgetExceeded() {
    if (!this._maxTotalTokens || this._maxTotalTokens <= 0) return false;
    const spent = (this._callStats.input_tokens ?? 0) + (this._callStats.output_tokens ?? 0);
    return spent >= this._maxTotalTokens;
  }

  export function _remainingMs() {
    if (this._timeBudget) {
      this._timeBudget.syncFrom(this);
      return this._timeBudget.remainingMs();
    }
    if (!this._meetingTimeoutMs || this._meetingTimeoutMs <= 0) return Infinity;
    return this._startTime + this._meetingTimeoutMs - Date.now();
  }

export function _raceWithGuardTimer(promise, timeoutMs, label) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      if (timer.unref) timer.unref();
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
  }

export function _checkTimeout() {
    if (this._timeBudget) {
      this._timeBudget.syncFrom(this);
      if (this._timeBudget.checkTimeout()) {
        this._stateManager.transitionTo("timeout");
        this._logger.warn("timeout", "Meeting timed out", { elapsed: Date.now() - this._startTime, limit: this._meetingTimeoutMs });
        return true;
      }
      return false;
    }
    if (this._remainingMs() <= 0) {
      this._stateManager.transitionTo("timeout");
      this._logger.warn("timeout", "Meeting timed out", { elapsed: Date.now() - this._startTime, limit: this._meetingTimeoutMs });
      return true;
    }
    return false;
  }

