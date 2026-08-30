import { useMemo, memo } from "react";
import { cn } from "../utils.js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { TierBadge, TypeBadge } from "./Badges.jsx";
import { Card, CardContent, CardHeader } from "./ui/card.tsx";
import { Badge } from "./ui/badge.tsx";
import { Avatar, AvatarFallback } from "./ui/avatar.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { ScrollArea } from "./ui/scroll-area.tsx";
import { ChevronRightIcon } from "lucide-react";

marked.setOptions({ breaks: true, gfm: true });

const MD_CACHE_MAX = 150;
const mdCache = new Map();

export function renderMarkdown(content) {
  if (!content) return "";
  const cached = mdCache.get(content);
  if (cached !== undefined) return cached;
  const raw = marked.parse(content, { async: false });
  const sanitized = DOMPurify.sanitize(raw, { FORBID_TAGS: ["svg", "math", "style", "script", "iframe", "object", "embed", "form", "input", "link", "img", "meta", "video", "base", "audio", "template"], FORBID_ATTR: ["style"] });
  mdCache.set(content, sanitized);
  while (mdCache.size > MD_CACHE_MAX) {
    const firstKey = mdCache.keys().next().value;
    mdCache.delete(firstKey);
  }
  return sanitized;
}

// Shared invoker resolution — deduped from 4× query/evidence/summon/vote rows
function isValidInvoker(id) {
  return id && id !== "caller" && id !== "Caller" && id !== "unknown" && id !== "Unknown";
}

function resolveInvokerName({ invokerId, source, response, contributions, participantName }) {
  if (isValidInvoker(invokerId)) return participantName(invokerId);
  if (source) return participantName(source.participant_id);
  const pcId = response.prompt_context?.source_participant_id ?? response.prompt_context?.sourceParticipantId ?? response.prompt_context?.source_participant_name;
  if (isValidInvoker(pcId)) {
    // pcId may be a name rather than id — try name lookup first
    if (response.prompt_context?.source_participant_name) {
      const byName = contributions?.find(c => participantName(c.participant_id) === pcId);
      if (byName) return participantName(byName.participant_id);
    }
    return participantName(pcId);
  }
  if (response.batch_id && contributions) {
    const batchContribs = contributions.filter(c => c.batch_id === response.batch_id);
    const excluded = new Set(["query_response","perspective_response","critique_response","evidence_response","vote_response","summoned_response","vote_tally","reflection"]);
    const invoker = batchContribs.find(c => c.id !== response.id && !excluded.has(c.type));
    if (invoker) return participantName(invoker.participant_id);
    const anyOther = batchContribs.find(c => c.id !== response.id && c.participant_id !== response.participant_id);
    if (anyOther) return participantName(anyOther.participant_id);
  }
  return "another agent";
}

const BORDER_COLOR_MAP = {
  propose: "border-l-[var(--badge-green-dark)]",
  challenge: "border-l-[var(--badge-red)]",
  refine: "border-l-[var(--badge-blue-deep)]",
  support: "border-l-[var(--badge-teal-dark)]",
  dissent: "border-l-[var(--badge-brown)]",
  synthesize: "border-l-[var(--badge-purple)]",
  question: "border-l-[var(--badge-cyan)]",
};

