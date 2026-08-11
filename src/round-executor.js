import { buildAgentSystemPrompt, buildAgentUserPrompt, buildReflectionPrompt, buildInterjectionCheckPrompt, buildPushbackPrompt } from "./prompts.js";
import { parseAgentResponse } from "./validation.js";
import { withConcurrency } from "./concurrency.js";
import { CONFIG } from "./config.js";

export class RoundExecutor {
   /** @type {import("./client-types.js").AgentSessionClient} */
   #client;
   /** @type {string} */
   #directory;
   /** @type {import("./database.js").MeetingDatabase} */
   #db;
   /** @type {import("./types.js").LoomState} */
   #state;
   /** @type {OrchestratorOptions} */
   #options;
   /** @type {(system: string, model: { providerID: string; modelID: string }, message: string) => Promise<string>} */
   #promptParent;
   /** @type {(participant: import("./types.js").ParticipantState) => { providerID: string; modelID: string }} */
   #getParticipantModel;
   /** @type {() => { providerID: string; modelID: string }} */
   #getHighestTierModel;
   /** @type {(context: string, error: unknown) => void} */
   #logError;

   constructor({ client, directory, db, state, options, promptParent, getParticipantModel, getHighestTierModel, logError }) {
     this.#client = client;
     this.#directory = directory;
     this.#db = db;
     this.#state = state;
     this.#options = options;
     this.#promptParent = promptParent;
     this.#getParticipantModel = getParticipantModel;
     this.#getHighestTierModel = getHighestTierModel;
     this.#logError = logError;
   }

   async runPromptPhase(round, activeParticipants, parallel) {
     if (parallel) {
       await this.#runParallelPromptPhase(round, activeParticipants);
     } else {
       await this.#runSequentialPromptPhase(round, activeParticipants);
     }
   }

