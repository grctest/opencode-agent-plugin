import { createQueryEvidenceTools } from "./tools/query-evidence.js";
import { createVoteSummonTools } from "./tools/vote-summon.js";
import { createForumTools } from "./tools/forum.js";
import { createPassTool } from "./tools/pass.js";
import { createStatePatchTool } from "./tools/state-patch.js";
import { createTurnOrderTool } from "./tools/turn-order.js";

export function createAgentTools({ config, resolveMeeting, activeLooms, directory }) {
  const queryEvidence = createQueryEvidenceTools({ config, resolveMeeting, activeLooms });
  const voteSummon = createVoteSummonTools({ config, resolveMeeting, activeLooms });
  const forum = createForumTools({ config, resolveMeeting, activeLooms });
  const passTool = createPassTool({ config, resolveMeeting, activeLooms });
  const statePatch = createStatePatchTool({ config, resolveMeeting, activeLooms });
  // Orchestrator-only: registered so the host resolves the name on the
  // summary call, but never merged into any agent-facing tool map.
  const turnOrder = createTurnOrderTool({ resolveMeeting, activeLooms });
  return {
    ...queryEvidence,
    ...voteSummon,
    ...forum,
    ...passTool,
    ...statePatch,
    ...turnOrder,
  };
}
