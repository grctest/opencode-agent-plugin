import { createQueryEvidenceTools } from "./tools/query-evidence.js";
import { createVoteSummonTools } from "./tools/vote-summon.js";
import { createForumTools } from "./tools/forum.js";
import { createMetaTools } from "./tools/meta.js";
import { createPassTool } from "./tools/pass.js";

export function createAgentTools({ config, resolveMeeting, activeLooms, directory }) {
  const queryEvidence = createQueryEvidenceTools({ config, resolveMeeting, activeLooms });
  const voteSummon = createVoteSummonTools({ config, resolveMeeting, activeLooms });
  const forum = createForumTools({ config, resolveMeeting, activeLooms });
  const meta = createMetaTools({ config });
  const passTool = createPassTool({ config });
  return {
    ...queryEvidence,
    ...voteSummon,
    ...forum,
    ...meta,
    ...passTool,
  };
}
