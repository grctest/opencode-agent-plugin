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
import { Spinner } from "./ui/spinner.tsx";
import { PersonaPickerDialog } from "./PersonaPickerDialog.jsx";
import { RoomSelectionDialog } from "./RoomSelectionDialog.jsx";
import { OrchestratorPreviewDialog } from "./OrchestratorPreviewDialog.jsx";
import { CATEGORY_META, AVATAR_EXPRESSION, AVATAR_COLORS } from "./tierMeta.jsx";

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

export function SetupTab({ selectedMeeting, onStarted, meetingState, meetingParticipants, embeddingStatus }) {
  // Draft form state lives in a persistent per-session nanostore, so tab
  // switches (which unmount this component) and page refreshes never lose it.
  // Transient UI (catalog, llm, busy, errors, dialogs, jobs) stays in useState.
  const form = useStore($setupForm);
  const { question, context, maxRounds, seats, startedId, orchestrator, features } = form;
  const patchForm = (patch) => $setupForm.set({ ...$setupForm.get(), ...patch });
  const setQuestion = (v) => { patchForm({ question: v }); setGuidance(null); };
  const setContext = (v) => { patchForm({ context: v }); setGuidance(null); };
  const setMaxRounds = (v) => patchForm({ maxRounds: v });
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
  const [suggestedModels, setSuggestedModels] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [guidance, setGuidance] = useState(null);
  const [swapIdx, setSwapIdx] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [rankOpen, setRankOpen] = useState(false);
  const [ranked, setRanked] = useState([]);
  const [rankAutoSelect, setRankAutoSelect] = useState(3);
  const [rankSuggestedModels, setRankSuggestedModels] = useState([]);
  const [job, setJob] = useState(null);
  const [extendInput, setExtendInput] = useState("");
  const [resumeStatus, setResumeStatus] = useState(null);
  const [resumeParts, setResumeParts] = useState(null);
  const [resumedId, setResumedId] = useState(null);
  const [resumeWarnings, setResumeWarnings] = useState([]);
  const [resumeMeta, setResumeMeta] = useState(null);
  const [finishInfo, setFinishInfo] = useState(null);
  const [finishedId, setFinishedId] = useState(null);
  const [finishWarnings, setFinishWarnings] = useState([]);
  const [finishMeta, setFinishMeta] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [extendRounds, setExtendRounds] = useState(4);
  const sectionRefs = useRef({});

  // A meeting with persisted participants has already run (or is running):
  // its stored configuration is mirrored into the form, read-only. Question,
  // context, rounds, seats, capabilities and orchestrator all come from the
  // durable meeting row — nothing on the page can be edited.
  const storedRunParticipants = Array.isArray(meetingParticipants) ? meetingParticipants : [];
  const readOnly = storedRunParticipants.length > 0;
  // Setup is frozen while a deliberation is weaving, and read-only once one has
  // already run. Everything that mutates seats checks this.
  const locked = !!job?.running || readOnly;
  // "Already run" is a terminal-state message — while the meeting is actively
  // weaving (job running, or interrupted mid-run) the "running"/"interrupted"
  // banners own the headline instead.
  const meetingActive = !!job?.running || resumeStatus === "weaving" || resumeStatus === "initializing";
  const storedRunPopulatedFor = useRef(null);
  useEffect(() => {
    if (!readOnly || !selectedMeeting || storedRunPopulatedFor.current === selectedMeeting) return;
    storedRunPopulatedFor.current = selectedMeeting;
    const cur = $setupForm.get();
    const s = meetingState;
    const pick = (obj) => (obj && typeof obj === "object" ? obj : {});
    const rawFeatures = pick(s?.features);
    // Migrate legacy 3-state skillState values (<= FORM v5) to the off/on toggle.
    const skillStateRaw = rawFeatures.skillState;
    const skillStateMigrated = skillStateRaw === "mandatory" || skillStateRaw === "optional" || skillStateRaw === true
      ? "on"
      : skillStateRaw === "disabled" || skillStateRaw === false
        ? "off"
        : skillStateRaw;
    patchForm({
      question: typeof s?.question === "string" ? s.question : "",
      context: typeof s?.context === "string" ? s.context : "",
      maxRounds: Number.isFinite(Number(s?.max_rounds))
        ? Math.min(10, Math.max(1, Math.floor(Number(s.max_rounds))))
        : cur.maxRounds,
      seats: storedRunParticipants.map((p) => ({
        id: p.id,
        name: p.name,
        persona: p.persona,
        agenda: p.agenda,
        category: p.category ?? p.tier,
        tags: p.tags ?? [],
        expertise: p.expertise ?? [],
        known_biases: p.known_biases ?? [],
        communication_style: p.communication_style ?? "",
        preferred_contribution_types: p.preferred_contribution_types ?? [],
        anti_patterns: p.anti_patterns ?? [],
        category_guidance: p.category_guidance ?? p.tier_guidance ?? "",
        reflection_guidance: p.reflection_guidance ?? "",
        model: p.provider_id && p.model_id ? `${p.provider_id}/${p.model_id}` : null,
        variant: typeof p.model_variant === "string" && p.model_variant ? p.model_variant : (typeof p.variant === "string" && p.variant ? p.variant : null),
        approved: true,
      })),
      features: { ...cur.features, ...rawFeatures, ...(skillStateMigrated !== undefined ? { skillState: skillStateMigrated } : {}) },
      orchestrator: { ...cur.orchestrator, ...pick(s?.orchestrator) },
    });
  }, [readOnly, selectedMeeting, meetingState, storedRunParticipants]);

  const scrollToSection = (key) => {
    sectionRefs.current[key]?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // Fill seats missing a model (or holding a now-disabled one) with a random
  // enabled model (extraSuggested pre-fills by seat index when available).
  // Returns the same array ref when nothing changed so setSeats bails out
  // without re-rendering. Skipped entirely for stored-run meetings: their
  // persisted models are shown as-is.
  // A replaced model always resets the seat variant (variants are
  // model-specific), as does a variant that the current model no longer offers.
  const fillSeatModels = (seatList, llmData, extraSuggested = null) => {
    if (readOnly) return seatList;
    const enabled = (llmData?.models ?? []).filter((m) => m.enabled && !m.unhealthy).map((m) => m.key);
    const enabledSet = new Set(enabled);
    const variantsByKey = new Map((llmData?.models ?? []).map((m) => [m.key, Array.isArray(m.variants) ? m.variants : []]));
    const pick = () => (enabled.length > 0 ? enabled[Math.floor(Math.random() * enabled.length)] : null);
    let changed = false;
    const next = seatList.map((st, i) => {
      if (st.model && enabledSet.has(st.model)) {
        const offered = variantsByKey.get(st.model) ?? [];
        if (st.variant && !offered.includes(st.variant)) {
          changed = true;
          return { ...st, variant: null };
        }
        return st;
      }
      const indexed = Array.isArray(extraSuggested) ? extraSuggested[i] : null;
      const d = (indexed && enabledSet.has(indexed)) ? indexed : pick();
      if ((d ?? null) === (st.model ?? null)) {
        if (st.variant) {
          changed = true;
          return { ...st, variant: null };
        }
        return st;
      }
      changed = true;
      return { ...st, model: d, variant: null };
    });
    return changed ? next : seatList;
  };

  const fillOrchestratorModel = useCallback((llmData) => {
    const enabled = (llmData?.models ?? []).filter((m) => m.enabled && !m.unhealthy).map((m) => m.key);
    const variantsByKey = new Map((llmData?.models ?? []).map((m) => [m.key, Array.isArray(m.variants) ? m.variants : []]));
    if (enabled.length === 0) {
      if (orchestrator.model) setOrchestratorField("model", null);
      if (orchestrator.variant) setOrchestratorField("variant", null);
      return;
    }
    const current = $setupForm.get().orchestrator?.model;
    const currentVariant = $setupForm.get().orchestrator?.variant;
    if (current && enabled.includes(current)) {
      // Keep the model, but drop a variant the model no longer offers
      // (variants are model-specific).
      const offered = variantsByKey.get(current) ?? [];
      if (currentVariant && !offered.includes(currentVariant)) setOrchestratorField("variant", null);
      return;
    }
    const recommended = llmData?.suggested_orchestrator?.key;
    const next = recommended && enabled.includes(recommended) ? recommended : enabled[0];
    const form = $setupForm.get();
    $setupForm.set({ ...form, orchestrator: { ...form.orchestrator, model: next, variant: null } });
  }, [orchestrator.model, orchestrator.variant]);

  const refreshLlm = useCallback(async (force = false) => {
    try {
      const res = await fetch(force ? "/api/llm-models?refresh=1" : "/api/llm-models");
      if (res.ok) {
        const data = await res.json();
        setLlm(data);
        fillOrchestratorModel(data);
        setSeats((prev) => fillSeatModels(prev, data));
      }
    } catch {}
  }, [fillOrchestratorModel]);

  useEffect(() => { refreshLlm(); }, [refreshLlm]);

  // "Deliberation started/resumed" are transient action feedback: once the
  // job poll shows that meeting running (or the selection moves on), the
  // "running" banner supersedes them — they must never stack. "finished" is a
  // terminal confirmation: it clears only if the meeting runs again (e.g.
  // after an extend) or the selection moves on.
  useEffect(() => {
    if (startedId && (job?.running === startedId || startedId !== selectedMeeting)) setStartedId(null);
    if (resumedId && (job?.running === resumedId || resumedId !== selectedMeeting)) setResumedId(null);
    if (finishedId && (job?.running === finishedId || finishedId !== selectedMeeting)) setFinishedId(null);
  }, [startedId, resumedId, finishedId, job?.running, selectedMeeting]);

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

  // Detect an interrupted meeting: DB row still weaving/initializing but no
  // active job (e.g. server force-closed mid-round). Resume-only triage.
  // Also detects synthesis orphans: terminal status but no artifact row
  // (kill between status persist and artifact save) for the Finish action.
  useEffect(() => {
    if (!selectedMeeting || job?.running) {
      setResumeStatus(null);
      setResumeParts(null);
      setFinishInfo(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/state?meeting=${selectedMeeting}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const status = data?.status ?? null;
        setResumeStatus(status);
        if (status === "weaving" || status === "initializing") {
          setFinishInfo(null);
          try {
            const pres = await fetch(`/api/participants?meeting=${selectedMeeting}`);
            if (pres.ok) {
              const pdata = await pres.json();
              if (!cancelled) setResumeParts(Array.isArray(pdata) ? pdata.length : null);
            }
          } catch {}
        } else if (status) {
          setResumeParts(null);
          try {
            const ares = await fetch(`/api/artifact?meeting=${selectedMeeting}`);
            if (!cancelled) {
              if (ares.ok) {
                const adata = await ares.json();
                setFinishInfo({ status, hasArtifact: !!(adata && adata.content) });
              } else {
                setFinishInfo({ status, hasArtifact: null });
              }
            }
          } catch {}
        } else {
          setResumeParts(null);
          setFinishInfo(null);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [selectedMeeting, job]);

  const enabledKeys = useMemo(
    () => new Set((llm?.models ?? []).filter((m) => m.enabled && !m.unhealthy).map((m) => m.key)),
    [llm],
  );
  const defaultModelForSeat = useCallback(() => {
    const enabled = (llm?.models ?? []).filter((m) => m.enabled && !m.unhealthy).map((m) => m.key);
    if (enabled.length === 0) return null;
    return enabled[Math.floor(Math.random() * enabled.length)];
  }, [llm]);

  // Auto-select is offered only when an embedding model is actually loaded.
  // There is no keyword fallback behind it, so with no embedder the button
  // simply does not appear rather than appearing disabled.
  const embedderReady = embeddingStatus?.state === "ready" && !!embeddingStatus?.model;
  // Auto-select also waits on the background persona index. Without it the
  // dialog would open against an empty store; with it the click is instant.
  // The button is hidden while warming rather than disabled, and a muted line
  // takes its place so its absence is never unexplained.
  const personaIndex = embeddingStatus?.personaIndex ?? { state: "empty", count: 0, message: null };
  const personaIndexReady = personaIndex.state === "ready";
  const personaIndexBusy = personaIndex.state === "indexing";
  const canAutoSelect = question.trim().length >= 3 && enabledKeys.size > 0 && !locked;

  // Fetches the full ranking, then opens the dialog. The dialog is seeded with
  // the server's top slice; the seats are only written on confirm, so a
  // cancelled dialog leaves the room untouched.
  const openAutoSelect = async () => {
    if (!canAutoSelect || !embedderReady) return;
    setError(null);
    setGuidance(null);
    setRanked([]);
    setRankOpen(true);
    setBusy("preview");
    try {
      await ensureCatalog();
      const data = await postJSON("/api/room/preview", { question, context });
      const extraSuggested = (data.suggested_models ?? [])
        .map((s) => (s.provider_id && s.model_id ? `${s.provider_id}/${s.model_id}` : null))
        .filter(Boolean);
      setSuggestedModels(extraSuggested);
      setRanked(data.ranked ?? []);
      setRankAutoSelect(Number(data.auto_select_count) > 0 ? Number(data.auto_select_count) : 3);
      setRankSuggestedModels(extraSuggested);
    } catch (err) {
      setRankOpen(false);
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  // The dialog returns the personas it settled on, in ranked order.
  const applyAutoSelect = (personas) => {
    setSeats(fillSeatModels(
      personas.map((p) => ({ ...p, approved: true, model: null, variant: null })),
      llm,
      rankSuggestedModels,
    ));
    setRankOpen(false);
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

  const addSeat = (persona, category) => {
    if (!persona || seats.some((s) => s.name === persona.name)) {
      setAddOpen(false);
      return;
    }
    setSeats((prev) => [...prev, { ...persona, category, approved: true, model: defaultModelForSeat(), variant: null }]);
    setAddOpen(false);
    setGuidance(null);
  };

  const removeSeat = (idx) => {
    setSeats((prev) => prev.filter((_, j) => j !== idx));
    setGuidance(null);
  };

  const selectSwap = (idx, persona, category) => {
    setSeats((prev) => prev.map((s, i) => (i === idx ? { ...s, ...persona, category, approved: true } : s)));
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
  // Variant IDs offered per model key (mirrors upstream `Object.keys(variants)`).
  // Variants are model-specific overlays (e.g. reasoning effort); absent or
  // empty means the model offers none and no picker is shown.
  const variantsByKey = useMemo(() => {
    const map = new Map();
    for (const m of llm?.models ?? []) map.set(m.key, Array.isArray(m.variants) ? m.variants : []);
    return map;
  }, [llm]);
  const variantsForKey = useCallback((key) => variantsByKey.get(key) ?? [], [variantsByKey]);
  const enabledCount = enabledModels.length;
  const totalCount = (llm?.models ?? []).length;

  const questionOk = question.trim().length >= 3;
  const roomOk = seats.length >= 2;
  const personasOk = roomOk;
  const filterOk = enabledKeys.size >= 1;
  const seatsMapped = !roomOk || seats.every((s) => s.model && enabledKeys.has(s.model));
  // A selected variant must be offered by its model; switching models resets
  // the variant, and catalog changes clear stale ones, so this is a backstop.
  const variantsOk = seats.every((s) => !s.variant || variantsForKey(s.model).includes(s.variant))
    && (!orchestrator.variant || variantsForKey(orchestrator.model).includes(orchestrator.variant));
  const modelsOk = filterOk && seatsMapped && variantsOk;
  const orchestratorOk = !!orchestrator.model && enabledKeys.has(orchestrator.model) && (!orchestrator.variant || variantsForKey(orchestrator.model).includes(orchestrator.variant));
  const idleOk = !job?.running;
  // While a deliberation is weaving, the entire setup form freezes in its
  // current state — question, rounds, models, seats, and actions all lock.
  // (Declared earlier as `locked` so auto-select can read it before this point.)
  const isFrozen = !!job?.running;

  const requirements = useMemo(() => ([
    { key: "question", met: questionOk, label: "Enter a question" },
    { key: "models", met: modelsOk, label: !filterOk ? "Enable at least 1 model" : (!variantsOk ? "Fix invalid model variants" : (!roomOk ? `Models ready (${enabledCount} enabled)` : seatsMapped ? `Models ready (${seats.length} seats mapped)` : "Pick a model for every seat")) },
      { key: "personas", met: personasOk, label: roomOk ? `Personas selected (${seats.length} seats)` : "Add at least 2 persona seats (auto-select or manual)" },
      { key: "capabilities", met: true, label: "Persona capabilities configured" },
      { key: "orchestrator", met: orchestratorOk, label: orchestratorOk ? "Orchestrator ready" : "Choose an orchestrator model" },
     { key: "idle", met: idleOk, label: "No deliberation running" },
    ]), [questionOk, personasOk, roomOk, seats.length, modelsOk, orchestratorOk, filterOk, seatsMapped, variantsOk, enabledCount, idleOk]);

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
         participants: seats.map(({ model, variant, ...p }) => {
           if (!model) return { ...p, approved: true };
          const [provider_id, ...rest] = model.split("/");
           const ref = { provider_id, model_id: rest.join("/") };
           if (variant) ref.variant = variant;
           return { ...p, approved: true, model: ref };
         }),
          orchestrator: { ...orchestrator, model: orchestrator.model },
          orchestrator_model: (() => {
            const [provider_id, ...rest] = (orchestrator.model ?? "").split("/");
            const ref = { provider_id, model_id: rest.join("/") };
            if (orchestrator.variant) ref.variant = orchestrator.variant;
            return ref;
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

  const doResume = async () => {
    if (!selectedMeeting) return;
    setError(null);
    setBusy("resume");
    try {
      const data = await postJSON("/api/meetings/resume", { meeting_id: selectedMeeting });
      setResumedId(selectedMeeting);
      setResumeWarnings(Array.isArray(data?.warnings) ? data.warnings : []);
      setResumeMeta({ recovered: !!data?.recovered, degraded: !!data?.degraded });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const doFinish = async () => {
    if (!selectedMeeting) return;
    setError(null);
    setBusy("finish");
    try {
      const data = await postJSON("/api/meetings/finish", { meeting_id: selectedMeeting });
      if (data?.artifact_present) {
        setFinishedId(selectedMeeting);
        setFinishWarnings([]);
        setFinishMeta({ recovered: !!data?.recovered, degraded: !!data?.degraded, regenerated: !!data?.report_regenerated });
      } else {
        setFinishedId(selectedMeeting);
        setFinishWarnings(Array.isArray(data?.warnings) ? data.warnings : []);
        setFinishMeta({ recovered: !!data?.recovered, degraded: !!data?.degraded, regenerated: false });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const doExtend = async () => {
    if (!selectedMeeting || extendInput.trim().length < 3) return;
    const rounds = Number.isFinite(Number(extendRounds))
      ? Math.min(10, Math.max(1, Math.floor(Number(extendRounds))))
      : undefined;
    setError(null);
    setBusy("extend");
    try {
      await postJSON("/api/meetings/extend", {
        meeting_id: selectedMeeting,
        question: extendInput.trim(),
        ...(rounds !== undefined ? { additional_rounds: rounds } : {}),
      });
      setExtendInput("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-5 max-w-4xl pb-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <StepHeader steps={steps} />
        <Button variant="ghost" size="sm" onClick={clearForm} disabled={isFrozen || readOnly} title={isFrozen ? "Locked while a deliberation is running" : readOnly ? "Locked — this deliberation's configuration is read-only" : "Reset the setup form to empty (running deliberations are unaffected)"}>
          Clear form
        </Button>
      </div>

      <div aria-live="polite">
        {readOnly && !meetingActive && (
          <Alert className="border-primary/40 bg-primary/5">
            <AlertTitle>Deliberation already run</AlertTitle>
            <AlertDescription>
              This meeting's configuration is loaded from its stored data and is read-only. Use “Extend current deliberation” below to send new input and add rounds.
            </AlertDescription>
          </Alert>
        )}
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
        {resumedId && (
          <Alert className="mt-3 border-emerald-500/40 bg-emerald-500/10">
            <AlertTitle>Deliberation resumed</AlertTitle>
            <AlertDescription>
              <span>Continuing meeting {resumedId.slice(0, 8)}… from where it left off — follow it in the Timeline tab.</span>
              {resumeMeta?.recovered && (
                <div className="mt-1 text-xs opacity-80">Crash WAL was checkpointed before resuming; history is complete.</div>
              )}
              {resumeMeta?.degraded && (
                <div className="mt-1 text-xs opacity-80">Warning: reads fell back to the last checkpointed image — recent turns may be missing.</div>
              )}
              {resumeWarnings.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {resumeWarnings.map((w, i) => (
                    <li key={i}>Model change for {w.seat}: {w.requested} unavailable — {w.detail}</li>
                  ))}
                </ul>
              )}
            </AlertDescription>
          </Alert>
        )}
        {finishedId && (
          <Alert className="mt-3 border-emerald-500/40 bg-emerald-500/10">
            <AlertTitle>Deliberation finished</AlertTitle>
            <AlertDescription>
              <span>Synthesis completed for meeting {finishedId.slice(0, 8)}… — see the Output tab.</span>
              {finishMeta?.regenerated && (
                <div className="mt-1 text-xs opacity-80">The report file was regenerated from the stored output.</div>
              )}
              {finishMeta?.degraded && (
                <div className="mt-1 text-xs opacity-80">Warning: reads fell back to the last checkpointed image.</div>
              )}
              {finishWarnings.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {finishWarnings.map((w, i) => (
                    <li key={i}>Model change for {w.seat}: {w.requested} unavailable — {w.detail}</li>
                  ))}
                </ul>
              )}
            </AlertDescription>
          </Alert>
        )}
        {selectedMeeting && !job?.running && (resumeStatus === "weaving" || resumeStatus === "initializing") && resumeParts === 0 && (
          <Alert className="mt-3 border-amber-500/40 bg-amber-500/10">
            <AlertTitle>Deliberation interrupted</AlertTitle>
            <AlertDescription>This meeting stopped before participants were saved — it cannot be resumed. Start a fresh deliberation below.</AlertDescription>
          </Alert>
        )}
        {selectedMeeting && !job?.running && (resumeStatus === "weaving" || resumeStatus === "initializing") && resumeParts !== 0 && (
          <Alert className="mt-3 border-amber-500/40 bg-amber-500/10">
            <AlertTitle>Deliberation interrupted</AlertTitle>
            <AlertDescription className="flex items-center justify-between gap-2">
              <span>The server stopped mid-run. Committed turns are preserved — resume completes the interrupted round first, then continues.</span>
              <Button variant="outline" size="sm" onClick={doResume} disabled={busy === "resume"}>
                {busy === "resume" ? "Resuming…" : "Resume"}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {selectedMeeting && !job?.running && finishInfo && ["converged", "cancelled", "timeout", "max_rounds_reached", "aborted"].includes(finishInfo.status) && finishInfo.hasArtifact === false && (
          <Alert className="mt-3 border-amber-500/40 bg-amber-500/10">
            <AlertTitle>Synthesis never completed</AlertTitle>
            <AlertDescription className="flex items-center justify-between gap-2">
              <span>This meeting ended ({finishInfo.status}) but its output was never written. Finish runs synthesis only — no new rounds.</span>
              <Button variant="outline" size="sm" onClick={doFinish} disabled={busy === "finish"}>
                {busy === "finish" ? "Finishing…" : "Finish"}
              </Button>
            </AlertDescription>
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
              disabled={isFrozen || readOnly}
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
              disabled={isFrozen || readOnly}
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
                disabled={isFrozen || readOnly}
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
              <Button variant="outline" size="sm" onClick={() => refreshLlm(true)} disabled={busy !== null || isFrozen || readOnly} title={isFrozen ? "Locked while a deliberation is running" : readOnly ? "Locked — this deliberation's configuration is read-only" : "Rescan providers (list is otherwise cached for 60s)"}>
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
                rowProps={{ items: llm?.models ?? [], disabled: busy === "models" || isFrozen || readOnly, onToggle: toggleModel }}
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
                  ? embedderReady
                    ? "Auto-select from all personas ranked by similarity, or add them one by one — at least 2 seats to start."
                    : "Add personas manually — at least 2 seats to start."
                  : `${seats.length} seat${seats.length === 1 ? "" : "s"} in the room — swap or remove to adjust.`}
              </CardDescription>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {/* Rendered only with a live embedder. There is no keyword
                  fallback to degrade into, so a disabled button would only be
                  explaining something the user cannot act on inline. */}
              {embedderReady && seats.length === 0 && personaIndexReady && (
                <Button
                  size="sm"
                  onClick={openAutoSelect}
                  disabled={!canAutoSelect || !filterOk}
                  title={isFrozen ? "Locked while a deliberation is running" : readOnly ? "Locked — this deliberation's configuration is read-only" : !filterOk ? "Enable at least one model in step 2 first" : canAutoSelect ? "Rank every persona by similarity to your question" : "Enter a question of at least 3 characters first"}
                >
                  {busy === "preview" && <Spinner className="mr-2" />}
                  {busy === "preview" ? "Ranking…" : "Auto-select"}
                </Button>
              )}
              {embedderReady && seats.length === 0 && !personaIndexReady && personaIndexBusy && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
                  <Spinner /> Preparing {personaIndex.count > 0 ? `${personaIndex.count} personas` : "personas"}…
                </span>
              )}
              {embedderReady && seats.length === 0 && personaIndex.state === "error" && (
                <span className="text-xs text-amber-600 dark:text-amber-400" title={personaIndex.message ?? undefined}>
                  Auto-select unavailable — couldn't prepare the persona index. Add personas manually.
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={openAdd}
                disabled={!filterOk || isFrozen || readOnly}
                title={isFrozen ? "Locked while a deliberation is running" : readOnly ? "Locked — this deliberation's configuration is read-only" : !filterOk ? "Enable at least one model in step 2 first" : "Browse the persona catalog and add a seat"}
              >
                {seats.length === 0 ? "Manually add persona" : "Add persona"}
              </Button>
            </div>
          </div>
        </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            {seats.length === 0 && busy !== "preview" && (
              <p className="text-sm text-muted-foreground">
                {embedderReady
                  ? "No seats yet — auto-select to rank all personas by similarity, or add them one by one."
                  : "No seats yet — add personas one by one."}
              </p>
            )}
            {busy === "preview" && seats.length === 0 && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Composing your room…
              </p>
            )}
            {seats.map((s, i) => {
              const meta = CATEGORY_META[s.category ?? s.tier] ?? {};
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
                        onValueChange={(v) => setSeats((prev) => prev.map((x, j) => (j === i ? { ...x, model: v, variant: null } : x)))}
                        disabled={isFrozen || readOnly}
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
                 {variantsForKey(s.model).length > 0 && (
                   <>
                     <Label htmlFor={`loom-seat-variant-${i}`} className="text-xs text-muted-foreground">Variant</Label>
                     <Select
                       value={s.variant ?? "default"}
                       onValueChange={(v) => setSeats((prev) => prev.map((x, j) => (j === i ? { ...x, variant: v === "default" ? null : v } : x)))}
                       disabled={isFrozen || readOnly}
                     >
                       <SelectTrigger id={`loom-seat-variant-${i}`} size="sm" className="min-w-28 max-w-full font-mono text-xs capitalize" aria-label={`Variant for ${s.name}`}>
                         <SelectValue placeholder="Default" />
                       </SelectTrigger>
                       <SelectContent>
                         <SelectItem value="default">Default</SelectItem>
                         {variantsForKey(s.model).map((v) => (
                           <SelectItem key={v} value={v} className="capitalize">{v}</SelectItem>
                         ))}
                       </SelectContent>
                     </Select>
                   </>
                 )}
               </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => setSwapIdx(i)} disabled={isFrozen || readOnly} aria-label={`Swap ${s.name} for another persona`}>
                          Swap
                        </Button>
                      <Button variant="ghost" size="sm" onClick={() => removeSeat(i)} disabled={isFrozen || readOnly} aria-label={`Remove ${s.name} from the room`}>
                        Remove
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
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
                ["agentQueries", "Agent-to-agent queries", "Allow peer interaction tools: query, vote, summon, and request-next. Mandatory requires one eligible peer interaction when peers are available."],
               ["localSearch", "Local search", "Allow read, glob, and grep for project files. Mandatory requires one local search call per active turn."],
               ["onlineResearch", "Online research", "Allow websearch and webfetch. Mandatory requires one online research call per active turn."],
             ].map(([key, label, description]) => (
               <div key={key} className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-muted/50">
                 <div className="min-w-0">
                   <Label className="cursor-default">{label}</Label>
                   <p className="text-xs text-muted-foreground">{description}</p>
                 </div>
                  <FeatureModeControl value={features[key] ?? "optional"} onChange={(value) => setFeature(key, value)} disabled={isFrozen || readOnly} />
                </div>
              ))}
              <div className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-muted/50">
                <div className="min-w-0">
                  <Label htmlFor="loom-feature-skillState" className="cursor-pointer">SKILL.state / stance</Label>
                  <p className="text-xs text-muted-foreground">When on, each agent projects stance + evidence as their final action each non-pass turn via loom_state_patch. Off disables carried state.</p>
                </div>
                <Switch id="loom-feature-skillState" checked={(() => { const v = features.skillState; return v === "on" || v === "mandatory" || v === "optional" || v === true; })()} onCheckedChange={(value) => setFeature("skillState", value ? "on" : "off")} disabled={isFrozen || readOnly} aria-label="SKILL.state / stance" />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-muted/50">
                <div className="min-w-0">
                  <Label htmlFor="loom-feature-agentCommands" className="cursor-pointer">Bash commands</Label>
                  <p className="text-xs text-muted-foreground">Allow allowlisted shell commands. Bash is always optional.</p>
                </div>
                <Switch id="loom-feature-agentCommands" checked={features.agentCommands !== false} onCheckedChange={(value) => setFeature("agentCommands", value === true)} disabled={isFrozen || readOnly} aria-label="Bash commands" />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-muted/50">
                <div className="min-w-0">
                  <Label htmlFor="loom-feature-parallelQueries" className="cursor-pointer">Parallel peer queries</Label>
                  <p className="text-xs text-muted-foreground">Fan out multi-target queries and votes concurrently in rate-limited batches. Off runs them sequentially.</p>
                </div>
                <Switch id="loom-feature-parallelQueries" checked={features.parallelQueries !== false} onCheckedChange={(value) => setFeature("parallelQueries", value === true)} disabled={isFrozen || readOnly} aria-label="Parallel peer queries" />
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
              <Button variant="outline" size="sm" onClick={openOrchestratorPreview} disabled={previewBusy || isFrozen || readOnly} title={isFrozen ? "Locked while a deliberation is running" : readOnly ? "Locked — this deliberation's configuration is read-only" : "Show how the current orchestrator settings affect round summaries and final synthesis"}>
                {previewBusy ? "Previewing…" : "Preview prompt impact"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div className="min-w-0">
              <Label htmlFor="loom-orchestrator-deliberationMode" className="cursor-default">Deliberation mode</Label>
              <p className="mt-0.5 text-xs text-muted-foreground" aria-live="polite">{features.buildMode === true ? "Build — agents may write and edit project files after reading. Choose this when the deliberation should produce live changes." : "Plan — read-only. Agents propose diffs but never write. Switch to Build before starting if you expect live file changes."}</p>
            </div>
            <Select value={features.buildMode === true ? "build" : "plan"} onValueChange={(value) => setFeature("buildMode", value === "build")} disabled={isFrozen || readOnly}>
              <SelectTrigger id="loom-orchestrator-deliberationMode" size="sm" className="w-44 shrink-0 font-normal" aria-label="Deliberation mode">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="plan">Plan — read-only</SelectItem>
                <SelectItem value="build">Build — may write</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Label htmlFor="loom-orchestrator-model">Orchestrator model</Label>
                <Select value={orchestrator.model ?? ""} onValueChange={(value) => patchForm({ orchestrator: { ...orchestrator, model: value, variant: null } })} disabled={isFrozen || readOnly || !enabledModels.length}>
                  <SelectTrigger id="loom-orchestrator-model" className="max-w-xl font-mono text-xs" aria-label="Orchestrator model">
                    <SelectValue placeholder="Select a model…" />
                  </SelectTrigger>
                  <SelectContent>
                    {enabledModels.map((m) => <SelectItem key={m.key} value={m.key}>{m.key}</SelectItem>)}
                  </SelectContent>
                 </Select>
              </div>
              {variantsForKey(orchestrator.model).length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="loom-orchestrator-variant">Variant</Label>
                  <Select value={orchestrator.variant ?? "default"} onValueChange={(value) => setOrchestratorField("variant", value === "default" ? null : value)} disabled={isFrozen || readOnly || !enabledModels.length}>
                    <SelectTrigger id="loom-orchestrator-variant" size="sm" className="min-w-28 font-mono text-xs capitalize" aria-label="Orchestrator variant">
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default</SelectItem>
                      {variantsForKey(orchestrator.model).map((v) => (
                        <SelectItem key={v} value={v} className="capitalize">{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
              <p className="text-xs text-muted-foreground">The model used for orchestrator calls, including turn planning, round summaries, and final synthesis; participant models remain independent. Variant selects the model's reasoning-effort overlay when the provider offers one — Default uses the server default.</p>
           </div>
           <div className="flex flex-col gap-2">
             {Object.entries(ORCHESTRATOR_BEHAVIOR_OPTIONS).map(([key, options]) => (
               <div key={key} className="flex items-center justify-between gap-4 rounded-lg border p-3">
                 <div className="min-w-0">
                   <Label htmlFor={`loom-orchestrator-${key}`} className="cursor-default">{ORCHESTRATOR_BEHAVIOR_LABELS[key]}</Label>
                    <p className="mt-0.5 text-xs text-muted-foreground" aria-live="polite">{getOrchestratorBehaviorDescription(key, orchestrator[key])}</p>
                 </div>
                  <Select value={orchestrator[key]} onValueChange={(value) => setOrchestratorField(key, value)} disabled={isFrozen || readOnly}>
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
              disabled={isFrozen || readOnly}
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
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1">
                <Input
                  placeholder="New input for the circle…"
                  value={extendInput}
                  onChange={(e) => setExtendInput(e.target.value)}
                  aria-label="New input for the current deliberation"
                  disabled={!!job?.running}
                />
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="loom-extend-rounds" className="text-xs text-muted-foreground">Additional rounds</Label>
                <Input
                  id="loom-extend-rounds"
                  type="number"
                  min={1}
                  max={10}
                  value={extendRounds}
                  onChange={(e) => setExtendRounds(e.target.value)}
                  className="w-20"
                  disabled={!!job?.running}
                  aria-label="Additional rounds to grant"
                />
              </div>
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
            disabled={!canStart || readOnly}
            title={readOnly ? "Locked — this deliberation's configuration is read-only" : canStart ? "Start the deliberation" : `Waiting on: ${requirements.filter((r) => !r.met).map((r) => r.label).join("; ")}`}
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
          seatCategory={seats[swapIdx].category ?? seats[swapIdx].tier}
          currentName={seats[swapIdx].name}
          seatedNames={seats.filter((_, j) => j !== swapIdx).map((s) => s.name)}
          catalog={catalog}
          onSelect={(persona, category) => selectSwap(swapIdx, persona, category)}
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
          seatCategory={null}
          currentName={null}
          seatedNames={seats.map((s) => s.name)}
          catalog={catalog}
          onSelect={(persona, category) => addSeat(persona, category)}
          onOpenChange={(v) => { if (!v) setAddOpen(false); }}
        />
      )}
      <RoomSelectionDialog
        open={rankOpen}
        question={question}
        catalog={catalog}
        ranked={ranked}
        busy={busy === "preview"}
        error={error}
        autoSelectCount={rankAutoSelect}
        onApply={applyAutoSelect}
        onOpenChange={(v) => { if (!v) setRankOpen(false); }}
      />
    </div>
  );
}
