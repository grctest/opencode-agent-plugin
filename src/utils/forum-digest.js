import { sanitizeForDisplay } from "./sanitize.js";

/**
 * Forum side-thread digest (post-mortem 7811b8db §8): the forum was a
 * write-only sink — neither the State of Play nor the final synthesis consumed
 * forum content, and topics carried no citable id inside the graded [#id]
 * economy, so a rational agent rationally ignored an optional forum (0 uses in
 * 400 despite the tool being enabled). Two of the four causes are fixed at the
 * prompt/tool level (citable [#T{id}] labels + seeding); this module closes the
 * remaining structural one: a bounded digest that reaches every reader by
 * traveling inside the State of Play (agents each turn, round clerk, final
 * synthesis — all of which render/update the SoP).
 *
 * Topics come from `db.listForumTopicsForPrompt(5)` (single query, activity
 * ordered, 200-char previews already selected — audit A13). Every line carries
 * the `[#T{id}]` citation key so contributions citing a thread satisfy the
 * peer-engagement contract (§2/§13) the same way query answers do.
 */

const TOPIC_LINE_CAP = 300;

function trimLine(text, cap = TOPIC_LINE_CAP) {
  const safe = sanitizeForDisplay(String(text ?? ""), cap).replace(/\s+/g, " ").trim();
  return safe;
}

/**
 * Formats the topics list into the `## Forum Threads` SoP section.
 * Returns "" when there are no topics (SoP stays byte-identical for meetings
 * with an empty/disabled forum) and is bounded: max 5 lines × ~300 chars plus
 * the fixed header/footer, so it fits the existing context-budget guardrails.
 * @param {Array<{id: number|string, title: string, preview?: string|null, latest_preview?: string|null, comment_count?: number, latest_commenter_name?: string|null}>} topics
 * @param {{maxTopics?: number}} [opts]
 * @returns {string}
 */
export function formatForumSideThreadsSection(topics = [], { maxTopics = 5 } = {}) {
  const list = (Array.isArray(topics) ? topics : []).slice(0, Math.max(1, maxTopics));
  if (list.length === 0) return "";
  const lines = [`## Forum Threads (cite in prose as [#T{id}])`];
  for (const t of list) {
    const id = t.id;
    if (id === undefined || id === null || id === "") continue;
    const title = trimLine(t.title, 100) || "(untitled)";
    const count = Number(t.comment_count ?? 0);
    const countStr = `${count} ${count === 1 ? "reply" : "replies"}`;
    const latest = trimLine(t.latest_preview, 160);
    const latestBy = t.latest_commenter_name ? ` (@${trimLine(t.latest_commenter_name, 40)})` : "";
    let line = `- [#T${id}] “${title}” — ${countStr}`;
    if (latest) line += ` — latest: ${latest}${latestBy}`;
    else if (count > 0) line += " — latest: (unread)";
    else {
      const opening = trimLine(t.preview, 160);
      if (opening) line += ` — open, no replies yet: ${opening}`;
    }
    lines.push(line);
  }
  lines.push("_Threads digest into the shared record: surfaced here each round and in the final synthesis — writing here is writing to the room. Read the full thread with loom_forum_read_topic {topic_id: id}._");
  return lines.join("\n");
}
