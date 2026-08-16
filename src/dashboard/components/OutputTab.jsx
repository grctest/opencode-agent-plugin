import { memo } from "react";
import { renderMarkdown } from "./Cards.jsx";

function OutputTabBase({ artifact }) {
  if (!artifact) {
    return (
      <div className="loom-card">
        <p className="loom-text loom-text-muted">
          No final artifact yet. It appears here once the deliberation completes and synthesis finishes.
        </p>
      </div>
    );
  }

  const html = renderMarkdown(artifact.content ?? "");

  return (
    <div className="loom-output-tab">
      <div className="loom-card">
        <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }} />
        <div className="loom-dialog-footer">
          <span className="loom-text-xs loom-text-muted">
            {artifact.created_at ? `Generated ${new Date(artifact.created_at).toLocaleString()}` : ""}
          </span>
          <button
            className="pure-button loom-copy-btn"
            onClick={() => navigator.clipboard.writeText(artifact.content ?? "")}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}

const OutputTab = memo(OutputTabBase);
export { OutputTab };
