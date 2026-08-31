import { getConfig, resolveBuiltInTools, resolveLoomTools } from "../config.js";

export function buildToolsMap(config) {
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
    if (loom.loom_vector_search) toolsMap.loom_vector_search = true;
    if (loom.loom_query) toolsMap.loom_query = true;
    if (loom.loom_vote) toolsMap.loom_vote = true;
    if (loom.loom_summon) toolsMap.loom_summon = true;
    if (loom.loom_request_next) toolsMap.loom_request_next = true;
    if (loom.loom_pass) toolsMap.loom_pass = true;
  }
  return toolsMap;
}

export function buildToolsMapWithoutLoom(config) {
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
    if (loom.loom_vector_search) toolsMap.loom_vector_search = true;
    if (loom.loom_request_next) toolsMap.loom_request_next = true;
  }
  return toolsMap;
}