export const ContentDialog = memo(({ open, onClose, title, className, children }) => {
  return (
    <Dialog open={!!open} onOpenChange={(v) => { if (!v) onClose?.(); }}>
      <DialogContent className={cn("w-[calc(100%-2rem)] sm:w-[50vw] sm:max-w-[50vw] max-h-[85vh] min-h-[30vh] flex flex-col p-0 gap-0", className)}>
        {title ? (
          <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{title}</DialogDescription>
          </DialogHeader>
        ) : null}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 py-4">{children}</div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
});

export const ParticipantCard = memo(({ participant, error, contributionsByRound, isReflecting, onSelect }) => {
  const initials = participant.name?.slice(0, 2).toUpperCase() ?? "?";
  const statusColor = error ? "bg-destructive" : (participant.status === "speaking" || isReflecting) ? "bg-amber-500 animate-pulse" : participant.status === "passed" ? "bg-muted-foreground/50" : "bg-transparent";
  const hasErrorBorder = !!error;
  return (
    <Card
      className={cn("cursor-pointer transition-colors hover:bg-accent hover:border-ring py-3 px-3 gap-2", hasErrorBorder && "border-destructive")}
      onClick={() => onSelect?.(participant)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(participant); } }}
    >
      <div className="flex items-center gap-2">
        <Avatar className="size-7 shrink-0">
          <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
        </Avatar>
        <span className={cn("size-2 rounded-full shrink-0", statusColor)} />
        <span className="text-xs font-medium truncate flex-1">{participant.name}</span>
        <TierBadge tier={participant.tier} />
      </div>
      {participant.model_id && (
        <span className="text-[11px] text-muted-foreground truncate block">{participant.model_id}</span>
      )}
      {error && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-[11px] text-destructive truncate block">{error.error_type}</span>
          </TooltipTrigger>
          <TooltipContent>{error.error_message}</TooltipContent>
        </Tooltip>
      )}
    </Card>
  );
});

export const ThinkingCard = memo(({ participant }) => (
  <Card className="border-dashed opacity-70 py-3">
    <CardContent className="flex items-center gap-3 py-0">
      <Spinner className="size-4" />
      <span className="text-sm text-muted-foreground">
        {participant.name} ({participant.tier}) is thinking...
      </span>
    </CardContent>
  </Card>
));