   async runReflectionPhase(round, activeParticipants) {
     const triggers = round.contributions.filter((c) => c.type === "challenge" || c.type === "dissent");
     if (triggers.length === 0) return;

     for (const trigger of triggers) {
       const triggerParticipant = activeParticipants.find((p) => p.config.id === trigger.participant_id);
       if (!triggerParticipant) continue;

       const listeners = activeParticipants.filter((p) => {
         if (p.config.id === trigger.participant_id) return false;
         if (p.status === "passed") return false;
         if (p.status === "failed") return false;
         if (p.reflection) return false;
         return p.config.tier === "principal" || p.config.tier === "senior";
       });

       for (const listener of listeners) {
         const model = this.#getParticipantModel(listener);
         const prompt = buildReflectionPrompt(listener, triggerParticipant.config.name, trigger.content);

         try {
           const reflection = await this.#promptParent(
             `You are ${listener.config.name} (${listener.config.tier}). Private reflection — only you will see this.`,
             model,
             prompt
           );

           if (reflection && reflection.trim().length > 10) {
             listener.reflection = reflection.trim();
             this.#db.setParticipantReflection(listener.config.id, listener.reflection);
           }
         } catch (err) {
           this.#logError(`reflection prompt for ${listener.config.name}`, err);
         }
       }
     }
   }

   async runInterjectionPhase(round, activeParticipants) {
     const pendingInterjections = round.interjections.filter((ij) => ij.resolved === "pending");

     if (round.contributions.length >= 2) {
       const coordinatorInterjections = await this.#detectInterjectionsCoordinator(round, activeParticipants);
        for (const ci of coordinatorInterjections) {
          const exists = pendingInterjections.some((pi) => pi.participant_id === ci.participant_id);
          if (!exists) {
            ci.round = this.#state.current_round;
            pendingInterjections.push(ci);
            round.interjections.push(ci);
            this.#db.addInterjection(this.#state.id, ci);
          }
        }
     }

     if (pendingInterjections.length === 0) return;

     for (const ij of pendingInterjections) {
       if (ij.resolved !== "pending") continue;

       if (ij.priority >= 9) {
         ij.granted = true;
         ij.resolved = "granted";
       } else if (ij.priority >= 7) {
         const target = activeParticipants.find((p) => p.config.id === ij.target_participant_id);
         if (target) {
           const pushback = await this.#checkPushback(target, ij, round);
           if (pushback === "yield") {
             ij.granted = true;
             ij.resolved = "granted";
           } else if (pushback === "contest_wins") {
             ij.resolved = "contested";
             ij.pushback = "Speaker contested and won";
           } else if (pushback === "tiebreaker") {
             const granted = await this.#moderateInterjection(ij);
             ij.granted = granted;
             ij.resolved = granted ? "granted" : "contested";
             if (!granted) ij.pushback = "Moderator ruled against interjection";
           } else {
             ij.granted = true;
             ij.resolved = "granted";
           }
         } else {
           ij.granted = true;
           ij.resolved = "granted";
         }
       } else {
         ij.resolved = "denied";
       }

       if (ij.granted) {
         const interjector = activeParticipants.find((p) => p.config.id === ij.participant_id);
         if (interjector) {
           await this.#promptInterjector(interjector, ij, round);
         }
       }
     }
   }

   async #runParallelPromptPhase(round, activeParticipants) {
     this.#options.onProgress?.(`${activeParticipants.length} participants thinking...`);
     for (const p of activeParticipants) {
       this.#db.setParticipantStatus(p.config.id, "speaking");
     }

     const tasks = activeParticipants.map((p) => async () => {
       const result = await this.#promptChildSession(p);
       return { participant: p, result };
     });

     const results = await withConcurrency(tasks, activeParticipants.length);

     for (const { participant: p, result } of results) {
       if (!result) {
         p.status = "failed";
         this.#db.setParticipantStatus(p.config.id, "failed");
         this.#db.recordAgentError(
           this.#state.id, p.config.id, this.#state.current_round,
           "no_response", "Failed to get response after retries", 2,
         );
         round.token_path.push(p.config.id);
         this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — failed to respond, skipping`);
         this.#options.onContribution?.(p.config.name, this.#state.current_round, "failed_no_response");
         continue;
       }

       if (result.content === "[PASS]") {
         p.status = "passed";
         this.#db.setParticipantStatus(p.config.id, "passed");
         round.token_path.push(p.config.id);
         this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — chose to pass`);
         this.#options.onContribution?.(p.config.name, this.#state.current_round, "pass");
         continue;
       }

       this.#storeContribution(p, result, round);
       p.reflection = "";
       this.#db.setParticipantReflection(p.config.id, "");

       const truncated = this.#truncate(result.content, 120);
       this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — ${result.type}: "${truncated}"`);
     }
   }

   async #runSequentialPromptPhase(round, activeParticipants) {
     for (const p of activeParticipants) {
       this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) is thinking...`);
       this.#db.setParticipantStatus(p.config.id, "speaking");

       let result = await this.#promptChildSession(p);

       if (!result) {
         result = await this.#promptChildSession(p);
       }

       if (!result) {
         this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — failed to respond, skipping`);
         const participant = this.#state.participants.find((pp) => pp.config.id === p.config.id);
         if (participant) participant.status = "failed";
         this.#db.setParticipantStatus(p.config.id, "failed");
         this.#db.recordAgentError(
           this.#state.id, p.config.id, this.#state.current_round,
           "no_response", "Failed to get response after retries", 2,
         );
         round.token_path.push(p.config.id);
         this.#options.onContribution?.(p.config.name, this.#state.current_round, "failed_no_response");
         continue;
       }

       const participant = this.#state.participants.find((pp) => pp.config.id === result.participant_id);
       if (!participant) continue;

       if (result.content === "[PASS]") {
         participant.status = "passed";
         this.#db.setParticipantStatus(participant.config.id, "passed");
         round.token_path.push(participant.config.id);
         this.#options.onProgress?.(`${participant.config.name} (${participant.config.tier}) — chose to pass`);
         this.#options.onContribution?.(participant.config.name, this.#state.current_round, "pass");
         continue;
       }

       this.#storeContribution(participant, result, round);
       participant.reflection = "";
       this.#db.setParticipantReflection(participant.config.id, "");

       const truncated = this.#truncate(result.content, 120);
       this.#options.onProgress?.(`${participant.config.name} (${participant.config.tier}) — ${result.type}: "${truncated}"`);
     }
   }

   #storeContribution(participant, result, round) {
     const contribution = {
       participant_id: result.participant_id,
       content: result.content,
       type: result.type,
       targets_which: null,
       timestamp: Date.now(),
     };

     this.#state.weft.push(contribution);
     round.contributions.push(contribution);
     round.token_path.push(participant.config.id);
     participant.contributions_count++;
     participant.status = "listening";
     this.#db.setParticipantStatus(participant.config.id, "listening");

     this.#db.addContribution(this.#state.id, {
       ...contribution,
       round: this.#state.current_round,
     });

     if (result.interjection) {
       const interjection = {
         participant_id: result.participant_id,
         target_participant_id: result.participant_id,
         round: this.#state.current_round,
         priority: result.interjection.priority,
         reason: result.interjection.reason,
         granted: false,
         pushback: null,
         resolved: "pending",
       };
       round.interjections.push(interjection);
       this.#db.addInterjection(this.#state.id, interjection);
     }

     this.#options.onAgentComplete?.(result.participant_id, result.content);
     this.#options.onContribution?.(participant.config.name, this.#state.current_round, result.type);
   }

   async #promptChildSession(participant) {
     participant.status = "speaking";

     if (!participant.session_id) {
       return null;
     }

     const maxRetries = CONFIG.maxRetryAttempts;
     const timeoutMs = CONFIG.agentTimeoutMs;

     for (let attempt = 0; attempt <= maxRetries; attempt++) {
       try {
         const result = await this.#withTimeout(
           this.#client.session.prompt({
             path: { id: participant.session_id },
             body: {
               system: buildAgentSystemPrompt(participant),
               model: this.#getParticipantModel(participant),
               parts: [{ type: "text", text: buildAgentUserPrompt(
                 participant,
                 this.#state.warp,
                 this.#state.weft,
                 this.#state.question,
                 this.#state.current_round,
               ) }],
             },
             query: { directory: this.#directory },
           }),
           timeoutMs,
         );

         if (result.error) {
           throw new Error(result.error.message || JSON.stringify(result.error));
         }

         const content = this.#extractText(result.data);
         if (!content) return null;

         const response = parseAgentResponse(participant.config.id, content);
         if (!response) return null;

         this.#options.onAgentComplete?.(participant.config.id, response.content);
         return response;
       } catch (err) {
         if (attempt === maxRetries) {
           this.#state.objections.push({
             participant_id: participant.config.id,
             content: `Failed after ${maxRetries + 1} attempts: ${err instanceof Error ? err.message : "unknown"}`,
             unresolved: false,
           });
           return null;
         }
         const delay = Math.min(
           CONFIG.retryBaseDelayMs * Math.pow(2, attempt) + Math.random() * 500,
           CONFIG.retryMaxDelayMs,
         );
         await new Promise((resolve) => setTimeout(resolve, delay));
       }
     }

     return null;
   }

   async #detectInterjectionsCoordinator(round, activeParticipants) {
     const lastContribution = round.contributions[round.contributions.length - 1];
     if (!lastContribution) return [];

     const listeners = activeParticipants.filter((p) => {
       if (p.config.id === lastContribution.participant_id) return false;
       if (p.status === "passed") return false;
       if (p.status === "failed") return false;
       return true;
     });

     if (listeners.length === 0) return [];

     const participantLookup = listeners.map((p) => ({
       config: p.config,
       status: p.status,
       canInterject: true,
     }));

     const prompt = buildInterjectionCheckPrompt(lastContribution.participant_id, lastContribution.content, participantLookup);
     const model = this.#getHighestTierModel();

     let result;
     try {
       result = await this.#promptParent(
         "You are a neutral process coordinator evaluating interjection requests.",
         model,
         prompt
       );
     } catch (err) {
       this.#logError("interjection coordinator detection", err);
       return [];
     }

     const interjections = [];
     for (const line of result.split("\n")) {
       const match = line.match(/\[INTERJECT:\s*(.+?),\s*Priority:\s*(\d+),\s*Reason:\s*"(.+?)"\]/i);
       if (!match) continue;

       const name = match[1].trim();
       const priority = parseInt(match[2]);
       const reason = match[3].trim();

       const participant = activeParticipants.find(
         (p) => p.config.name.toLowerCase() === name.toLowerCase() || p.config.id.toLowerCase() === name.toLowerCase()
       );

       if (participant) {
         interjections.push({
           participant_id: participant.config.id,
           priority: Math.min(10, Math.max(1, priority)),
           reason,
           target_participant_id: lastContribution.participant_id,
           granted: false,
           pushback: null,
           resolved: "pending",
         });
       }
     }

     return interjections;
   }

   async #checkPushback(speaker, ij, round) {
     const model = this.#getParticipantModel(speaker);
     const speakerContribution = round.contributions.filter((c) => c.participant_id === ij.target_participant_id).pop();
     const interjector = this.#state.participants.find((p) => p.config.id === ij.participant_id);
     const interjectorName = interjector ? interjector.config.name : ij.participant_id;
     const prompt = buildPushbackPrompt(speaker, interjectorName, ij.priority, speakerContribution?.content ?? "");

     try {
       const result = await this.#promptParent(
         `You are ${speaker.config.name} (${speaker.config.tier}). Someone wants to interrupt your turn.`,
         model,
         prompt
       );
       const text = result.trim();

       if (text.startsWith("[CONTEST")) {
         const priorityMatch = text.match(/Priority:\s*(\d+)/);
         const contestPriority = priorityMatch ? parseInt(priorityMatch[1]) : ij.priority;

         if (contestPriority > ij.priority) return "contest_wins";
         if (contestPriority === ij.priority) return "tiebreaker";
         return "contest_loses";
       }

       return "yield";
     } catch (err) {
       this.#logError("pushback check", err);
       return "yield";
     }
   }

   async #moderateInterjection(ij) {
     const situation = `Two participants claim equal priority (${ij.priority}) for interjection:
- ${ij.participant_id}: "${ij.reason}"
Who should be granted the floor?`;

     try {
       const model = this.#getHighestTierModel();
       const prompt = `${situation}

Respond with: "grant" or "deny". One word only.`;
       const result = await this.#promptParent(
         "You are the deliberation moderator. Rule on interjection priority disputes.",
         model,
         prompt,
       );
       return result.toLowerCase().includes("grant");
     } catch (err) {
       this.#logError("moderator tiebreaker", err);
       return false;
     }
   }

   async #promptInterjector(interjector, ij, round) {
     interjector.status = "speaking";
     this.#db.setParticipantStatus(interjector.config.id, "speaking");
     this.#options.onProgress?.(`${interjector.config.name} (${interjector.config.tier}) — interjecting...`);

     const model = this.#getParticipantModel(interjector);
     const systemPrompt = buildAgentSystemPrompt(interjector);
     const userPrompt = `## You Interjected

You requested to interrupt with priority ${ij.priority}:
"${ij.reason}"

State your interjection now. Be direct and under 200 words.`;

     try {
       const result = await this.#withTimeout(
         this.#client.session.prompt({
           path: { id: interjector.session_id },
           body: { system: systemPrompt, model, parts: [{ type: "text", text: userPrompt }] },
           query: { directory: this.#directory },
         }),
         120000,
       );

       if (result.error) {
         throw new Error(result.error.message || JSON.stringify(result.error));
       }

       const content = this.#extractText(result.data);
       if (!content) throw new Error("Empty interjection response");

       const contribution = {
         participant_id: interjector.config.id,
         content: content.replace(/^\[(\w+)\]\s*/, ""),
         type: "interjection",
         targets_which: ij.target_participant_id,
         timestamp: Date.now(),
       };

       this.#state.weft.push(contribution);
       round.contributions.push(contribution);
       round.token_path.push(interjector.config.id);
       interjector.contributions_count++;
       interjector.reflection = "";
       this.#db.setParticipantReflection(interjector.config.id, "");

       this.#db.addContribution(this.#state.id, {
         ...contribution,
         round: this.#state.current_round,
       });

       const truncated = this.#truncate(contribution.content, 120);
       this.#options.onProgress?.(`${interjector.config.name} (${interjector.config.tier}) — interjection: "${truncated}"`);
       this.#options.onContribution?.(interjector.config.name, this.#state.current_round, "interjection");
     } catch (err) {
       this.#logError(`interjection prompt for ${interjector.config.name}`, err);
       this.#options.onProgress?.(`${interjector.config.name} (${interjector.config.tier}) — interjection failed`);
     } finally {
       interjector.status = "listening";
       this.#db.setParticipantStatus(interjector.config.id, "listening");
     }
   }

   #withTimeout(promise, ms) {
     return new Promise((resolve, reject) => {
       const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
       promise.then(resolve, reject).finally(() => clearTimeout(timer));
     });
   }

   #extractText(data) {
     if (!data?.parts) return null;
     const parts = data.parts;
     const textParts = parts.filter((p) => p.type === "text");
     const content = textParts.map((p) => p.text).join("\n").trim();
     return content.length > 0 ? content : null;
   }

   #truncate(text, max) {
     const cleaned = text.replace(/\n/g, " ").trim();
     if (cleaned.length <= max) return cleaned;
     return cleaned.slice(0, max - 3) + "...";
   }
}
