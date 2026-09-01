import { useRef, useMemo, useCallback, useState, useEffect, memo } from "react";
import { cn, relativeTime } from "../utils.js";
import { ContributionItem, TurnRequestItem, ThinkingCard, ReflectionRow, QueryResponseRow, EvidenceResponseRow, SummonedResponseRow, VoteResponseRow, OrchestratorItem, ORCHESTRATOR_TYPE_META, ContentDialog, renderMarkdown } from "./Cards.jsx";
import { buildFlatItems, pairOrchestratorMessages } from "../utils/timeline.js";
import { List } from "react-window";
import { Card, CardContent } from "./ui/card.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "./ui/empty.tsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { Table, TableBody, TableCell, TableRow } from "./ui/table.tsx";
import { Separator } from "./ui/separator.tsx";
import { MessageSquareIcon, TriangleAlertIcon, CopyIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";

function getToolCallsArray(contribution) {
  if (!contribution) return [];
  const raw = contribution.tool_calls;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p;
      if (p && typeof p === "object") return [p];
      if (typeof p === "string") {
        try { const p2 = JSON.parse(p); if (Array.isArray(p2)) return p2; if (p2 && typeof p2 === "object") return [p2]; } catch {}
      }
    } catch {}
    return [];
  }
  return [];
}

function prettyJson(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    try { const p = JSON.parse(value); return JSON.stringify(p, null, 2); } catch { return value; }
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

const THINKING_TURN_HEIGHT = 56;
const THINKING_REFLECTION_HEIGHT = 56;
const THINKING_QUERY_HEIGHT = 56;
const THINKING_EVIDENCE_HEIGHT = 56;
const THINKING_SUMMON_HEIGHT = 56;

const HEADER_HEIGHT = 48;
const CONTRIBUTION_HEIGHT = 56;
const INTERJECTION_HEIGHT = 72;
const EXTENSION_MARKER_HEIGHT = 32;
const REFLECTION_HEIGHT = 35;
const QUERY_RESPONSE_HEIGHT = 35;
const EVIDENCE_RESPONSE_HEIGHT = 35;
const SUMMONED_RESPONSE_HEIGHT = 35;
const VOTE_RESPONSE_HEIGHT = 35;
const ORCHESTRATOR_ITEM_HEIGHT = 48;

const ROUND_SUMMARY_HEIGHT = 88;

const LOOM_INVOCATION_HEIGHT = 39;

const ModelFallbackItem = memo(({ error, participantName }) => {
  const [expanded, setExpanded] = useState(false);
  const name = participantName(error.participant_id);
  const msg = error.error_message || "";
  const parts = msg.split(" — ");
  const modelInfo = parts[0] || msg;
  const errorMsg = parts.slice(1).join(" — ") || "unknown error";
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <Card className="border-amber-500/50 py-2">
        <CollapsibleTrigger className="flex items-center gap-2 w-full px-3 text-left">
          <span aria-hidden="true">🔄</span>
          <span className="text-sm"><strong>{name}</strong> switched models — {modelInfo}</span>
          <span className="ml-auto text-muted-foreground text-xs flex items-center gap-1">{expanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pt-2 mt-2 border-t"><span className="text-xs text-muted-foreground">{errorMsg}</span></div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
});

const RoundSummaryItem = memo(({ summary, group, onDialogOpen }) => {
  const openDialog = () => onDialogOpen?.({ orchestratorGroup: group, type: "summary" });
  return (
    <Card role="button" tabIndex={0} className="border-dashed border-l-[3px] border-l-amber-500 cursor-pointer hover:bg-accent py-3" onClick={openDialog} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDialog(); } }}>
      <div className="flex flex-wrap gap-2 items-center mb-1 px-3">
        <span className="text-sm font-semibold">Orchestrator</span>
        <Badge variant="orchestrator" className="ml-auto">{ORCHESTRATOR_TYPE_META.summary.label}</Badge>
      </div>
      <div className="text-sm text-muted-foreground whitespace-pre-wrap break-words px-3">{summary}</div>
    </Card>
  );
});

// pairOrchestratorMessages now imported from ../utils/timeline.js; local wrapper kept for compatibility
// function pairOrchestratorMessages removed — see utils/timeline.js

