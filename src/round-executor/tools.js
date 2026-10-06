import { getConfig, resolveBuiltInTools, resolveLoomTools } from "../config.js";
import { isSummonAvailable } from "../services/embedding-gate.js";

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
    // BUILD offers live file edits. Predicate mirrors the Available-tools
    // prose in prompts/agent.js exactly (audit P1-F): the prompt must never
    // name a tool the map withholds, nor withhold one it names. Synthesis /
    // recovery map below stays write-free (prose composition only, like loom).
    const isBuildMode = agentToolsConfig?.buildMode === true ||
      (agentToolsConfig?.buildMode === undefined && (agentToolsConfig?.builtIn?.write === true || agentToolsConfig?.builtIn?.edit === true));
    if (isBuildMode) {
      toolsMap.write = true;
      toolsMap.edit = true;
    }
    const loom = resolveLoomTools(agentToolsConfig);
    const isSolo = Number.isFinite(activeCount) && activeCount <= 1;
    if (loom.loom_query && !isSolo) toolsMap.loom_query = true;
    if (loom.loom_vote && !isSolo) toolsMap.loom_vote = true;
    // Config grants permission; the embedder grants capability. Without a model
    // there is no persona index to rank the issue against, so the tool is not
    // offered at all rather than offered and refused.
    if (loom.loom_summon && isSummonAvailable()) toolsMap.loom_summon = true;
    if (loom.loom_request_next && !isSolo) toolsMap.loom_request_next = true;
    if (loom.loom_pass) toolsMap.loom_pass = true;
    // State patch is hidden from primary/synthesis by design
    // (omitStatePatch:true in the primary call, excluded from the synthesis
    // map below). The patch-only tail pass owns it with a { loom_state_patch }
    // map, so the model gets the full turn picture before projecting state.
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
    if (loom.loom_request_next && !isSolo) toolsMap.loom_request_next = true;
    if (loom.loom_forum) {
      toolsMap.loom_forum_create_topic = true;
      toolsMap.loom_forum_list_topics = true;
      toolsMap.loom_forum_read_topic = true;
      toolsMap.loom_forum_add_comment = true;
    }
    // loom_query/vote/summon stay out of this map: synthesis and recovery
    // passes must not open a new peer interaction with no further pass to
    // fold the answers in (audit B8). loom_request_next (fire-and-forget)
    // and the forum tools stay available. loom_state_patch stays out too:
    // only the dedicated patch tail may write the agent's notes.
  }
  return toolsMap;
}
