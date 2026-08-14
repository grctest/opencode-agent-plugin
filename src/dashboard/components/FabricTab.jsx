import { memo } from "react";
import { FabricViewer, AgentPerspective } from "./Cards.jsx";

function FabricTabBase({ state, participants }) {
  return (
    <div className="loom-main-content">
      <FabricViewer fabric={state?.fabric ?? ""} />
      {participants.length > 0 && (
        <div className="loom-mt-sm">
          <h3 className="loom-title-sm loom-mb-sm">Agent Perspectives</h3>
          <p className="loom-text-xs loom-text-muted loom-mb-sm">
            What each agent sees — persona, agenda, model, and shared context.
          </p>
          <div className="loom-space-sm">
            {participants.map((p) => (
              <AgentPerspective key={p.id} participant={p} meeting={state} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const FabricTab = memo(FabricTabBase);
export { FabricTab };