function getRowHeight(item) {
  if (item.type === "header") {
    return HEADER_HEIGHT + (item.showExtensionMarker ? EXTENSION_MARKER_HEIGHT : 0);
  }
  if (item.type === "round_summary") return ROUND_SUMMARY_HEIGHT;
  if (item.type === "turn_request") return INTERJECTION_HEIGHT;
  if (item.type === "model_fallback") return INTERJECTION_HEIGHT;
  if (item.type === "reflection") return REFLECTION_HEIGHT;
  if (item.type === "query_response") return QUERY_RESPONSE_HEIGHT;
  if (item.type === "perspective_response") return EVIDENCE_RESPONSE_HEIGHT;
  if (item.type === "critique_response") return EVIDENCE_RESPONSE_HEIGHT;
  if (item.type === "evidence_response") return EVIDENCE_RESPONSE_HEIGHT;
  if (item.type === "summoned_response") return SUMMONED_RESPONSE_HEIGHT;
  if (item.type === "vote_response") return VOTE_RESPONSE_HEIGHT;
  if (item.type === "loom_invocation") return LOOM_INVOCATION_HEIGHT;
  if (item.type === "orchestrator") return ORCHESTRATOR_ITEM_HEIGHT;
  if (item.type === "thinking_turn") return THINKING_TURN_HEIGHT;
  if (item.type === "thinking_reflection") return THINKING_REFLECTION_HEIGHT;
  if (item.type === "thinking_query") return THINKING_QUERY_HEIGHT;
  if (item.type === "thinking_evidence") return THINKING_EVIDENCE_HEIGHT;
  if (item.type === "thinking_summon") return THINKING_SUMMON_HEIGHT;
  if (item.type === "agent_turn") {
    const n = item.contributions?.length ?? 1;
    const longest = Math.max(0, ...item.contributions.map(c => (c.content ?? "").length));
    // pt-4 (16px) top + pb-[3px] (3px) bottom = 19 vs old 4 → +15
    return 103 + Math.max(0, n - 1) * 22 + (longest > 500 ? 16 : 0);
  }
  return 115;
}

