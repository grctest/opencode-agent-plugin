import { createVectorSearchTool } from "./tools/vector-search.js";
import { createQueryEvidenceTools } from "./tools/query-evidence.js";
import { createVoteSummonTools } from "./tools/vote-summon.js";
import { createMetaTools } from "./tools/meta.js";

export function createAgentTools({ config, resolveMeeting, activeLooms, directory }) {
  const vectorSearch = { loom_vector_search: createVectorSearchTool({ config, resolveMeeting }) };
  const queryEvidence = createQueryEvidenceTools({ config, resolveMeeting, activeLooms });
  const voteSummon = createVoteSummonTools({ config, resolveMeeting, activeLooms });
  const meta = createMetaTools({ config });
  return {
    ...vectorSearch,
    ...queryEvidence,
    ...voteSummon,
    ...meta,
  };
}
