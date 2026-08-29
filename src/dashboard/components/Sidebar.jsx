import { memo, useMemo, useState, useCallback } from "react";
import { cn } from "../utils.js";
import { ParticipantCard, ContentDialog, OrchestratorDetailDialog, renderMarkdown } from "./Cards.jsx";
import { TierBadge } from "./Badges.jsx";
import { List } from "react-window";
import { Card, CardContent } from "./ui/card.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { ButtonGroup } from "./ui/button-group.tsx";
import { Progress, ProgressTrack, ProgressIndicator } from "./ui/progress.tsx";
import { Separator } from "./ui/separator.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { ScrollArea } from "./ui/scroll-area.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { TriangleAlertIcon, CircleCheckIcon } from "lucide-react";

const THEME_OPTIONS = [
  { value: "light", label: "☀ Light" },
  { value: "dark", label: "☾ Dark" },
  { value: "system", label: "💻 System" },
];

function ThemeToggle({ theme, setTheme }) {
  return (
    <ButtonGroup className="w-full">
      {THEME_OPTIONS.map((opt) => (
        <Button
          key={opt.value}
          variant={theme === opt.value ? "secondary" : "outline"}
          size="sm"
          className="flex-1"
          onClick={() => setTheme(opt.value)}
          aria-pressed={theme === opt.value}
          aria-label={`${opt.label} theme`}
        >
          {opt.label}
        </Button>
      ))}
    </ButtonGroup>
  );
}

