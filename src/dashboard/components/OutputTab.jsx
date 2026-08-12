import { cn } from "../utils.js";

function SectionList({ title, items }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="loom-card loom-card-section">
      <h3 className="loom-title-sm loom-mb-sm">{title}</h3>
      <ul className="loom-plain-list">
        {items.map((item, i) => (
          <li key={i} className="loom-text">{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function OutputTab({ artifact, participants }) {
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
          Generated {new Date(artifact.created_at).toLocaleString()}
        </span>
      </div>

      {artifact.decisions?.length > 0 && <SectionList title="Decisions" items={artifact.decisions} />}
      {artifact.action_items?.length > 0 && <SectionList title="Action Items" items={artifact.action_items} />}
      {artifact.open_questions?.length > 0 && <SectionList title="Open Questions" items={artifact.open_questions} />}
      {artifact.dissent?.length > 0 && <SectionList title="Unresolved Objections" items={artifact.dissent.map((d) => d.content ?? d)} />}

      <div className="loom-card">
        <h3 className="loom-title-sm loom-mb-sm">Full Artifact</h3>
        <pre className="loom-artifact-pre">{artifact.content}</pre>
      </div>
    </div>
  );
}
