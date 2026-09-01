import { getConfig, resolveBuiltInTools, resolveLoomTools } from "../config.js";

export function buildToolsMap(config, { activeCount } = {}) {
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
    if (loom.loom_vector_search) toolsMap.loom_vector_search = true;
    if (loom.loom_query && !isSolo) toolsMap.loom_query = true;
    if (loom.loom_vote && !isSolo) toolsMap.loom_vote = true;
    if (loom.loom_summon) toolsMap.loom_summon = true;
    if (loom.loom_request_next && !isSolo) toolsMap.loom_request_next = true;
    if (loom.loom_pass) toolsMap.loom_pass = true;
    if (loom.loom_forum) {
      toolsMap.loom_forum_create_topic = true;
      toolsMap.loom_forum_list_topics = true;
      toolsMap.loom_forum_read_topic = true;
      toolsMap.loom_forum_add_comment = true;
    }
  }
  return toolsMap;
}

export function buildToolsMapWithoutLoom(config, { activeCount } = {}) {
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
    if (loom.loom_vector_search) toolsMap.loom_vector_search = true;
    if (loom.loom_request_next && !isSolo) toolsMap.loom_request_next = true;
  }
  return toolsMap;
}