function RoundIndicator({ current, max, status }) {
  return (
    <Card className="py-3 gap-2">
      <CardContent className="flex flex-col gap-1 py-0">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            Status: <Badge variant={status === "weaving" ? "weaving" : status === "converged" ? "converged" : "secondary"} className="ml-1">{status}</Badge>
          </span>
          <span className="text-xs text-muted-foreground">
            Round {current} / {max}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

const ParticipantRow = memo(({ index, style, participants, errorByParticipant, contributionsByParticipant, reflectingParticipantIds, onSelect }) => {
  const p = participants[index];
  return (
    <div style={style} className="px-1 py-[2px]">
      <ParticipantCard
        participant={p}
        error={errorByParticipant.get(p.id)}
        contributionsByRound={contributionsByParticipant[p.id] ?? {}}
        isReflecting={reflectingParticipantIds.has(p.id)}
        onSelect={onSelect}
      />
    </div>
  );
});

const Sidebar = memo(function Sidebar({
  state,
  participants,
  theme,
  setTheme,
  agentErrors,
  contributionsByParticipant,
  contributionCountsByParticipant,
  selectedMeeting,
  embeddingStatus,
  connected,
  reconnectAttempt,
  reflectingParticipants,
  orchestratorMessages,
}) {
  const [selectedParticipant, setSelectedParticipant] = useState(null);
  const [orchestratorDialogOpen, setOrchestratorDialogOpen] = useState(false);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState([]);
  const [switching, setSwitching] = useState(false);

  const orchestratorActionCount = useMemo(() => {
    return (orchestratorMessages ?? []).length;
  }, [orchestratorMessages]);

  const isOrchestratorProcessing = useMemo(() => {
    if (!orchestratorMessages || orchestratorMessages.length === 0) return false;
    const last = orchestratorMessages[orchestratorMessages.length - 1];
    return last && last.role === "user";
  }, [orchestratorMessages]);

  const highestTierModel = useMemo(() => {
    if (!participants || participants.length === 0) return null;
    const tierOrder = ["principal", "senior", "mid", "junior"];
    for (const tier of tierOrder) {
      const p = participants.find((pp) => pp.tier === tier && pp.model_id);
      if (p) return `${p.provider_id}/${p.model_id}`;
    }
    return null;
  }, [participants]);

  const errorByParticipant = useMemo(() => {
    const map = new Map();
    for (const e of agentErrors) {
      if (!map.has(e.participant_id)) map.set(e.participant_id, e);
    }
    return map;
  }, [agentErrors]);

  const reflectingParticipantIds = useMemo(() => {
    return new Set((reflectingParticipants ?? []).map((p) => p.id));
  }, [reflectingParticipants]);

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

  const selectModel = async (mName) => {
    setSwitching(true);
    try {
      const res = await fetch("/api/models/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: mName }),
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
    <aside className="w-[18rem] shrink-0 border-r bg-background flex flex-col h-[100dvh] overflow-hidden">
      <ScrollArea className="flex-1">
        <div className="p-4 flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">Loom</h2>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={cn("text-xs flex items-center gap-1", connected ? "text-emerald-600" : "text-muted-foreground")}>
                    {connected ? "● live" : reconnectAttempt > 0 ? `⚠ reconnecting (${reconnectAttempt})` : "○ offline"}
                  </span>
                </TooltipTrigger>
                {reconnectAttempt > 0 && (
                  <TooltipContent>Reconnecting to live updates (attempt {reconnectAttempt}/10). State keeps refreshing, but at a slower rate.</TooltipContent>
                )}
              </Tooltip>
            </div>
            <ThemeToggle theme={theme} setTheme={setTheme} />
            {modelName && (
              <Card
                className={cn("py-2.5 px-3 gap-1", !isMeetingActive && "cursor-pointer hover:border-ring hover:bg-accent")}
                onClick={!isMeetingActive ? openModelDialog : undefined}
                role={!isMeetingActive ? "button" : undefined}
                tabIndex={!isMeetingActive ? 0 : undefined}
                onKeyDown={!isMeetingActive ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openModelDialog(); } } : undefined}
                title={isMeetingActive ? "Cannot change text encoder while a session is active" : "Click to change text encoder model"}
              >
                <div className="flex items-center gap-1.5 text-[13px]">
                  <span aria-hidden="true">🧮</span>
                  <span className="font-medium truncate">{modelName}</span>
                  {embeddingStatus.dims && (
                    <span className="text-xs text-muted-foreground">({embeddingStatus.dims}d)</span>
                  )}
                  <span className={cn(
                    "ml-auto size-1.5 rounded-full",
                    embeddingStatus.state === "ready" ? "bg-emerald-500" :
                    embeddingStatus.state === "error" ? "bg-destructive" :
                    "bg-amber-500"
                  )} />
                </div>
                {embeddingStatus?.state === "error" && (
                  <div className="text-xs text-muted-foreground flex items-center gap-1" title={embeddingStatus.message}>
                    <TriangleAlertIcon className="size-3" /> Emb. model failed — using placeholder vectors
                  </div>
                )}
              </Card>
            )}
          </div>

          <Separator />

          {state && (
            <RoundIndicator current={state.round} max={state.max_rounds} status={state.status} />
          )}

          {state && (
            <Card
              className="cursor-pointer hover:border-ring hover:bg-accent py-3"
              onClick={() => setOrchestratorDialogOpen(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOrchestratorDialogOpen(true); } }}
            >
              <div className="flex items-center gap-2 px-3">
                <span className="text-sm font-medium">Orchestrator</span>
                {isOrchestratorProcessing && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Spinner className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipContent>Processing orchestrator prompt</TooltipContent>
                  </Tooltip>
                )}
                {orchestratorActionCount > 0 && (
                  <Badge variant="orchestrator" className="ml-auto text-[11px]">{orchestratorActionCount}</Badge>
                )}
              </div>
            </Card>
          )}

          <OrchestratorDetailDialog
            open={orchestratorDialogOpen}
            onClose={() => setOrchestratorDialogOpen(false)}
            orchestratorMessages={orchestratorMessages}
            highestTierModel={highestTierModel}
          />

          {state && (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground px-1">Participants ({participants.length})</h3>
              {participants.length > 0 && (
                <div className="h-[320px] w-full">
                  <List
                    height="100%"
                    rowCount={participants.length}
                    rowHeight={75}
                    rowComponent={ParticipantRow}
                    rowProps={{ participants, errorByParticipant, contributionsByParticipant, reflectingParticipantIds, onSelect: setSelectedParticipant }}
                    width="100%"
                    overscanCount={3}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      <ContentDialog
        open={!!selectedParticipant}
        onClose={() => setSelectedParticipant(null)}
        title={selectedParticipant?.name ?? ""}
      >
        {selectedParticipant && (
          <div className="flex flex-col gap-4">
            {selectedParticipant.persona && (
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Persona</span>
                <div className="prose prose-sm max-w-none dark:prose-invert text-sm mt-1" dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedParticipant.persona) }} />
              </div>
            )}
            {selectedParticipant.agenda && (
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Agenda</span>
                <p className="text-sm text-muted-foreground mt-1">{selectedParticipant.agenda}</p>
              </div>
            )}
            {selectedParticipant.model_id && (
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Model</span>
                <p className="text-sm text-muted-foreground mt-1">{selectedParticipant.provider_id}/{selectedParticipant.model_id}</p>
              </div>
            )}
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Seniority</span>
              <div className="mt-1"><TierBadge tier={selectedParticipant.tier} /></div>
            </div>
            {contributionCountsByParticipant[selectedParticipant.id] && (() => {
              const counts = contributionCountsByParticipant[selectedParticipant.id];
              return (
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Activity</span>
                  <div className="flex gap-4 items-center mt-1">
                    <span className="text-sm">{counts.contributions} contribution{counts.contributions !== 1 ? "s" : ""}</span>
                    <span className="text-sm">{counts.reflections} reflection{counts.reflections !== 1 ? "s" : ""}</span>
                  </div>
                </div>
              );
            })()}
            {errorByParticipant.get(selectedParticipant.id) && (() => {
              const err = errorByParticipant.get(selectedParticipant.id);
              return (
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Error</span>
                  <Alert variant="destructive" className="mt-1">
                    <TriangleAlertIcon />
                    <AlertTitle>{err.error_type}</AlertTitle>
                    <AlertDescription>{err.error_message} — {err.attempts} attempts</AlertDescription>
                  </Alert>
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
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            The text encoder model is used for RAG to embed and search deliberation context.
          </p>
          {isMeetingActive ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>Session active</AlertTitle>
              <AlertDescription>The text encoder cannot be changed mid-session as it would break the RAG index.</AlertDescription>
            </Alert>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Select a downloaded text encoder model. To download additional models, follow the plugin README instructions.
              </p>
              {availableModels.length > 1 ? (
                <div className="flex flex-col gap-2">
                  {availableModels.map((m) => (
                    <Card
                      key={m.name}
                      className={cn(
                        "py-2.5 px-3 cursor-pointer hover:border-ring hover:bg-accent",
                        m.name === embeddingStatus?.model && "border-primary bg-primary/5 cursor-default"
                      )}
                      onClick={() => !switching && m.name !== embeddingStatus?.model && selectModel(m.name)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && m.name !== embeddingStatus?.model) { e.preventDefault(); selectModel(m.name); } }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{m.name?.split("/").pop() ?? m.name}</span>
                        {m.name === embeddingStatus?.model && (
                          <Badge variant="converged">active</Badge>
                        )}
                        {switching && m.name !== embeddingStatus?.model && <Spinner className="size-3" />}
                      </div>
                      {m.dims && <span className="text-xs text-muted-foreground">{m.dims}d</span>}
                    </Card>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Only one model is currently downloaded. Use <code className="bg-muted px-1 py-0.5 rounded text-xs">loom model:download</code> to add more.
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