const TimelineRow = memo(({ index, style, items, onToggleCollapse, participantName, onDialogOpen, onOrchestratorDialogOpen, contributions }) => {
  const item = items[index];
  if (!item) return null;
  if (item.type === "header") {
    return (
      <div style={style} className="overflow-hidden py-0.5">
        {item.showExtensionMarker && (
          <div className="flex items-center gap-2 my-3">
            <Separator className="flex-1" />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-blue-600">Extended</span>
            <Separator className="flex-1" />
          </div>
        )}
        <div className={cn("mb-1", item.isActive && "[&>button]:border-primary")}>
          <Button variant="outline" className="w-full justify-start gap-2 h-auto py-2" onClick={() => onToggleCollapse(item.round)} aria-expanded={!item.isCollapsed} aria-controls={`round-content-${item.round}`} aria-label={`Round ${item.round} ${item.isCollapsed ? "collapsed" : "expanded"}`}>
            <span className="text-[10px] text-muted-foreground w-3">{item.isCollapsed ? "▶" : "▼"}</span>
            <span className="text-sm font-semibold">Round {item.round}</span>
            <span className="text-xs text-muted-foreground ml-auto" aria-live="polite">{item.contribsCount} contribution{item.contribsCount !== 1 ? "s" : ""}</span>
            {item.errorsCount > 0 && (<Badge variant="destructive" className="ml-1"><TriangleAlertIcon className="size-3" /> {item.errorsCount}</Badge>)}
          </Button>
          <div id={`round-content-${item.round}`} hidden={item.isCollapsed} aria-hidden={item.isCollapsed} />
        </div>
      </div>
    );
  }
  if (item.type === "agent_turn") {
    return (
      <div style={style} className="overflow-hidden pt-4 pb-[3px]">
        <div className="flex flex-col gap-1.5">
          {item.contributions.map((c) => (
            <ContributionItem key={c.id} contribution={c} participantName={participantName(item.agentId)} onDialogOpen={onDialogOpen} />
          ))}
        </div>
      </div>
    );
  }
  if (item.type === "loom_invocation") {
    const { invocation } = item;
    const toolName = invocation.tool ?? invocation.attempted_tool ?? "loom";
    const isError = !!invocation.error || invocation.status === "error";
    let detail = "";
    try {
      const input = typeof invocation.input === "string" ? JSON.parse(invocation.input) : invocation.input;
      if (toolName === "loom_query" || toolName === "loom_evidence") {
        detail = `${Array.isArray(input.targets) ? input.targets.join(", ") : ""}: ${(input.question ?? "").slice(0,80)}`;
      } else if (toolName === "loom_vote") {
        detail = (input.question ?? "").slice(0,80);
      } else if (toolName === "loom_summon") {
        detail = `${input.persona_name ?? input.personaName ?? ""}: ${(input.issue ?? "").slice(0,60)}`;
      } else if (toolName === "loom_request_next") {
        detail = `P${input.priority} ${input.reason ?? ""}`.slice(0,80);
      } else if (input && typeof input === "object") detail = JSON.stringify(input).slice(0,80);
    } catch { detail = invocation.input ? String(invocation.input).slice(0,80) : ""; }
    const openInvokerDialog = (e) => {
      e.stopPropagation();
      const source = (contributions ?? []).find(c => c.id === item.sourceContributionId);
      if (source && onDialogOpen) onDialogOpen({ contribution: source, participantName: participantName(item.sourceParticipantId), isLoomInvocation: true });
    };
    return (
      <div style={style} className="pl-6 overflow-hidden" title={`${detail} — click to open invoker's Tool use`}>
        <Card className="border-l-[3px] border-l-[#6366f1] py-1.5 px-3 gap-1 opacity-95 cursor-pointer hover:bg-accent mb-[3px]" onClick={openInvokerDialog} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openInvokerDialog(e); } }}>
          <div className="flex flex-wrap gap-2 items-center">
            <Badge variant={isError ? "destructive" : "orchestrator"} className="text-[10px] px-1.5 py-0 h-4">{toolName.replace("loom_", "")}</Badge>
            <span className="text-xs text-muted-foreground truncate flex-1">{detail}</span>
            <Badge variant={isError ? "destructive" : "secondary"} className="text-[10px] px-1.5 py-0 h-4">{isError ? "error" : "invoked"}</Badge>
          </div>
        </Card>
      </div>
    );
  }
  if (item.type === "reflection") {
    return (
      <div style={style} className="pl-6 overflow-hidden">
        <ReflectionRow
          reflection={item.reflection}
          contributions={contributions}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
        />
      </div>
    );
  }
  if (item.type === "query_response") {
    return (
      <div style={style} className="pl-6 overflow-hidden">
        <QueryResponseRow
          queryResponse={item.queryResponse}
          contributions={contributions}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
          invokerId={item.invokerId}
        />
      </div>
    );
  }
  if (item.type === "perspective_response") {
    return (
      <div style={style} className="pl-6 overflow-hidden">
        <QueryResponseRow
          queryResponse={item.perspectiveResponse}
          contributions={contributions}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
          invokerId={item.invokerId}
        />
      </div>
    );
  }
  if (item.type === "critique_response") {
    return (
      <div style={style} className="pl-6 overflow-hidden">
        <QueryResponseRow
          queryResponse={item.critiqueResponse}
          contributions={contributions}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
          invokerId={item.invokerId}
        />
      </div>
    );
  }
  if (item.type === "thinking_turn") {
    return (
      <div style={style} className="overflow-hidden py-0.5">
        <Card className="border-dashed opacity-70 py-2">
          <CardContent className="flex items-center gap-3 py-0">
            <Spinner className="size-4" />
            <span className="text-sm text-muted-foreground">{item.participant.name} ({item.participant.tier}) is thinking...</span>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (item.type === "thinking_reflection") {
    return (
      <div style={style} className="pl-6 overflow-hidden">
        <Card className="border-dashed opacity-70 py-1.5 border-l-2 border-l-[var(--badge-indigo)] bg-[color-mix(in_oklch,var(--badge-indigo)_4%,var(--card))]">
          <CardContent className="flex items-center gap-3 py-0">
            <Spinner className="size-4" />
            <span className="text-sm text-muted-foreground">Reflection by {item.reflectorName} on {item.triggerAgentName}'s {item.triggerType}...</span>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (item.type === "thinking_query") {
    return (
      <div style={style} className="pl-6 overflow-hidden">
        <Card className="border-dashed opacity-70 py-1.5 border-l-2 border-l-[var(--badge-teal)] bg-[color-mix(in_oklch,var(--badge-teal)_4%,var(--card))]">
          <CardContent className="flex items-center gap-3 py-0">
            <Spinner className="size-4" />
            <span className="text-sm text-muted-foreground">{item.queriedAgentName} is answering a query...</span>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (item.type === "thinking_evidence") {
    return (
      <div style={style} className="pl-6 overflow-hidden">
        <Card className="border-dashed opacity-70 py-1.5 border-l-2 border-l-[var(--badge-sky)] bg-[color-mix(in_oklch,var(--badge-sky)_4%,var(--card))]">
          <CardContent className="flex items-center gap-3 py-0">
            <Spinner className="size-4" />
            <span className="text-sm text-muted-foreground">{item.evidenceAgentName} is finding evidence...</span>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (item.type === "thinking_summon") {
    return (
      <div style={style} className="pl-6 overflow-hidden">
        <Card className="border-dashed opacity-70 py-1.5 border-l-2 border-l-[var(--badge-violet)] bg-[color-mix(in_oklch,var(--badge-violet)_4%,var(--card))]">
          <CardContent className="flex items-center gap-3 py-0">
            <Spinner className="size-4" />
            <span className="text-sm text-muted-foreground">Guest expert is being summoned...</span>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (item.type === "evidence_response") {
    return (
      <div style={style} className="pl-6 overflow-hidden">
        <EvidenceResponseRow
          evidenceResponse={item.evidenceResponse}
          contributions={contributions}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
          invokerId={item.invokerId}
        />
      </div>
    );
  }
  if (item.type === "summoned_response") {
    return (
      <div style={style} className="pl-6 overflow-hidden">
        <SummonedResponseRow
          summonedResponse={item.summonedResponse}
          contributions={contributions}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
          invokerId={item.invokerId}
        />
      </div>
    );
  }
  if (item.type === "vote_response") {
    return (
      <div style={style} className="pl-6 overflow-hidden">
        <VoteResponseRow voteResponse={item.voteResponse} contributions={contributions} participantName={participantName} onDialogOpen={onDialogOpen} invokerId={item.invokerId} />
      </div>
    );
  }
  if (item.type === "round_summary") {
    return (
      <div style={style} className="overflow-hidden py-0.5">
        <RoundSummaryItem summary={item.summary} group={item.group} onDialogOpen={onOrchestratorDialogOpen} />
      </div>
    );
  }
  if (item.type === "contribution") {
    return (
      <div style={style} className="overflow-hidden py-0.5">
        <ContributionItem contribution={item.contribution} participantName={participantName(item.contribution.participant_id)} onDialogOpen={onDialogOpen} />
      </div>
    );
  }
  if (item.type === "orchestrator") {
    return (
      <div style={style} className="overflow-hidden py-0.5">
        <OrchestratorItem group={item.group} onDialogOpen={onOrchestratorDialogOpen} />
      </div>
    );
  }
  if (item.type === "model_fallback") {
    return (
      <div style={style} className="overflow-hidden py-0.5">
        <ModelFallbackItem error={item.error} participantName={participantName} />
      </div>
    );
  }
  return (
    <div style={style} className="overflow-hidden py-0.5">
      <TurnRequestItem turnRequest={item.turnRequest} participantName={participantName(item.turnRequest.participant_id)} />
    </div>
  );
});

const TimelineTabBase = ({
  contributions,
  groupedContributions,
  isWeaving,
  thinkingParticipants,
  reflectingParticipants,
  queryingParticipants,
  evidenceParticipants,
  summoningParticipants,
  collapsedRounds,
  onToggleCollapse,
  agentErrors,
  participantName,
  turnRequests,
  extensions,
  activeRound,
  maxRounds,
  orchestratorMessages,
  roundSummaries = {},
  selectedMeeting,
}) => {
  const listRef = useRef(null);
  const [dialogContribution, setDialogContribution] = useState(null);
  const [dialogOrchestratorGroup, setDialogOrchestratorGroup] = useState(null);
  const [activeTab, setActiveTab] = useState("response");
  const [orchestratorActiveTab, setOrchestratorActiveTab] = useState("prompt");
  const [fetchedContext, setFetchedContext] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState(null);

  const handleDialogOpen = useCallback((data) => {
    setDialogContribution(data);
    setActiveTab("response");
    setFetchedContext(null);
    setContextError(null);
    setContextLoading(false);
  }, []);

  // P1: resolve live contribution from current contributions array so Tool use tab never shows stale empty snapshot
  const liveDialogContribution = useMemo(() => {
    if (!dialogContribution?.contribution) return dialogContribution;
    const cid = dialogContribution.contribution.id;
    if (cid == null) return dialogContribution;
    const live = contributions.find(c => c.id === cid);
    if (!live) return dialogContribution;
    // Preserve dialog flags (isReflection etc) but replace contribution with live one
    return { ...dialogContribution, contribution: live };
  }, [dialogContribution, contributions]);

  const liveToolCalls = useMemo(() => getToolCallsArray(liveDialogContribution?.contribution), [liveDialogContribution]);

  const meetingIdForContext = selectedMeeting ?? (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const m = params.get("meeting");
      if (m) return m;
      const hash = window.location.hash.slice(1);
      if (hash) return hash;
    } catch {}
    return null;
  })();

  useEffect(() => {
    const live = liveDialogContribution ?? dialogContribution;
    const pc = live?.contribution?.prompt_context;
    const hasFullContext = pc && (pc.system_prompt || pc.user_prompt || pc.state_of_play || pc.round_contributions_used);
    if (activeTab !== "context" || !live || hasFullContext || fetchedContext || contextLoading) return;
    const cid = live.contribution.id;
    const mid = meetingIdForContext || live.contribution.meeting_id;
    if (!cid || !mid) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    setContextLoading(true);
    setContextError(null);
    fetch(`/api/contribution_context?meeting=${mid}&contribution_id=${cid}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data.prompt_context ?? data;
      })
      .then((ctx) => {
        if (!cancelled) {
          if (ctx && typeof ctx === "object" && Object.keys(ctx).length > 0) {
            setFetchedContext(ctx);
          } else {
            setContextError("No prompt context captured for this contribution.");
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setContextError(err.name === "AbortError" ? "Context request timed out." : (err.message || "Failed to load context"));
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!cancelled) setContextLoading(false);
      });
    return () => { cancelled = true; controller.abort(); clearTimeout(timeout); };
  }, [activeTab, dialogContribution, fetchedContext, contextLoading, meetingIdForContext]);

  useEffect(() => {
    if (!dialogContribution) {
      setFetchedContext(null);
      setContextError(null);
      setContextLoading(false);
    }
  }, [dialogContribution]);

  const handleOrchestratorDialogOpen = useCallback((data) => {
    setDialogOrchestratorGroup(data.orchestratorGroup);
    setOrchestratorActiveTab("prompt");
  }, []);

  // Extracted pure function — see src/dashboard/utils/timeline.js
  const flatItems = useMemo(() => buildFlatItems(groupedContributions, {
    collapsedRounds, activeRound, agentErrors, turnRequests, extensions, maxRounds, isWeaving,
    thinkingParticipants, reflectingParticipants, queryingParticipants, evidenceParticipants, summoningParticipants,
    participantName, orchestratorMessages, roundSummaries
  }), [groupedContributions, collapsedRounds, activeRound, agentErrors, turnRequests, extensions, maxRounds, isWeaving, thinkingParticipants, reflectingParticipants, queryingParticipants, evidenceParticipants, summoningParticipants, participantName, orchestratorMessages, roundSummaries]);

  // Wire poll error handler to setPollError (exposed via aria-live)
  const [pollError, setPollError] = useState(null);
  useEffect(() => {
    const handler = (e) => setPollError(e.detail?.message ?? String(e.detail ?? "poll error"));
    window.addEventListener("loom-sse-error", handler);
    return () => window.removeEventListener("loom-sse-error", handler);
  }, []);


  const rowHeightFn = useCallback((index, cellProps) => {
    const item = cellProps.items[index];
    return item ? getRowHeight(item) : CONTRIBUTION_HEIGHT;
  }, []);

  const [viewportHeight, setViewportHeight] = useState(typeof window !== "undefined" ? window.innerHeight : 800);
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const sumHeights = useMemo(() => flatItems.reduce((sum, item) => sum + getRowHeight(item), 0), [flatItems]);
  const listHeight = useMemo(() => {
    return Math.max(400, Math.min(viewportHeight - 300, sumHeights));
  }, [sumHeights, viewportHeight]);

  const rowProps = useMemo(() => ({
    items: flatItems,
    onToggleCollapse,
    participantName,
    onDialogOpen: handleDialogOpen,
    onOrchestratorDialogOpen: handleOrchestratorDialogOpen,
    contributions,
  }), [flatItems, onToggleCollapse, participantName, contributions, handleDialogOpen, handleOrchestratorDialogOpen]);

  return (
    <div className="pt-4">
      {pollError && (
        <Alert variant="destructive" className="mb-3" role="alert" aria-live="polite">
          <TriangleAlertIcon />
          <AlertTitle>Poll error</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-2">
            <span className="text-xs">{pollError}</span>
            <Button variant="ghost" size="sm" onClick={() => setPollError(null)} aria-label="Dismiss poll error">Dismiss</Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{isWeaving ? `Live — round ${activeRound} weaving` : `Round ${activeRound} complete`}</div>
      {groupedContributions.length === 0 && contributions.length === 0 && !isWeaving && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><MessageSquareIcon /></EmptyMedia>
            <EmptyTitle>Waiting for agents to respond...</EmptyTitle>
            <EmptyDescription>Contributions will appear here in real-time</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {flatItems.length > 0 && (
        <div aria-live="polite">
          <List
            listRef={listRef}
            rowCount={flatItems.length}
            rowHeight={rowHeightFn}
            rowComponent={TimelineRow}
            rowProps={rowProps}
            overscanCount={8}
            style={{ height: listHeight, width: "100%" }}
          />
        </div>
      )}
            <ContentDialog
        open={dialogContribution !== null}
        onClose={() => setDialogContribution(null)}
        title={liveDialogContribution ? (liveDialogContribution.isReflection
          ? `Reflection by ${liveDialogContribution.participantName}`
          : liveDialogContribution.isQueryResponse
          ? `Query response by ${liveDialogContribution.participantName}`
          : liveDialogContribution.isEvidenceResponse
          ? `Evidence response by ${liveDialogContribution.participantName}`
          : liveDialogContribution.isSummonedResponse
          ? `Summoned expert: ${liveDialogContribution.personaName}`
          : liveDialogContribution.isVoteResponse
          ? `Vote by ${liveDialogContribution.participantName}`
          : `${liveDialogContribution.participantName} — ${liveDialogContribution.contribution.type}`) : ""}
        className={liveDialogContribution ? (liveDialogContribution.isReflection
          ? "border-l-4 border-l-[var(--badge-indigo)]"
          : liveDialogContribution.isQueryResponse
          ? "border-l-4 border-l-[var(--badge-teal)]"
          : liveDialogContribution.isEvidenceResponse
          ? "border-l-4 border-l-[var(--badge-sky)]"
          : liveDialogContribution.isSummonedResponse
          ? "border-l-4 border-l-[var(--badge-violet)]"
          : liveDialogContribution.isVoteResponse
          ? "border-l-4 border-l-[var(--badge-emerald)]"
          : "border-l-4 border-l-primary") : ""}
      >
        {(liveDialogContribution ?? dialogContribution) && (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList variant="line" className="w-full justify-start">
              <TabsTrigger value="response">Response</TabsTrigger>
              <TabsTrigger value="tools">Tool use{liveToolCalls.length > 0 ? ` (${liveToolCalls.length})` : ""}</TabsTrigger>
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="context">Context</TabsTrigger>
              <TabsTrigger value="errors">Errors</TabsTrigger>
            </TabsList>
            <TabsContent value="response" className="pt-4">
              <div className="typeset typeset-docs max-w-none w-full">
                <div dangerouslySetInnerHTML={{ __html: renderMarkdown((liveDialogContribution ?? dialogContribution).contribution.content ?? "") }} />
              </div>
              <div className="flex justify-end pt-3 mt-3 border-t">
                <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText((liveDialogContribution ?? dialogContribution).contribution.content ?? ""); }}>
                  <CopyIcon className="size-3.5 mr-1" /> Copy text
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="tools" className="pt-4">
              <div className="flex flex-col gap-2">
                {liveToolCalls.length > 0 ? (
                  liveToolCalls.map((tc, i) => {
                    const attempted = !!tc.attempted_tool;
                    const failed = !!tc.error || tc.status === "error";
                    const hasInput = tc.input != null && String(tc.input).length > 0;
                    const hasOutput = tc.output != null && String(tc.output).length > 0;
                    return (
                      <Card key={tc.callID ?? i} className="py-2">
                        <CardContent className="py-0 flex flex-col gap-1.5">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-semibold">{attempted && tc.attempted_tool !== tc.tool ? `attempted ${tc.attempted_tool}` : (tc.tool ?? "unknown")}</span>
                            {tc.title && <span className="text-xs text-muted-foreground truncate">{tc.title}</span>}
                            <Badge variant={failed ? "destructive" : "secondary"} className="ml-auto text-[10px]">{failed ? "error" : (tc.status ?? "ok")}</Badge>
                          </div>
                          {hasInput && <div><div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Input</div><pre className="text-xs bg-muted p-2 rounded whitespace-pre-wrap break-words">{prettyJson(tc.input)}</pre></div>}
                          {hasOutput && <div><div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Output</div><pre className="text-xs bg-muted p-2 rounded whitespace-pre-wrap break-words">{prettyJson(tc.output)}</pre></div>}
                          {tc.error && <div><div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Error</div><pre className="text-xs bg-destructive/10 text-destructive p-2 rounded whitespace-pre-wrap break-words">{prettyJson(tc.error)}</pre></div>}
                          {!hasInput && !hasOutput && !tc.error && <p className="text-xs text-muted-foreground italic">No input/output recorded for this call.</p>}
                        </CardContent>
                      </Card>
                    );
                  })
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">No tool call data recorded.</p>
                )}
              </div>
            </TabsContent>
            <TabsContent value="details" className="pt-4">
              <Table>
                <TableBody>
                  <TableRow><TableCell className="font-medium w-32">Type</TableCell><TableCell><Badge variant={(liveDialogContribution ?? dialogContribution).contribution.type ?? "secondary"}>{(liveDialogContribution ?? dialogContribution).contribution.type}</Badge></TableCell></TableRow>
                  <TableRow><TableCell className="font-medium">Round</TableCell><TableCell>{(liveDialogContribution ?? dialogContribution).contribution.round}</TableCell></TableRow>
                  <TableRow><TableCell className="font-medium">Participant</TableCell><TableCell>{(liveDialogContribution ?? dialogContribution).participantName}</TableCell></TableRow>
                  <TableRow><TableCell className="font-medium">Timestamp</TableCell><TableCell>{relativeTime((liveDialogContribution ?? dialogContribution).contribution.created_at)}</TableCell></TableRow>
                  <TableRow><TableCell className="font-medium">Word count</TableCell><TableCell>{((liveDialogContribution ?? dialogContribution).contribution.content ?? "").split(/\s+/).filter(Boolean).length}</TableCell></TableRow>
                  <TableRow><TableCell className="font-medium">Contribution ID</TableCell><TableCell className="font-mono">#{(liveDialogContribution ?? dialogContribution).contribution.id}</TableCell></TableRow>
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="context" className="pt-4">
              {(() => {
                const _live = liveDialogContribution ?? dialogContribution;
                const pc = _live.contribution.prompt_context;
                const hasFull = pc && (pc.system_prompt || pc.user_prompt || pc.state_of_play);
                const ctx = hasFull ? pc : (fetchedContext ?? pc);
                if (contextLoading) return <div className="flex items-center justify-center py-8"><Spinner /> <span className="ml-2 text-sm text-muted-foreground">Loading prompt context...</span></div>;
                if (contextError) return <p className="text-sm text-muted-foreground text-center py-4">{contextError}</p>;
                if (!ctx) return <p className="text-sm text-muted-foreground text-center py-4">No prompt context captured for this contribution.</p>;
                return (
                  <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto pr-2">
                    {ctx.system_prompt && <div><h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">System Prompt</h4><pre className="text-xs bg-muted p-3 rounded whitespace-pre-wrap break-words font-mono max-h-[40vh] overflow-auto">{ctx.system_prompt}</pre></div>}
                    {ctx.state_of_play && <div><h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">State of Play</h4><div className="text-xs bg-muted p-3 rounded whitespace-pre-wrap break-words max-h-[40vh] overflow-auto">{ctx.state_of_play}</div></div>}
                    {ctx.user_prompt && <div><h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">Full User Prompt</h4><pre className="text-xs bg-muted p-3 rounded whitespace-pre-wrap break-words font-mono max-h-[40vh] overflow-auto">{ctx.user_prompt}</pre></div>}
                  </div>
                );
              })()}
            </TabsContent>
            <TabsContent value="errors" className="pt-4">
              {(() => {
                const toolCalls = liveToolCalls;
                const errors = toolCalls.filter(tc => tc.status === "error" || tc.error);
                if (errors.length === 0) return <p className="text-sm text-muted-foreground text-center py-4">No errors recorded for this contribution.</p>;
                return (
                  <div className="flex flex-col gap-2">
                    {errors.map((tc, i) => (
                      <Card key={tc.callID ?? i} className="py-2 border-destructive/50">
                        <CardContent className="py-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-mono text-xs font-semibold">{tc.attempted_tool ? `attempted ${tc.attempted_tool}` : (tc.tool ?? "unknown")}</span>
                            <Badge variant="destructive" className="ml-auto text-[10px]">error</Badge>
                          </div>
                          {tc.error && <pre className="text-xs bg-destructive/10 p-2 rounded whitespace-pre-wrap break-words">{prettyJson(tc.error)}</pre>}
                          {tc.input && <pre className="text-xs bg-muted p-2 rounded whitespace-pre-wrap break-words mt-1">{prettyJson(tc.input)}</pre>}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                );
              })()}
            </TabsContent>
          </Tabs>
        )}
      </ContentDialog>
      <ContentDialog
        open={dialogOrchestratorGroup !== null}
        onClose={() => setDialogOrchestratorGroup(null)}
        title={(() => {
          if (!dialogOrchestratorGroup) return "";
          const meta = ORCHESTRATOR_TYPE_META[(dialogOrchestratorGroup.query ?? dialogOrchestratorGroup.response)?.type] || { label: "Orchestrator" };
          return meta.label;
        })()}
        className="border-l-4 border-l-muted-foreground/30"
      >
        {dialogOrchestratorGroup && (
          <Tabs value={orchestratorActiveTab} onValueChange={setOrchestratorActiveTab} className="w-full">
            <TabsList variant="line" className="w-full justify-start">
              <TabsTrigger value="prompt">Prompt</TabsTrigger>
              <TabsTrigger value="response">Response</TabsTrigger>
            </TabsList>
            <TabsContent value="prompt" className="pt-4">
              {dialogOrchestratorGroup.query ? (
                <>
                  <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-muted p-3 rounded max-h-[60vh] overflow-auto">{dialogOrchestratorGroup.query.content}</pre>
                  <div className="flex justify-end pt-3 mt-3 border-t">
                    <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(dialogOrchestratorGroup.query?.content ?? "")}><CopyIcon className="size-3.5 mr-1" /> Copy text</Button>
                  </div>
                </>
              ) : <p className="text-sm text-muted-foreground">No prompt recorded for this exchange.</p>}
            </TabsContent>
            <TabsContent value="response" className="pt-4">
              {dialogOrchestratorGroup.response ? (
                <>
                  <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-muted p-3 rounded max-h-[60vh] overflow-auto">{dialogOrchestratorGroup.response.content}</pre>
                  <div className="flex justify-end pt-3 mt-3 border-t">
                    <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(dialogOrchestratorGroup.response?.content ?? "")}><CopyIcon className="size-3.5 mr-1" /> Copy text</Button>
                  </div>
                </>
              ) : <p className="text-sm text-muted-foreground">No response recorded for this exchange.</p>}
            </TabsContent>
          </Tabs>
        )}
      </ContentDialog>
    </div>
  );
}

const TimelineTab = memo(TimelineTabBase);
export { TimelineTab };