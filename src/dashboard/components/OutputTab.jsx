import { memo } from "react";
import { cn } from "../utils.js";
import { renderMarkdown } from "./Cards.jsx";

function SectionList({ title, items, isHtml = false }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="loom-card loom-card-section">
      <h3 className="loom-title-sm loom-mb-sm">{title}</h3>
      <ul className="loom-plain-list">
        {items.map((item, i) => (
          <li key={i} className="loom-text">
            {isHtml ? <div className="loom-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(item)) }} /> : String(item)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OutputTabBase({ artifact, participants }) {
  if (!artifact) {
    return (
      <div className="loom-card">
        <p className="loom-text loom-text-muted">
          No final artifact yet. It appears here once the deliberation completes and synthesis finishes.
        </p>
      </div>
    );
  }

  return (
    <div className="loom-output-tab">
      <div className="loom-flex loom-gap-md loom-mb-md loom-items-center">
        <span className={cn("loom-badge", `loom-badge-confidence-${artifact.confidence ?? "unknown"}`)}>
          Confidence: {artifact.confidence ?? "unknown"}
        </span>
        <span className="loom-text-xs loom-text-muted">
          {artifact.created_at ? `Generated ${new Date(artifact.created_at).toLocaleString()}` : "Generated at unknown time"}
        </span>
      </div>

      {artifact.decisions?.length > 0 && <SectionList title="Decisions" items={artifact.decisions} isHtml={true} />}
      {artifact.action_items?.length > 0 && <SectionList title="Action Items" items={artifact.action_items} />}
      {artifact.open_questions?.length > 0 && <SectionList title="Open Questions" items={artifact.open_questions} />}
      {artifact.dissent?.length > 0 && <SectionList title="Unresolved Objections" items={artifact.dissent.map((d) => typeof d === 'object' ? d.content : d)} />}
      {artifact.refusals?.length > 0 && (
        <div className="loom-card loom-card-section loom-card-warning">
          <h3 className="loom-title-sm loom-mb-sm">Refusals</h3>
          <ul className="loom-plain-list">
            {artifact.refusals.map((r, i) => (
              <li key={i} className="loom-text">
                <span className="loom-text-xs loom-text-bold">— {r.participant_id}</span>
                <div className="loom-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(r.content)) }} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="loom-card">
        <h3 className="loom-title-sm loom-mb-sm">Full Artifact</h3>
        <pre className="loom-artifact-pre">{artifact.content}</pre>
        <div className="loom-dialog-footer">
          <button
            className="pure-button loom-copy-btn"
            onClick={() => navigator.clipboard.writeText(artifact.content ?? "")}
          >
            Copy full artifact
          </button>
        </div>
      </div>
    </div>
  );
}

const OutputTab = memo(OutputTabBase);
export { OutputTab };
