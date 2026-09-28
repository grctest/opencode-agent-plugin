import { getConfig, resolveBuiltInTools, resolveLoomTools } from "../config.js";

export function buildToolsMap(config, { activeCount, omitStatePatch = false } = {}) {
  const agentToolsConfig = config.agentTools;
  const toolsMap = {};
  if (agentToolsConfig?.enabled) {
    const t = resolveBuiltInTools(agentToolsConfig);
    if (t.webfetch) toolsMap.webfetch = true;
    if (t.websearch) toolsMap.websearch = true;
    if (t.read) toolsMap.read = true;
    if (t.bash) toolsMap.bash = true;
    if (t.glob) toolsMap.glob = true;
    if (t.grep) toolsMap.grep = true;
    if (t.lsp) toolsMap.lsp = true;
    const loom = resolveLoomTools(agentToolsConfig);
    const isSolo = Number.isFinite(activeCount) && activeCount <= 1;
    if (loom.loom_query && !isSolo) toolsMap.loom_query = true;
    if (loom.loom_vote && !isSolo) toolsMap.loom_vote = true;
    if (loom.loom_summon) toolsMap.loom_summon = true;
    if (loom.loom_request_next && !isSolo) toolsMap.loom_request_next = true;
    if (loom.loom_pass) toolsMap.loom_pass = true;
    // State patch is offered inline (omitStatePatch stays for callers that
    // must not offer it, e.g. synthesis/recovery passes). The agent's
    // absolutely-last tool use must be the patch; a miss falls into the
    // conditional mandatory retry, exactly like any other mandatory tool.
    if (loom.loom_state_patch && !omitStatePatch) toolsMap.loom_state_patch = true;
    if (loom.loom_forum) {
      toolsMap.loom_forum_create_topic = true;
      toolsMap.loom_forum_list_topics = true;
      toolsMap.loom_forum_read_topic = true;
      toolsMap.loom_forum_add_comment = true;
    }
  }
  return toolsMap;
}

export function buildToolsMapWithoutLoom(config, { activeCount, includeStatePatch = false } = {}) {
  const agentToolsConfig = config.agentTools;
  const toolsMap = {};
  if (agentToolsConfig?.enabled) {
    const t = resolveBuiltInTools(agentToolsConfig);
    if (t.webfetch) toolsMap.webfetch = true;
    if (t.websearch) toolsMap.websearch = true;
    if (t.read) toolsMap.read = true;
    if (t.bash) toolsMap.bash = true;
    if (t.glob) toolsMap.glob = true;
    if (t.grep) toolsMap.grep = true;
    if (t.lsp) toolsMap.lsp = true;
    const loom = resolveLoomTools(agentToolsConfig);
    const isSolo = Number.isFinite(activeCount) && activeCount <= 1;
    if (loom.loom_request_next && !isSolo) toolsMap.loom_request_next = true;
    if (loom.loom_forum) {
      toolsMap.loom_forum_create_topic = true;
      toolsMap.loom_forum_list_topics = true;
      toolsMap.loom_forum_read_topic = true;
      toolsMap.loom_forum_add_comment = true;
    }
    // State-patch retry: the patch is not a peer interaction, so the audit-B8
    // rationale that keeps query/vote/summon out of this map does not apply.
    // Included only when the caller explicitly asks (mandatory retry) — never
    // for synthesis or recovery passes.
    if (includeStatePatch && loom.loom_state_patch) toolsMap.loom_state_patch = true;
  }
  return toolsMap;
}
