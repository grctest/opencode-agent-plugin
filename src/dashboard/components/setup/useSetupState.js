/**
 * All SetupTab state, effects, derived values, and server actions.
 * Presentational sections live in sibling card components; this hook is
 * the single place where setup data is fetched, derived, and mutated.
 */
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useStore } from "@nanostores/react";
import { $setupForm, resetSetupForm } from "../../stores/setupForm.js";
import { postJSON } from "./setupFormat.js";

export function useSetupState({ selectedMeeting, onStarted, meetingState, meetingParticipants, embeddingStatus }) {
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

  const storedRunParticipants = Array.isArray(meetingParticipants) ? meetingParticipants : [];
  const readOnly = storedRunParticipants.length > 0;
  const locked = !!job?.running || readOnly;
  const meetingActive = !!job?.running || resumeStatus === "weaving" || resumeStatus === "initializing";
  const storedRunPopulatedFor = useRef(null);
  useEffect(() => {
    if (!readOnly || !selectedMeeting || storedRunPopulatedFor.current === selectedMeeting) return;
    storedRunPopulatedFor.current = selectedMeeting;
    const cur = $setupForm.get();
    const s = meetingState;
    const pick = (obj) => (obj && typeof obj === "object" ? obj : {});
    const rawFeatures = pick(s?.features);
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
    const variantsByKeyLocal = new Map((llmData?.models ?? []).map((m) => [m.key, Array.isArray(m.variants) ? m.variants : []]));
    if (enabled.length === 0) {
      if (orchestrator.model) setOrchestratorField("model", null);
      if (orchestrator.variant) setOrchestratorField("variant", null);
      return;
    }
    const current = $setupForm.get().orchestrator?.model;
    const currentVariant = $setupForm.get().orchestrator?.variant;
    if (current && enabled.includes(current)) {
      const offered = variantsByKeyLocal.get(current) ?? [];
      if (currentVariant && !offered.includes(currentVariant)) setOrchestratorField("variant", null);
      return;
    }
    const recommended = llmData?.suggested_orchestrator?.key;
    const next = recommended && enabled.includes(recommended) ? recommended : enabled[0];
    const formSnap = $setupForm.get();
    $setupForm.set({ ...formSnap, orchestrator: { ...formSnap.orchestrator, model: next, variant: null } });
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

  useEffect(() => {
    if (startedId && (job?.running === startedId || startedId !== selectedMeeting)) setStartedId(null);
    if (resumedId && (job?.running === resumedId || resumedId !== selectedMeeting)) setResumedId(null);
    if (finishedId && (job?.running === finishedId || finishedId !== selectedMeeting)) setFinishedId(null);
  }, [startedId, resumedId, finishedId, job?.running, selectedMeeting]);

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

  const embedderReady = embeddingStatus?.state === "ready" && !!embeddingStatus?.model;
  const personaIndex = embeddingStatus?.personaIndex ?? { state: "empty", count: 0, message: null };
  const personaIndexReady = personaIndex.state === "ready";
  const personaIndexBusy = personaIndex.state === "indexing";
  const canAutoSelect = question.trim().length >= 3 && enabledKeys.size > 0 && !locked;

  const ensureCatalog = async () => {
    if (catalog) return;
    try {
      const res = await fetch("/api/personas");
      if (res.ok) setCatalog(await res.json());
    } catch {}
  };

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

  const applyAutoSelect = (personas) => {
    setSeats(fillSeatModels(
      personas.map((p) => ({ ...p, approved: true, model: null, variant: null })),
      llm,
      rankSuggestedModels,
    ));
    setRankOpen(false);
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
  const variantsOk = seats.every((s) => !s.variant || variantsForKey(s.model).includes(s.variant))
    && (!orchestrator.variant || variantsForKey(orchestrator.model).includes(orchestrator.variant));
  const modelsOk = filterOk && seatsMapped && variantsOk;
  const orchestratorOk = !!orchestrator.model && enabledKeys.has(orchestrator.model) && (!orchestrator.variant || variantsForKey(orchestrator.model).includes(orchestrator.variant));
  const idleOk = !job?.running;
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

  return {
    question, context, maxRounds, seats, startedId, orchestrator, features,
    setQuestion, setContext, setMaxRounds, setStartedId, setOrchestratorField, setFeature, setSeats, patchForm,
    clearForm, catalog, llm, suggestedModels, busy, error, guidance, swapIdx, setSwapIdx,
    addOpen, setAddOpen, rankOpen, setRankOpen, ranked, rankAutoSelect, rankSuggestedModels,
    job, extendInput, setExtendInput, resumeStatus, resumeParts, resumedId, resumeWarnings, resumeMeta,
    finishInfo, finishedId, finishWarnings, finishMeta, previewOpen, setPreviewOpen, previewBusy, previewError, previewData,
    extendRounds, setExtendRounds, sectionRefs,
    storedRunParticipants, readOnly, locked, meetingActive,
    scrollToSection, fillSeatModels, fillOrchestratorModel, refreshLlm,
    enabledKeys, defaultModelForSeat, embedderReady, personaIndex, personaIndexReady, personaIndexBusy, canAutoSelect,
    ensureCatalog, openAutoSelect, applyAutoSelect, openAdd, addSeat, removeSeat, selectSwap,
    toggleModel, openOrchestratorPreview, modelRowKey,
    enabledModels, variantsByKey, variantsForKey, enabledCount, totalCount,
    questionOk, roomOk, personasOk, filterOk, seatsMapped, variantsOk, modelsOk, orchestratorOk, idleOk, isFrozen,
    requirements, steps, canStart, budgetEstimate,
    doStart, doCancel, doResume, doFinish, doExtend,
  };
}
