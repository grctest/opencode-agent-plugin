import { memo, useMemo, useState } from "react";
import { cn } from "../utils.js";
import { ParticipantCard, ContentDialog, renderMarkdown } from "./Cards.jsx";
import { TierBadge, StatusBadge } from "./Badges.jsx";

const CONVERGENCE_LABELS = {
  consensus: "Consensus",
  majority: "Majority vote",
  moderator_forces: "Moderator-forced",
};

const THEME_OPTIONS = [
  { value: "light", label: "☀ Light" },
  { value: "dark", label: "☾ Dark" },
  { value: "system", label: "💻 System" },
];

function ThemeToggle({ theme, setTheme }) {
  return (
    <div className="loom-theme-toggle">
      {THEME_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          className={cn("pure-button loom-theme-btn", theme === opt.value && "pure-button-active")}
          onClick={() => setTheme(opt.value)}
          aria-pressed={theme === opt.value}
          aria-label={`${opt.label} theme`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function RoundIndicator({ current, max, status, convergence }) {
  const pct = max > 0 ? (current / max) * 100 : 0;
  return (
    <div className="loom-card">
      <div className="loom-flex loom-flex-between loom-mb-sm">
        <StatusBadge status={status} />
        <span className="loom-text-xs loom-text-muted">
          Round {current} / {max}
        </span>
      </div>
      <div className="loom-progress-track" role="progressbar" aria-valuenow={current} aria-valuemin={0} aria-valuemax={max} aria-label="Meeting progress">
        <div className="loom-progress-bar" style={{ width: `${pct}%` }} />
      </div>
      {convergence && (
        <span className="loom-text-xs loom-text-muted loom-mt-xs">Convergence: {CONVERGENCE_LABELS[convergence] ?? convergence}</span>
      )}
    </div>
  );
}

const Sidebar = memo(function Sidebar({
  state,
  participants,
  theme,
  setTheme,
  agentErrors,
  contributionsByParticipant,
  selectedMeeting,
  embeddingStatus,
}) {
  const [selectedParticipant, setSelectedParticipant] = useState(null);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState([]);
  const [switching, setSwitching] = useState(false);

  const errorByParticipant = useMemo(() => {
    const map = new Map();
    for (const e of agentErrors) {
      if (!map.has(e.participant_id)) map.set(e.participant_id, e);
    }
    return map;
  }, [agentErrors]);

  const modelName = embeddingStatus?.model?.split("/").pop() ?? embeddingStatus?.model;

  const isMeetingActive = state && (
    (state.round > 1) ||
    (state.status !== "initializing" && state.status !== "weaving")
  );

  const openModelDialog = async () => {
    setModelDialogOpen(true);
    try {
      const res = await fetch("/api/models");
      if (res.ok) {
        const data = await res.json();
        setAvailableModels(data.models ?? []);
      }
    } catch {
      // ignore
    }
  };

  const selectModel = async (modelName) => {
    setSwitching(true);
    try {
      const res = await fetch("/api/models/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName }),
      });
      if (res.ok) {
        setModelDialogOpen(false);
        window.location.reload();
      }
    } catch {
      // ignore
    } finally {
      setSwitching(false);
    }
  };

  return (
    <aside className="loom-sidebar">
      <div className="loom-sidebar-section">
        <h2 className="loom-sidebar-title">Loom</h2>
        <ThemeToggle theme={theme} setTheme={setTheme} />
        {modelName && (
          <div
            className={cn(
              "loom-card loom-sidebar-model-card",
              !isMeetingActive && "loom-sidebar-model-card-clickable"
            )}
            onClick={!isMeetingActive ? openModelDialog : undefined}
            role={!isMeetingActive ? "button" : undefined}
            tabIndex={!isMeetingActive ? 0 : undefined}
            onKeyDown={!isMeetingActive ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openModelDialog(); } } : undefined}
            title={isMeetingActive ? "Cannot change text encoder while a session is active" : "Click to change text encoder model"}
          >
            <div className="loom-sidebar-model-row">
              <span aria-hidden="true">🧮</span>
              <span className="loom-sidebar-model-name">{modelName}</span>
              {embeddingStatus.dims && (
                <span className="loom-text-xs loom-text-muted">({embeddingStatus.dims}d)</span>
              )}
              <span className={cn(
                "loom-sidebar-model-dot",
                embeddingStatus.state === "ready" ? "loom-sidebar-model-dot-ready" :
                embeddingStatus.state === "error" ? "loom-sidebar-model-dot-error" :
                "loom-sidebar-model-dot-loading"
              )} />
            </div>
            {embeddingStatus?.state === "error" && (
              <div className="loom-text-xs loom-text-muted loom-mt-xs" title={embeddingStatus.message}>
                <span aria-hidden="true">⚠</span> Emb. model failed — using placeholder vectors
              </div>
            )}
          </div>
        )}
      </div>

      {state && (
        <div className="loom-sidebar-section">
          <RoundIndicator current={state.round} max={state.max_rounds} status={state.status} convergence={state.convergence} />
        </div>
      )}

      {state && (
        <div className="loom-sidebar-section">
          <h3 className="loom-sidebar-heading">Participants ({participants.length})</h3>
          <div className="loom-space-xs">
            {participants.map((p) => (
              <ParticipantCard
                key={p.id}
                participant={p}
                error={errorByParticipant.get(p.id)}
                contributionsByRound={contributionsByParticipant[p.id] ?? {}}
                onSelect={setSelectedParticipant}
              />
            ))}
          </div>
        </div>
      )}

      <ContentDialog
        open={!!selectedParticipant}
        onClose={() => setSelectedParticipant(null)}
        title={selectedParticipant?.name ?? ""}
      >
        {selectedParticipant && (
          <div>
            {selectedParticipant.persona && (
              <div className="loom-participant-detail-section">
                <span className="loom-participant-detail-label">Persona</span>
                <div className="loom-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedParticipant.persona) }} />
              </div>
            )}
            {selectedParticipant.agenda && (
              <div className="loom-participant-detail-section">
                <span className="loom-participant-detail-label">Agenda</span>
                <p className="loom-text loom-text-muted">{selectedParticipant.agenda}</p>
              </div>
            )}
            {selectedParticipant.model_id && (
              <div className="loom-participant-detail-section">
                <span className="loom-participant-detail-label">Model</span>
                <p className="loom-text loom-text-muted">{selectedParticipant.provider_id}/{selectedParticipant.model_id}</p>
              </div>
            )}
            <div className="loom-participant-detail-section">
              <span className="loom-participant-detail-label">Seniority</span>
              <TierBadge tier={selectedParticipant.tier} />
            </div>
            {errorByParticipant.get(selectedParticipant.id) && (() => {
              const err = errorByParticipant.get(selectedParticipant.id);
              return (
                <div className="loom-participant-detail-section">
                  <span className="loom-participant-detail-label">Error</span>
                  <div className="loom-error-detail">
                    <span className="loom-error-type">{err.error_type}</span>
                    <span className="loom-error-message">{err.error_message}</span>
                    <span className="loom-error-attempts">{err.attempts} attempts</span>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </ContentDialog>

      <ContentDialog
        open={modelDialogOpen}
        onClose={() => setModelDialogOpen(false)}
        title="Text Encoder Model"
      >
        <div>
          <p className="loom-text loom-text-muted loom-mb-sm">
            The text encoder model is used for RAG (Retrieval-Augmented Generation) to embed and search deliberation context.
          </p>
          {isMeetingActive ? (
            <div className="loom-card loom-card-warning loom-mb-sm">
              <p className="loom-text" style={{ fontSize: "0.875rem" }}>
                A session is currently active. The text encoder cannot be changed mid-session as it would break the RAG index.
              </p>
            </div>
          ) : (
            <>
              <p className="loom-text loom-text-muted loom-mb-sm">
                Select a downloaded text encoder model. To download additional models, follow the plugin README instructions.
              </p>
              {availableModels.length > 1 ? (
                <div className="loom-space-xs">
                  {availableModels.map((m) => (
                    <div
                      key={m.name}
                      className={cn(
                        "loom-card loom-sidebar-model-option",
                        m.name === embeddingStatus?.model && "loom-sidebar-model-option-active"
                      )}
                      onClick={() => !switching && m.name !== embeddingStatus?.model && selectModel(m.name)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && m.name !== embeddingStatus?.model) { e.preventDefault(); selectModel(m.name); } }}
                    >
                      <div className="loom-sidebar-model-option-header">
                        <span className="loom-sidebar-model-option-name">{m.name?.split("/").pop() ?? m.name}</span>
                        {m.name === embeddingStatus?.model && (
                          <span className="loom-badge loom-badge-converged">active</span>
                        )}
                      </div>
                      {m.dims && <span className="loom-text-xs loom-text-muted">{m.dims}d</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="loom-text loom-text-muted">
                  Only one model is currently downloaded. Use <code>loom model:download</code> to add more.
                </p>
              )}
            </>
          )}
        </div>
      </ContentDialog>
    </aside>
  );
});

export { Sidebar };