export const ContributionItem = memo(({ contribution, participantName, onDialogOpen }) => {
  const content = contribution.content ?? "";
  const html = useMemo(() => renderMarkdown(content), [content]);
  const isLong = content.length > 300;

  const openDialog = () => onDialogOpen?.({ contribution, participantName });
  const onKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDialog();
    }
  };

  const loomCalls = useMemo(() => {
    const tcs = contribution.tool_calls ?? [];
    return tcs.filter(tc => (tc.tool ?? tc.attempted_tool ?? "").startsWith("loom_"));
  }, [contribution.tool_calls]);

  const formatLoomInput = (tc) => {
    try {
      const input = typeof tc.input === "string" ? JSON.parse(tc.input) : tc.input;
      if (tc.tool === "loom_query" || tc.tool === "loom_evidence") {
        const t = Array.isArray(input.targets) ? input.targets.join(", ") : "";
        const q = input.question ?? "";
        return `${t}: ${q.slice(0,80)}`;
      }
      if (tc.tool === "loom_vote") return (input.question ?? "").slice(0,80);
      if (tc.tool === "loom_summon") return `${input.persona_name ?? input.personaName ?? ""}: ${(input.issue ?? "").slice(0,60)}`;
      if (tc.tool === "loom_request_next") return `P${input.priority} ${input.reason ?? ""}`.slice(0,80);
      if (input && typeof input === "object") return JSON.stringify(input).slice(0,80);
      return String(input).slice(0,80);
    } catch { return tc.input ? String(tc.input).slice(0,80) : ""; }
  };

  const borderClass = BORDER_COLOR_MAP[contribution.type] ?? "border-l-transparent";

  return (
    <Card
      role="button"
      tabIndex={0}
      className={cn("py-2 px-3 gap-2 border-l-[3px] cursor-pointer hover:bg-accent/50", borderClass)}
      onClick={openDialog}
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-sm font-bold">
          {participantName}
        </span>
        <span className="ml-auto">
          <TypeBadge type={contribution.type} />
        </span>
      </div>
      {loomCalls.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {loomCalls.map((tc, i) => {
            const isError = !!tc.error || tc.status === "error";
            return (
              <Tooltip key={tc.callID ?? i}>
                <TooltipTrigger asChild>
                  <Badge variant={isError ? "aborted" : "orchestrator"} className="cursor-help">
                    {tc.tool.replace("loom_", "")}: {formatLoomInput(tc)}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs break-words">{tc.tool}: {formatLoomInput(tc)}{tc.error ? ` — ${tc.error}` : ""}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      )}
      {isLong ? (
        <p className="text-sm text-muted-foreground line-clamp-3">{content.slice(0, 300)}...</p>
      ) : (
        <div className="typeset typeset-docs max-w-none w-full">
          <div dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      )}
    </Card>
  );
});

export const TurnRequestItem = memo(({ turnRequest, participantName }) => {
  const target = turnRequest.target_participant_id ?? turnRequest.target;
  return (
    <Card className="border-dashed bg-card/50 py-3">
      <div className="flex flex-wrap gap-2 items-center mb-1">
        <span className="text-sm font-semibold">{participantName}</span>
        <Badge variant="turn_request">turn request</Badge>
        <span className="text-xs text-muted-foreground">priority {turnRequest.priority}</span>
        {target && (
          <span className="text-xs text-muted-foreground">→ {target}</span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{turnRequest.reason}</p>
    </Card>
  );
});

export const ReflectionInline = memo(({ reflection, contributions, participantName }) => {
  const trigger = useMemo(() => {
    if (!reflection.targets_which) return null;
    return contributions.find((c) => c.id === reflection.targets_which);
  }, [reflection.targets_which, contributions]);

  const triggerType = trigger?.type?.toUpperCase() ?? "CONTRIBUTION";
  const triggerAgentName = trigger ? participantName(trigger.participant_id) : "another agent";

  const content = reflection.content ?? "";
  const stripped = useMemo(() => {
    return content.replace(/^\[Reflection on #\d+ \[[\w]+\] by .+?\]\s*/m, "");
  }, [content]);
  const html = useMemo(() => renderMarkdown(stripped), [stripped]);

  return (
    <div className="border-l-2 border-[var(--badge-indigo)] pl-3 mt-2">
      <span className="text-xs italic text-muted-foreground block mb-1">
        ↳ Reflection on {triggerAgentName}'s {triggerType}
      </span>
      <div className="typeset typeset-docs max-w-none w-full">
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
});

export const BaseResponseRow = memo(({ contribution, header, badgeLabel, badgeVariant, strippedRegex, borderClass, onDialogOpen, dialogPayload }) => {
  const openDialog = () => onDialogOpen?.({ contribution, ...dialogPayload });
  return (
    <Card
      className={cn("py-2.5 px-3 gap-0 border-l-2 cursor-pointer hover:bg-accent/50 flex flex-col justify-center mb-[3px]", borderClass)}
      onClick={openDialog}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDialog(); } }}
    >
      <div className="flex flex-wrap gap-2 items-center w-full">
        <span className="text-xs leading-none flex-1 min-w-0 truncate">{header}</span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <Badge variant={badgeVariant} className="text-[10px] px-1.5 py-0 h-4">{badgeLabel}</Badge>
          <ChevronRightIcon className="size-3 text-muted-foreground/60" />
        </span>
      </div>
    </Card>
  );
});

export const ReflectionRow = memo(({ reflection, contributions, participantName, onDialogOpen }) => {
  const trigger = useMemo(() => !reflection.targets_which ? null : contributions.find((c) => c.id === reflection.targets_which), [reflection.targets_which, contributions]);
  const triggerType = trigger?.type?.toUpperCase() ?? "CONTRIBUTION";
  const triggerAgentName = trigger ? participantName(trigger.participant_id) : "another agent";
  const reflectionAgentName = participantName(reflection.participant_id);
  const header = <><span className="font-bold">{reflectionAgentName}</span> <span className="text-muted-foreground">reflected on</span> <span className="font-bold">{triggerAgentName}</span><span className="text-muted-foreground">'s {triggerType} #{reflection.targets_which}</span></>;
  return <BaseResponseRow contribution={reflection} header={header} badgeLabel="reflection" badgeVariant="reflection" strippedRegex={/^\[Reflection on #\d+ \[[\w]+\] by .+?\]\s*/m} borderClass="border-l-[var(--badge-indigo)] bg-[color-mix(in_oklch,var(--badge-indigo)_4%,var(--card))]" onDialogOpen={onDialogOpen} dialogPayload={{ participantName: reflectionAgentName, isReflection: true, triggerAgentName, triggerType }} />;
});

export const QueryResponseRow = memo(({ queryResponse, contributions, participantName, onDialogOpen, invokerId }) => {
  const source = useMemo(() => !queryResponse.targets_which ? null : contributions.find((c) => c.id === queryResponse.targets_which), [queryResponse.targets_which, contributions]);
  const sourceAgentName = useMemo(() => resolveInvokerName({ invokerId, source, response: queryResponse, contributions, participantName }), [invokerId, source, queryResponse, contributions, participantName]);
  const responderName = participantName(queryResponse.participant_id);
  const header = <><span className="font-bold">{responderName}</span> <span className="text-muted-foreground">responded to query from</span> <span className="font-bold">{sourceAgentName}</span></>;
  return <BaseResponseRow contribution={queryResponse} header={header} badgeLabel="query response" badgeVariant="query_response" strippedRegex={/^\[Response to query from .+?\]\s*/m} borderClass="border-l-[var(--badge-teal)] bg-[color-mix(in_oklch,var(--badge-teal)_4%,var(--card))]" onDialogOpen={onDialogOpen} dialogPayload={{ participantName: responderName, isQueryResponse: true, sourceAgentName }} />;
});

export const EvidenceResponseRow = memo(({ evidenceResponse, contributions, participantName, onDialogOpen, invokerId }) => {
  const source = useMemo(() => !evidenceResponse.targets_which ? null : contributions.find((c) => c.id === evidenceResponse.targets_which), [evidenceResponse.targets_which, contributions]);
  const sourceAgentName = useMemo(() => resolveInvokerName({ invokerId, source, response: evidenceResponse, contributions, participantName }), [invokerId, source, evidenceResponse, contributions, participantName]);
  const sourceType = source?.type?.toUpperCase() ?? "CONTRIBUTION";
  const responderName = participantName(evidenceResponse.participant_id);
  const header = <><span className="font-bold">{responderName}</span> <span className="text-muted-foreground">providing evidence on</span> <span className="font-bold">{sourceAgentName}</span><span className="text-muted-foreground">'s {sourceType}</span></>;
  return <BaseResponseRow contribution={evidenceResponse} header={header} badgeLabel="evidence" badgeVariant="evidence_response" strippedRegex={/^\[Evidence from .+? on .+?\]\s*/m} borderClass="border-l-[var(--badge-sky)] bg-[color-mix(in_oklch,var(--badge-sky)_4%,var(--card))]" onDialogOpen={onDialogOpen} dialogPayload={{ participantName: responderName, isEvidenceResponse: true, sourceAgentName, sourceType }} />;
});

export const SummonedResponseRow = memo(({ summonedResponse, contributions, participantName, onDialogOpen, invokerId }) => {
  const content = summonedResponse.content ?? "";
  const personaInfo = useMemo(() => {
    const match = content.match(/^\[Summoned: (.+?) \((.+?)\)\]/m);
    return match ? { name: match[1], tier: match[2] } : { name: "Guest Expert", tier: "unknown" };
  }, [content]);
  const invokerName = useMemo(() => {
    const n = resolveInvokerName({ invokerId, source: null, response: summonedResponse, contributions, participantName });
    return n === "another agent" ? null : n;
  }, [invokerId, summonedResponse, contributions, participantName]);
  const header = <><span className="font-bold">Guest expert {personaInfo.name}</span> <span className="text-muted-foreground">({personaInfo.tier}){invokerName ? " summoned by " : ""}</span>{invokerName && <span className="font-bold">{invokerName}</span>}</>;
  return <BaseResponseRow contribution={summonedResponse} header={header} badgeLabel="summoned" badgeVariant="summoned_response" strippedRegex={/^\[Summoned: .+?\]\s*/m} borderClass="border-l-[var(--badge-violet)] bg-[color-mix(in_oklch,var(--badge-violet)_4%,var(--card))]" onDialogOpen={onDialogOpen} dialogPayload={{ participantName: personaInfo.name, isSummonedResponse: true, personaName: personaInfo.name, personaTier: personaInfo.tier }} />;
});

export const VoteResponseRow = memo(({ voteResponse, contributions, participantName, onDialogOpen, invokerId }) => {
  const source = useMemo(() => !voteResponse.targets_which ? null : contributions.find((c) => c.id === voteResponse.targets_which), [voteResponse.targets_which, contributions]);
  const sourceAgentName = useMemo(() => resolveInvokerName({ invokerId, source, response: voteResponse, contributions, participantName }), [invokerId, source, voteResponse, contributions, participantName]);
  const voterName = participantName(voteResponse.participant_id);
  const header = <><span className="font-bold">{voterName}</span> <span className="text-muted-foreground">voted on poll from</span> <span className="font-bold">{sourceAgentName}</span></>;
  return <BaseResponseRow contribution={voteResponse} header={header} badgeLabel="vote" badgeVariant="vote_response" strippedRegex={/^\[Vote from .+?\]\s*/m} borderClass="border-l-[var(--badge-emerald)] bg-[color-mix(in_oklch,var(--badge-emerald)_4%,var(--card))]" onDialogOpen={onDialogOpen} dialogPayload={{ participantName: voterName, isVoteResponse: true, sourceAgentName }} />;
});

export const VoteTallyRow = memo(({ tally, participantName, onDialogOpen }) => {
  const orchestratorName = participantName(tally.participant_id);
  const openDialog = () => onDialogOpen?.({ contribution: tally, participantName: orchestratorName, isVoteTally: true });
  return (
    <Card
      className={cn("py-2.5 px-3 gap-0 border-l-2 border-l-[var(--badge-orange-light)] bg-[color-mix(in_oklch,var(--badge-orange-light)_4%,var(--card))] cursor-pointer hover:bg-accent/50 flex flex-col justify-center mb-[3px]")}
      onClick={openDialog}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDialog(); } }}
    >
      <div className="flex flex-wrap gap-2 items-center w-full">
        <span className="text-xs leading-none flex-1 min-w-0 truncate"><span className="font-bold">{orchestratorName}</span> <span className="text-muted-foreground">tally</span></span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">tally</Badge>
          <ChevronRightIcon className="size-3 text-muted-foreground/60" />
        </span>
      </div>
    </Card>
  );
});

export const AgentPerspective = memo(({ participant, stateOfPlay, recentContributions, reflection }) => {
  return (
    <Card className="border-l-2 border-l-muted py-3 gap-2">
      <CardHeader className="flex flex-row items-center justify-between py-0">
        <span className="text-sm font-semibold">{participant.name}</span>
        <TierBadge tier={participant.tier} />
      </CardHeader>
      <CardContent className="flex flex-col gap-3 py-0">
        {participant.persona && (
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Persona</span>
            <div className="text-xs text-muted-foreground bg-muted rounded-md px-2 py-1.5 whitespace-pre-wrap break-words">
              {participant.persona.length > 300 ? participant.persona.slice(0, 300) + "..." : participant.persona}
            </div>
          </div>
        )}
        {participant.agenda && (
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Agenda</span>
            <div className="text-xs text-muted-foreground bg-muted rounded-md px-2 py-1.5 whitespace-pre-wrap break-words">
              {participant.agenda.length > 300 ? participant.agenda.slice(0, 300) + "..." : participant.agenda}
            </div>
          </div>
        )}
        {stateOfPlay && (
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">State of Play</span>
            <div className="text-xs text-muted-foreground bg-muted rounded-md px-2 py-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-words">
              {stateOfPlay}
            </div>
          </div>
        )}
        {recentContributions && recentContributions.length > 0 && (
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Recent Contributions</span>
            <div className="text-xs text-muted-foreground bg-muted rounded-md px-2 py-1.5 max-h-24 overflow-y-auto">
              {recentContributions.map((c) => (
                <div key={c.id} className="flex gap-1.5 items-baseline py-0.5 border-b border-border last:border-0">
                  <span className="font-mono text-muted-foreground">#{c.id}</span>
                  <Badge variant="secondary" className="text-[10px] h-4 px-1">{c.type}</Badge>
                  <span className="truncate">{c.content.length > 200 ? c.content.slice(0, 200) + "..." : c.content}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {reflection && (
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Reflection</span>
            <div className="text-xs text-muted-foreground bg-muted rounded-md px-2 py-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-words">
              {reflection}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
});

export const ORCHESTRATOR_TYPE_META = {
  turn_order: { emoji: "🔄", label: "Turn Planning" },
  summary: { emoji: "📝", label: "Round Summary" },
  moderation: { emoji: "🛡️", label: "Moderation" },
  convergence: { emoji: "🎯", label: "Convergence Check" },
  orchestrator: { emoji: "🎛️", label: "Orchestrator" },
};

export const OrchestratorItem = memo(({ group, onDialogOpen }) => {
  const msg = group.query ?? group.response;
  const meta = ORCHESTRATOR_TYPE_META[msg.type] || { emoji: "❓", label: msg.type };
  const content = msg.content ?? "";
  const openDialog = () => onDialogOpen?.({ orchestratorGroup: group, type: msg.type });
  return (
    <Card
      role="button"
      tabIndex={0}
      className="border-dashed border-l-[3px] border-l-muted-foreground/30 cursor-pointer hover:bg-accent py-3"
      onClick={openDialog}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDialog(); } }}
    >
      <div className="flex flex-wrap gap-2 items-center mb-1 px-3">
        <span className="text-sm font-semibold">Orchestrator</span>
        <Badge variant="orchestrator" className="ml-auto">{meta.label}</Badge>
      </div>
      <p className="text-sm text-muted-foreground px-3">{content.slice(0, 150)}{content.length > 150 ? "..." : ""}</p>
    </Card>
  );
});

export const OrchestratorDetailDialog = memo(({ open, onClose, orchestratorMessages, highestTierModel }) => {
  const messages = orchestratorMessages ?? [];
  const stats = useMemo(() => {
    const counts = {};
    for (const m of messages) {
      const t = m.type ?? "orchestrator";
      counts[t] = (counts[t] ?? 0) + 1;
    }
    return counts;
  }, [messages]);
  return (
    <ContentDialog open={open} onClose={onClose} title="Orchestrator" className="border-l-4 border-l-muted-foreground/30">
      <div className="flex flex-col gap-3">
        <div>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Role</span>
          <p className="text-sm text-muted-foreground">
            Coordinates the deliberation flow — plans turn order, summarizes rounds, checks for convergence, and moderates conflicts.
          </p>
        </div>
        {highestTierModel && (
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Model</span>
            <p className="text-sm text-muted-foreground">{highestTierModel}</p>
          </div>
        )}
        {Object.keys(stats).length > 0 && (
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Activity</span>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {Object.entries(stats).map(([type, count]) => {
                const meta = ORCHESTRATOR_TYPE_META[type] || { emoji: "❓", label: type };
                return (
                  <Badge key={type} variant="orchestrator">
                    {meta.emoji} {meta.label}: {count}
                  </Badge>
                );
              })}
            </div>
          </div>
        )}
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">No orchestrator messages recorded yet.</p>
        )}
      </div>
    </ContentDialog>
  );
});
