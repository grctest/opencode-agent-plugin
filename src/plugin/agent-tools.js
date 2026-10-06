import { createQueryEvidenceTools } from "./tools/query-evidence.js";
import { createVoteSummonTools } from "./tools/vote-summon.js";
import { createForumTools } from "./tools/forum.js";
import { createPassTool } from "./tools/pass.js";
import { createStatePatchTool } from "./tools/state-patch.js";

export function createAgentTools({ config, resolveMeeting, activeLooms, directory }) {
  const queryEvidence = createQueryEvidenceTools({ config, resolveMeeting, activeLooms });
  const voteSummon = createVoteSummonTools({ config, resolveMeeting, activeLooms });
  const forum = createForumTools({ config, resolveMeeting, activeLooms });
  const passTool = createPassTool({ config, resolveMeeting, activeLooms });
  const statePatch = createStatePatchTool({ config, resolveMeeting, activeLooms });
  return {
    ...queryEvidence,
    ...voteSummon,
    ...forum,
    ...passTool,
    ...statePatch,
  };
}
