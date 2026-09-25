import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { List } from "react-window";
import { useStore } from "@nanostores/react";
import { $setupForm, resetSetupForm, ORCHESTRATOR_BEHAVIOR_OPTIONS, ORCHESTRATOR_BEHAVIOR_LABELS } from "../stores/setupForm.js";
import { Button } from "./ui/button.tsx";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card.tsx";
import { Badge } from "./ui/badge.tsx";
import { Avatar } from "./Avatar.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Input } from "./ui/input.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { Label } from "./ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Switch } from "./ui/switch.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert.tsx";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./ui/collapsible.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { PersonaPickerDialog } from "./PersonaPickerDialog.jsx";
import { OrchestratorPreviewDialog } from "./OrchestratorPreviewDialog.jsx";
import { TIER_META, AVATAR_EXPRESSION, AVATAR_COLORS } from "./tierMeta.jsx";

function formatContext(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n >= 1000 ? `${Math.round(n / 1000)}k ctx` : `${n} ctx`;
}

function formatCost(cost) {
  if (!cost || (cost.input === 0 && cost.output === 0)) return "free";
  return `$${cost.input}/$${cost.output}`;
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Request failed (HTTP ${res.status})`);
  return data;
}

const MAX_SEATS = 7;

const MODEL_ROW_HEIGHT = 40;

function ModelRow({ index, style, ariaAttributes, items, disabled, onToggle }) {
  const m = items[index];
  if (!m) return null;
  const off = !m.enabled || m.unhealthy;
  return (
    <div style={style} {...ariaAttributes}>
      <div className="h-full pb-1">
        <label
          className={"flex h-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-xs hover:bg-muted/60 " + (off ? "opacity-60" : "")}
        >
          <Checkbox
            checked={!!m.enabled}
            disabled={disabled}
            onCheckedChange={(v) => onToggle(m.key, v === true)}
            aria-label={`${m.enabled ? "Disable" : "Enable"} ${m.key} for Loom agents`}
          />
          <span className="min-w-0 flex-1 truncate font-mono" title={m.key}>{m.key}</span>
          <span className="shrink-0 text-muted-foreground">{formatContext(m.context)}</span>
          {m.reasoning && <Badge variant="secondary" className="shrink-0 text-[10px]">reasoning</Badge>}
          <span className="shrink-0 text-muted-foreground">{formatCost(m.cost)}</span>
          {m.unhealthy && <Badge variant="outline" className="shrink-0 border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400" title="Failed repeatedly — excluded until re-enabled">unhealthy</Badge>}
        </label>
      </div>
    </div>
  );
}

function StepHeader({ steps }) {
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Setup progress">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden="true" className="text-muted-foreground">→</span>}
          <span
            className={
              "flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium " +
              (s.status === "done"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : s.status === "current"
                  ? "border-primary/50 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground")
            }
          >
            <span
              aria-hidden="true"
              className={
                "flex size-5 items-center justify-center rounded-full text-[11px] font-bold " +
                (s.status === "done" ? "bg-emerald-500 text-white" : s.status === "current" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")
              }
            >
              {s.status === "done" ? "✓" : i + 1}
            </span>
            {s.label}
            {s.detail && <span className="font-normal opacity-80">{s.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function FeatureModeControl({ value, onChange, disabled }) {
  return (
    <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Capability mode">
      {["disabled", "optional", "mandatory"].map((mode) => (
        <Button
          key={mode}
          type="button"
          size="sm"
          variant={value === mode ? "default" : "outline"}
          disabled={disabled}
          onClick={() => onChange(mode)}
          aria-pressed={value === mode}
          className="px-2 text-[11px] capitalize"
        >
          {mode}
        </Button>
      ))}
    </div>
  );
}

function getOrchestratorBehaviorOption(key, value) {
  const options = ORCHESTRATOR_BEHAVIOR_OPTIONS[key] ?? [];
  return options.find((option) => option.value === value) ?? options[0];
}

function getOrchestratorBehaviorDescription(key, value) {
  return getOrchestratorBehaviorOption(key, value)?.description;
}

export function SetupTab({ selectedMeeting, onStarted }) {
  // Draft form state lives in a persistent per-session nanostore, so tab
  // switches (which unmount this component) and page refreshes never lose it.
  // Transient UI (catalog, llm, busy, errors, dialogs, jobs) stays in useState.
  const form = useStore($setupForm);
  const { question, context, maxRounds, preview, seats, startedId, orchestrator, features } = form;
  const patchForm = (patch) => $setupForm.set({ ...$setupForm.get(), ...patch });
  const setQuestion = (v) => { patchForm({ question: v }); setPreview(null); setGuidance(null); };
  const setContext = (v) => { patchForm({ context: v }); setPreview(null); setGuidance(null); };
  const setMaxRounds = (v) => patchForm({ maxRounds: v });
  const setPreview = (v) => patchForm({ preview: v });
  const setStartedId = (v) => patchForm({ startedId: v });
  const setOrchestratorField = (key, value) => patchForm({ orchestrator: { ...orchestrator, [key]: value } });
  const setFeature = (key, value) => patchForm({ features: { ...features, [key]: value } });
  const setSeats = (updater) => {
    const cur = $setupForm.get();
    const next = typeof updater === "function" ? updater(cur.seats) : updater;
    if (next !== cur.seats) $setupForm.set({ ...cur, seats: next });
  };
  const clearForm = () => {
    if (window.confirm("Clear the setup form? This does not affect running deliberations.")) {
      resetSetupForm();
      setError(null);
      setGuidance(null);
    }
  };
  const [catalog, setCatalog] = useState(null);
  const [llm, setLlm] = useState(null);
  const [suggestedByTier, setSuggestedByTier] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [guidance, setGuidance] = useState(null);
  const [swapIdx, setSwapIdx] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [job, setJob] = useState(null);
  const [extendInput, setExtendInput] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const sectionRefs = useRef({});

  const scrollToSection = (key) => {
    sectionRefs.current[key]?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // Fill seats missing a model (or holding a now-disabled one) from the tier
  // suggestion, else the first enabled model. Returns the same array ref when
  // nothing changed so setSeats bails out without re-rendering.
  const fillSeatModels = (seatList, llmData, extraSuggested = null) => {
    const enabled = (llmData?.models ?? []).filter((m) => m.enabled && !m.unhealthy).map((m) => m.key);
    const enabledSet = new Set(enabled);
    const sugg = { ...(extraSuggested ?? {}) };
    for (const s of llmData?.suggested ?? []) {
      if (s.tier && s.provider_id && s.model_id && !sugg[s.tier]) {
        const key = `${s.provider_id}/${s.model_id}`;
        if (enabledSet.has(key)) sugg[s.tier] = key;
      }
    }
    const first = enabled[0] ?? null;
    let changed = false;
    const next = seatList.map((st) => {
      if (st.model && enabledSet.has(st.model)) return st;
      const d = (sugg[st.tier] && enabledSet.has(sugg[st.tier])) ? sugg[st.tier] : first;
      if ((d ?? null) === (st.model ?? null)) return st;
      changed = true;
      return { ...st, model: d };
    });
    return changed ? next : seatList;
  };

  const fillOrchestratorModel = useCallback((llmData) => {
    const enabled = (llmData?.models ?? []).filter((m) => m.enabled && !m.unhealthy).map((m) => m.key);
    if (enabled.length === 0) {
      if (orchestrator.model) setOrchestratorField("model", null);
      return;
    }
    const current = $setupForm.get().orchestrator?.model;
    if (current && enabled.includes(current)) return;
    const recommended = llmData?.suggested_orchestrator?.key;
    setOrchestratorField("model", recommended && enabled.includes(recommended) ? recommended : enabled[0]);
  }, [orchestrator.model]);

  const refreshLlm = useCallback(async (force = false) => {
    try {
      const res = await fetch(force ? "/api/llm-models?refresh=1" : "/api/llm-models");
      if (res.ok) {
        const data = await res.json();
        setLlm(data);
        fillOrchestratorModel(data);
        setSuggestedByTier((prev) => {
          const next = { ...prev };
          for (const s of data.suggested ?? []) {
            if (s.tier && !next[s.tier] && s.provider_id && s.model_id) {
              next[s.tier] = `${s.provider_id}/${s.model_id}`;
            }
          }
          return next;
        });
        setSeats((prev) => fillSeatModels(prev, data));
      }
    } catch {}
  }, [fillOrchestratorModel]);

  useEffect(() => { refreshLlm(); }, [refreshLlm]);

  // Backfill seat models once model data arrives after seats were composed
  // (e.g. auto-select ran before the provider list loaded).
  useEffect(() => {
    if (!llm) return;
    setSeats((prev) => fillSeatModels(prev, llm));
  }, [llm]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch("/api/jobs");
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setJob(data);
        }
      } catch {}
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const enabledKeys = useMemo(
    () => new Set((llm?.models ?? []).filter((m) => m.enabled && !m.unhealthy).map((m) => m.key)),
    [llm],
  );
  const defaultModelForTier = useCallback((tier) => {
    if (suggestedByTier[tier] && enabledKeys.has(suggestedByTier[tier])) return suggestedByTier[tier];
    for (const m of llm?.models ?? []) {
      if (m.enabled && !m.unhealthy) return m.key;
    }
    return null;
  }, [llm, suggestedByTier, enabledKeys]);

  const canAutoSelect = question.trim().length >= 3 && busy !== "preview" && enabledKeys.size > 0;

  const doPreview = async () => {
    if (!canAutoSelect) return;
    setError(null);
    setGuidance(null);
    setBusy("preview");
    try {
      const data = await postJSON("/api/room/preview", { question, context });
      setPreview(data);
      const extraSuggested = {};
      for (const s of data.suggested_models ?? []) {
        if (s.tier && s.provider_id && s.model_id) extraSuggested[s.tier] = `${s.provider_id}/${s.model_id}`;
      }
      setSuggestedByTier((prev) => ({ ...extraSuggested, ...prev }));
      const composed = (data.participants ?? []).map((p) => ({ ...p, approved: true, model: null }));
      setSeats(fillSeatModels(composed, llm, extraSuggested));
      if (!catalog) {
        try {
          const res = await fetch("/api/personas");
          if (res.ok) setCatalog(await res.json());
        } catch {}
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const ensureCatalog = async () => {
    if (catalog) return;
    try {
      const res = await fetch("/api/personas");
      if (res.ok) setCatalog(await res.json());
    } catch {}
  };

  const openAdd = async () => {
    setError(null);
    await ensureCatalog();
    setAddOpen(true);
  };

  const addSeat = (persona, tier) => {
    if (!persona || seats.some((s) => s.name === persona.name)) {
      setAddOpen(false);
      return;
    }
    if (seats.length >= MAX_SEATS) {
      setAddOpen(false);
      return;
    }
    setSeats((prev) => (prev.length >= MAX_SEATS ? prev : [...prev, { ...persona, tier, approved: true, model: defaultModelForTier(tier) }]));
    setAddOpen(false);
    setGuidance(null);
  };

  const removeSeat = (idx) => {
    setSeats((prev) => prev.filter((_, j) => j !== idx));
    setGuidance(null);
  };

  const selectSwap = (idx, persona, tier) => {
    setSeats((prev) => prev.map((s, i) => (i === idx ? { ...s, ...persona, tier, approved: true } : s)));
    setSwapIdx(null);
    setGuidance(null);
  };

  const toggleModel = useCallback(async (key, enabled) => {
    setError(null);
    setGuidance(null);
    setBusy("models");
    try {
      await postJSON("/api/llm-models/filter", { action: enabled ? "enable" : "disable", models: [key] });
      await refreshLlm();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }, [refreshLlm]);

  const openOrchestratorPreview = useCallback(async () => {
    setPreviewOpen(true);
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const current = $setupForm.get();
      setPreviewData(await postJSON("/api/orchestrator/preview", {
        orchestrator: current.orchestrator,
        question: current.question,
        context: current.context,
        participants: current.seats,
      }));
    } catch (err) {
      setPreviewError(err.message);
      setPreviewData(null);
    } finally {
      setPreviewBusy(false);
    }
  }, []);

  const modelRowKey = useCallback(
    (index, data) => data.items[index]?.key ?? index,
    [],
  );

  const enabledModels = useMemo(
    () => (llm?.models ?? []).filter((m) => m.enabled && !m.unhealthy),
    [llm],
  );
  const enabledCount = enabledModels.length;
  const totalCount = (llm?.models ?? []).length;

  const questionOk = question.trim().length >= 3;
  const roomOk = seats.length >= 2;
  const personasOk = roomOk;
  const filterOk = enabledKeys.size >= 1;
  const seatsMapped = !roomOk || seats.every((s) => s.model && enabledKeys.has(s.model));
  const modelsOk = filterOk && seatsMapped;
  const orchestratorOk = !!orchestrator.model && enabledKeys.has(orchestrator.model);
  const idleOk = !job?.running;
  // While a deliberation is weaving, the entire setup form freezes in its
  // current state — question, rounds, models, seats, and actions all lock.
  const isFrozen = !!job?.running;

  const requirements = useMemo(() => ([
    { key: "question", met: questionOk, label: "Enter a question" },
    { key: "models", met: modelsOk, label: !filterOk ? "Enable at least 1 model" : (!roomOk ? `Models ready (${enabledCount} enabled)` : seatsMapped ? `Models ready (${seats.length} seats mapped)` : "Pick a model for every seat") },
      { key: "personas", met: personasOk, label: roomOk ? `Personas selected (${seats.length} seats)` : "Add at least 2 persona seats (auto-select or manual)" },
      { key: "capabilities", met: true, label: "Persona capabilities configured" },
      { key: "orchestrator", met: orchestratorOk, label: orchestratorOk ? "Orchestrator ready" : "Choose an orchestrator model" },
     { key: "idle", met: idleOk, label: "No deliberation running" },
   ]), [questionOk, personasOk, roomOk, seats.length, modelsOk, orchestratorOk, filterOk, seatsMapped, enabledCount, idleOk]);

  const steps = useMemo(() => ([
      { key: "question", label: "Question", status: questionOk ? "done" : "current", detail: null },
      { key: "models", label: "Models", status: modelsOk ? "done" : questionOk ? "current" : "todo", detail: totalCount ? `${enabledCount}/${totalCount}` : null },
       { key: "personas", label: "Personas", status: personasOk ? "done" : filterOk ? "current" : "todo", detail: roomOk ? `${seats.length} seats` : null },
       { key: "capabilities", label: "Persona capabilities", status: personasOk ? "done" : "todo", detail: null },
       { key: "orchestrator", label: "Orchestrator", status: orchestratorOk ? "done" : personasOk ? "current" : "todo", detail: null },
       { key: "start", label: "Start", status: personasOk && modelsOk && orchestratorOk && idleOk ? "current" : "todo", detail: null },
   ]), [questionOk, personasOk, modelsOk, orchestratorOk, idleOk, filterOk, roomOk, seats.length, enabledCount, totalCount]);

  const canStart = requirements.every((r) => r.met) && busy !== "start";
  const budgetEstimate = useMemo(() => {
    const rounds = Math.max(1, Math.min(10, Number(maxRounds) || 4));
    const participants = Math.max(0, seats.length);
    const primaryCalls = participants * rounds;
    const interactionCalls = participants * rounds * 2;
    const orchestrationCalls = rounds * 2 + 2;
    return { calls: primaryCalls + interactionCalls + orchestrationCalls, rounds, participants };
  }, [maxRounds, seats.length]);

  const doStart = async () => {
    if (!canStart) return;
    setError(null);
    setGuidance(null);
    setBusy("start");
    try {
      const data = await postJSON("/api/meetings/start", {
        question: question.trim(),
        context: context.trim(),
         max_rounds: Number(maxRounds) || 4,
         participants: seats.map(({ model, ...p }) => {
           if (!model) return { ...p, approved: true };
          const [provider_id, ...rest] = model.split("/");
           return { ...p, approved: true, model: { provider_id, model_id: rest.join("/") } };
         }),
          orchestrator: { ...orchestrator, model: orchestrator.model },
          orchestrator_model: (() => {
            const [provider_id, ...rest] = (orchestrator.model ?? "").split("/");
            return { provider_id, model_id: rest.join("/") };
          })(),
          features,
         models: [],
         approved: true,
      });
       resetSetupForm();
       setStartedId(data.meeting_id);
       if (onStarted) onStarted(data.meeting_id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const doCancel = async (id) => {
    setError(null);
    try {
      await postJSON("/api/meetings/cancel", { meeting_id: id });
    } catch (err) {
      setError(err.message);
    }
  };

  const doExtend = async () => {
    if (!selectedMeeting || extendInput.trim().length < 3) return;
    setError(null);
    setBusy("extend");
    try {
      await postJSON("/api/meetings/extend", { meeting_id: selectedMeeting, question: extendInput.trim() });
      setExtendInput("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const degradedPreview = preview?.reasoning ? /embedding model unavailable/i.test(preview.reasoning) : false;

  return (
    <div className="flex flex-col gap-5 max-w-4xl pb-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <StepHeader steps={steps} />
        <Button variant="ghost" size="sm" onClick={clearForm} disabled={isFrozen} title={isFrozen ? "Locked while a deliberation is running" : "Reset the setup form to empty (running deliberations are unaffected)"}>
          Clear form
        </Button>
      </div>

      <div aria-live="polite">
        {job?.running && (
          <Alert className="border-amber-500/40 bg-amber-500/10">
            <AlertTitle>Deliberation running</AlertTitle>
            <AlertDescription className="flex items-center justify-between gap-2">
              <span>Meeting {String(job.running).slice(0, 8)}… is weaving. Starting is locked until it finishes.</span>
              <Button variant="outline" size="sm" onClick={() => doCancel(job.running)}>Cancel run</Button>
            </AlertDescription>
          </Alert>
        )}
        {startedId && (
          <Alert className="mt-3 border-emerald-500/40 bg-emerald-500/10">
            <AlertTitle>Deliberation started</AlertTitle>
            <AlertDescription>Follow it in the Timeline tab (meeting {startedId.slice(0, 8)}…).</AlertDescription>
          </Alert>
        )}
         {error && (
           <Alert variant="destructive" className="mt-3" role="alert">
             <AlertTitle>Something went wrong</AlertTitle>
             <AlertDescription>{error}</AlertDescription>
           </Alert>
         )}
         {job?.jobs && Object.values(job.jobs).some((entry) => entry?.phase === "error") && (
           <Alert variant="destructive" className="mt-3" role="alert">
             <AlertTitle>Background deliberation failed</AlertTitle>
             <AlertDescription>Check the Timeline and diagnostics before starting another run.</AlertDescription>
           </Alert>
         )}
        {guidance && (
          <Alert className="mt-3 border-primary/40 bg-primary/5" role="status">
            <AlertTitle>Before you can start</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5">
                {guidance.items.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}
      </div>

      <Card ref={(el) => { sectionRefs.current.question = el; }}>
        <CardHeader>
          <CardTitle>1. Question</CardTitle>
          <CardDescription>What should the circle deliberate on?</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="loom-question">Question</Label>
            <Textarea
              id="loom-question"
              rows={3}
              placeholder="e.g. Should we migrate our authentication from sessions to JWT?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={isFrozen}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="loom-context">Context <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="loom-context"
              rows={2}
              placeholder="Background, files to consider, constraints…"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              disabled={isFrozen}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="loom-rounds">Max rounds</Label>
              <Input
                id="loom-rounds"
                type="number"
                min={1}
                 max={10}
                value={maxRounds}
                onChange={(e) => setMaxRounds(e.target.value)}
                className="w-20"
                disabled={isFrozen}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card ref={(el) => { sectionRefs.current.models = el; }}>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <CardTitle>2. Models</CardTitle>
              <CardDescription>
                {totalCount === 0
                  ? "Discovering available models…"
                  : `${enabledCount} of ${totalCount} models enabled — each persona picks one in step 3.`}
              </CardDescription>
            </div>
            <div className="ml-auto">
              <Button variant="outline" size="sm" onClick={() => refreshLlm(true)} disabled={busy !== null || isFrozen} title={isFrozen ? "Locked while a deliberation is running" : "Rescan providers (list is otherwise cached for 60s)"}>
                Refresh providers
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!llm ? (
            <div className="flex flex-col gap-2" aria-label="Loading models">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-3/4" />
            </div>
          ) : totalCount === 0 ? (
            <p className="text-sm text-muted-foreground">No models discovered. Connect a provider (e.g. `opencode auth login`), then hit Refresh providers.</p>
          ) : (
            <div
              className="h-64 rounded-lg border p-1.5"
              role="group"
              aria-label="Enable or disable models for Loom agents"
            >
              <List
                rowComponent={ModelRow}
                rowCount={(llm?.models ?? []).length}
                rowHeight={MODEL_ROW_HEIGHT}
                rowKey={modelRowKey}
                rowProps={{ items: llm?.models ?? [], disabled: busy === "models" || isFrozen, onToggle: toggleModel }}
                overscanCount={4}
                style={{ height: "100%", width: "100%" }}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card ref={(el) => { sectionRefs.current.personas = el; }}>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <CardTitle>3. Personas</CardTitle>
              <CardDescription>
                {seats.length === 0
                  ? "Auto-select a suggested room, or add personas manually — at least 2 seats to start."
                  : `${seats.length} seat${seats.length === 1 ? "" : "s"} in the room — swap or remove to adjust.`}
              </CardDescription>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {seats.length === 0 && (
                <Button
                  size="sm"
                  onClick={doPreview}
                  disabled={!canAutoSelect || !filterOk || isFrozen}
                  title={isFrozen ? "Locked while a deliberation is running" : !filterOk ? "Enable at least one model in step 2 first" : canAutoSelect ? "Compose a suggested room from your question" : "Enter a question of at least 3 characters first"}
                >
                  {busy === "preview" && <Spinner className="mr-2" />}
                  {busy === "preview" ? "Composing…" : "Auto-select"}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={openAdd}
                disabled={seats.length >= MAX_SEATS || !filterOk || isFrozen}
                title={isFrozen ? "Locked while a deliberation is running" : !filterOk ? "Enable at least one model in step 2 first" : seats.length >= MAX_SEATS ? `Room is full (${MAX_SEATS} seats max)` : "Browse the persona catalog and add a seat"}
              >
                {seats.length === 0 ? "Manually add persona" : "Add persona"}
              </Button>
            </div>
          </div>
        </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            {preview && (
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>Suggested {preview.participants?.length ?? 0}-person room</strong>
                  {preview.complexity && <Badge variant="secondary">{preview.complexity} complexity</Badge>}
                  {(preview.tags ?? []).map((t) => <Badge key={t} variant="outline">{t}</Badge>)}
                </div>
                {degradedPreview && (
                  <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                    Persona matching used keyword fallback — the embedding model is unavailable.
                  </p>
                )}
                <Collapsible className="mt-1.5">
                  <CollapsibleTrigger className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                    Why this room?
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-1 text-xs text-muted-foreground">
                    {preview.reasoning}
                    {preview.estimated_rounds != null && <> Estimated rounds: {preview.estimated_rounds}.</>}
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}
            {seats.length === 0 && !preview && busy !== "preview" && (
              <p className="text-sm text-muted-foreground">
                No seats yet — auto-select a room based on your question, or add personas one by one.
              </p>
            )}
            {busy === "preview" && seats.length === 0 && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Composing your room…
              </p>
            )}
            {seats.map((s, i) => {
              const meta = TIER_META[s.tier] ?? TIER_META.mid;
              const tags = s.tags ?? [];
              const shownTags = tags.slice(0, 4);
              return (
                <div
                  key={i}
                  className="flex gap-3 rounded-xl border border-border bg-card p-3 transition-colors"
                >
                  <div className="shrink-0 self-center" aria-hidden="true">
                    <Avatar name={s.name} extra="Seat" size={40} title={s.name} expression={AVATAR_EXPRESSION} colors={AVATAR_COLORS} />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-muted-foreground">Seat {i + 1}</span>
                      <strong className="text-sm">{s.name}</strong>
                      <Badge variant="outline" className={meta.badge} title={meta.blurb}>{meta.label}</Badge>
                    </div>
                    <div className="flex flex-wrap gap-1" aria-label={`Expertise tags for ${s.name}`}>
                      {shownTags.map((t) => <Badge key={t} variant="secondary" className="text-[11px] font-normal">{t}</Badge>)}
                      {tags.length > shownTags.length && (
                        <Badge variant="secondary" className="text-[11px] font-normal" title={tags.join(", ")}>+{tags.length - shownTags.length} more</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{s.agenda}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Label htmlFor={`loom-seat-model-${i}`} className="text-xs text-muted-foreground">Model</Label>
                      <Select
                        value={s.model ?? ""}
                        onValueChange={(v) => setSeats((prev) => prev.map((x, j) => (j === i ? { ...x, model: v } : x)))}
                        disabled={isFrozen}
                      >
                        <SelectTrigger id={`loom-seat-model-${i}`} size="sm" className="min-w-56 max-w-full font-mono text-xs" aria-label={`Model for ${s.name}`}>
                          <SelectValue placeholder="Select model…" />
                        </SelectTrigger>
                        <SelectContent>
                          {enabledModels.map((m) => (
                            <SelectItem key={m.key} value={m.key}>{m.key}</SelectItem>
                          ))}
                        </SelectContent>
                 </Select>
               </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => setSwapIdx(i)} disabled={isFrozen} aria-label={`Swap ${s.name} for another persona`}>
                          Swap
                        </Button>
                      <Button variant="ghost" size="sm" onClick={() => removeSeat(i)} disabled={isFrozen} aria-label={`Remove ${s.name} from the room`}>
                        Remove
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
            {seats.length >= MAX_SEATS && (
              <p className="text-xs text-muted-foreground">Room is full ({MAX_SEATS} seats max) — remove a seat to add a different one.</p>
            )}
          </CardContent>
      </Card>

      <Card ref={(el) => { sectionRefs.current.capabilities = el; }}>
        <CardHeader>
          <CardTitle>4. Persona agent capabilities</CardTitle>
          <CardDescription>Define which tools and interaction protocols the participating agents may use.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="mb-1 text-sm font-medium">Agent capabilities</div>
             {[
               ["forums", "Forums", "Allow participants to create, read, and discuss forum topics. Mandatory requires one forum tool call per active turn."],
               ["skillState", "SKILL.state / stance", "Let each agent carry a stance and bounded evidence into future turns. Mandatory requires one patch per non-pass turn."],
                ["agentQueries", "Agent-to-agent queries", "Allow peer interaction tools: query, vote, summon, and request-next. Mandatory requires one eligible peer interaction when peers are available."],
                ["localSearch", "Local search", "Allow read, glob, and grep for project files. Mandatory requires one local search call per active turn."],
                ["onlineResearch", "Online research", "Allow websearch and webfetch. Mandatory requires one online research call per active turn."],
             ].map(([key, label, description]) => (
               <div key={key} className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-muted/50">
                 <div className="min-w-0">
                   <Label className="cursor-default">{label}</Label>
                   <p className="text-xs text-muted-foreground">{description}</p>
                 </div>
                 <FeatureModeControl value={features[key] ?? "optional"} onChange={(value) => setFeature(key, value)} disabled={isFrozen} />
               </div>
             ))}
             <div className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-muted/50">
               <div className="min-w-0">
                 <Label htmlFor="loom-feature-agentCommands" className="cursor-pointer">Bash commands</Label>
                 <p className="text-xs text-muted-foreground">Allow allowlisted shell commands. Bash is always optional.</p>
               </div>
               <Switch id="loom-feature-agentCommands" checked={features.agentCommands !== false} onCheckedChange={(value) => setFeature("agentCommands", value === true)} disabled={isFrozen} aria-label="Bash commands" />
             </div>
          </div>
        </CardContent>
      </Card>

      <Card ref={(el) => { sectionRefs.current.orchestrator = el; }}>
        <CardHeader>
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle>5. Orchestrator agent</CardTitle>
              <CardDescription>Choose the coordinating model and define how it manages, summarizes, and synthesizes the deliberation.</CardDescription>
            </div>
            <div className="ml-auto">
              <Button variant="outline" size="sm" onClick={openOrchestratorPreview} disabled={previewBusy || isFrozen} title={isFrozen ? "Locked while a deliberation is running" : "Show how the current orchestrator settings affect round summaries and final synthesis"}>
                {previewBusy ? "Previewing…" : "Preview prompt impact"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="loom-orchestrator-model">Orchestrator model</Label>
            <Select value={orchestrator.model ?? ""} onValueChange={(value) => setOrchestratorField("model", value)} disabled={isFrozen || !enabledModels.length}>
              <SelectTrigger id="loom-orchestrator-model" className="max-w-xl font-mono text-xs" aria-label="Orchestrator model">
                <SelectValue placeholder="Select a model…" />
              </SelectTrigger>
              <SelectContent>
                {enabledModels.map((m) => <SelectItem key={m.key} value={m.key}>{m.key}</SelectItem>)}
              </SelectContent>
             </Select>
              <p className="text-xs text-muted-foreground">The model used for orchestrator calls, including turn planning, round summaries, and final synthesis; participant models remain independent.</p>
           </div>
           <div className="flex flex-col gap-2">
             {Object.entries(ORCHESTRATOR_BEHAVIOR_OPTIONS).map(([key, options]) => (
               <div key={key} className="flex items-center justify-between gap-4 rounded-lg border p-3">
                 <div className="min-w-0">
                   <Label htmlFor={`loom-orchestrator-${key}`} className="cursor-default">{ORCHESTRATOR_BEHAVIOR_LABELS[key]}</Label>
                    <p className="mt-0.5 text-xs text-muted-foreground" aria-live="polite">{getOrchestratorBehaviorDescription(key, orchestrator[key])}</p>
                 </div>
                 <Select value={orchestrator[key]} onValueChange={(value) => setOrchestratorField(key, value)} disabled={isFrozen}>
                   <SelectTrigger id={`loom-orchestrator-${key}`} size="sm" className="w-44 shrink-0 font-normal">
                     <SelectValue placeholder="Select…" />
                   </SelectTrigger>
                   <SelectContent>
                     {options.map((option) => (
                       <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                     ))}
                   </SelectContent>
                 </Select>
               </div>
             ))}
           </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="loom-orchestrator-custom">Custom operating instructions <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="loom-orchestrator-custom"
              rows={3}
              maxLength={4000}
              placeholder="e.g. Favor explicit tradeoffs, keep dissent visible, and call out assumptions before recommending action."
              value={orchestrator.customInstructions}
              onChange={(event) => setOrchestratorField("customInstructions", event.target.value)}
              disabled={isFrozen}
            />
          </div>
        </CardContent>
      </Card>

      {selectedMeeting && (
        <Card>
          <CardHeader>
            <CardTitle>Extend current deliberation</CardTitle>
            <CardDescription>Send new input to the circle selected in the sidebar.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                placeholder="New input for the circle…"
                value={extendInput}
                onChange={(e) => setExtendInput(e.target.value)}
                aria-label="New input for the current deliberation"
                disabled={!!job?.running}
              />
              <Button variant="outline" onClick={doExtend} disabled={extendInput.trim().length < 3 || !!job?.running || busy === "extend"}>
                {busy === "extend" ? "Extending…" : "Extend"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="sticky bottom-3 z-10 rounded-xl border bg-card/95 p-3 shadow-lg backdrop-blur" role="region" aria-label="Start deliberation">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                     <div className="w-full text-xs text-muted-foreground">
             Planning estimate: up to {budgetEstimate.calls} LLM calls across {budgetEstimate.rounds} rounds and {budgetEstimate.participants} seats. Provider cost and actual usage may vary.
           </div>
           <ul id="loom-start-checklist" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {requirements.map((r) => (
              <li key={r.key} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={
                    "flex size-4 items-center justify-center rounded-full text-[10px] font-bold " +
                    (r.met ? "bg-emerald-500 text-white" : "bg-muted text-muted-foreground")
                  }
                >
                  {r.met ? "✓" : "○"}
                </span>
                <button
                  type="button"
                  onClick={() => (r.key === "idle" ? window.scrollTo({ top: 0, behavior: "smooth" }) : scrollToSection(r.key))}
                  className={"hover:underline " + (r.met ? "text-muted-foreground" : "font-medium text-foreground")}
                  title={r.met ? "Requirement met" : `Jump to: ${r.label}`}
                >
                  {r.label}
                </button>
              </li>
            ))}
          </ul>
          <Button
            size="lg"
            onClick={doStart}
            disabled={!canStart}
            title={canStart ? "Start the deliberation" : `Waiting on: ${requirements.filter((r) => !r.met).map((r) => r.label).join("; ")}`}
            aria-describedby="loom-start-checklist"
          >
            {busy === "start" && <Spinner className="mr-2" />}
            {busy === "start" ? "Starting…" : "Approve & start deliberation"}
          </Button>
        </div>
      </div>

      {swapIdx !== null && seats[swapIdx] && (
        <PersonaPickerDialog
          open={swapIdx !== null}
          seatNumber={swapIdx + 1}
          seatTier={seats[swapIdx].tier}
          currentName={seats[swapIdx].name}
          seatedNames={seats.filter((_, j) => j !== swapIdx).map((s) => s.name)}
          catalog={catalog}
          onSelect={(persona, tier) => selectSwap(swapIdx, persona, tier)}
          onOpenChange={(v) => { if (!v) setSwapIdx(null); }}
        />
      )}
      <OrchestratorPreviewDialog
        open={previewOpen}
        busy={previewBusy}
        error={previewError}
        preview={previewData}
        onOpenChange={setPreviewOpen}
      />
      {addOpen && (
        <PersonaPickerDialog
          mode="add"
          open={addOpen}
          seatNumber={seats.length + 1}
          seatTier={null}
          currentName={null}
          seatedNames={seats.map((s) => s.name)}
          catalog={catalog}
          onSelect={(persona, tier) => addSeat(persona, tier)}
          onOpenChange={(v) => { if (!v) setAddOpen(false); }}
        />
      )}
    </div>
  );
}
