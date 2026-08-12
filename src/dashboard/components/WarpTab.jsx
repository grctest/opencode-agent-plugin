import { WarpViewer, AgentPerspective } from "./Cards.jsx";

export function WarpTab({ state, participants }) {
  return (
    <div className="loom-main-content">
      <WarpViewer warp={state?.warp ?? ""} />
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
