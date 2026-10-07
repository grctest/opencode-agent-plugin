/**
 * SetupTab — composition root for the deliberation setup flow.
 * State + server actions live in `setup/useSetupState.js`;
 * sections live in sibling `setup/*Card.jsx` components.
 */
import { Button } from "./ui/button.tsx";
import { PersonaPickerDialog } from "./PersonaPickerDialog.jsx";
import { RoomSelectionDialog } from "./RoomSelectionDialog.jsx";
import { OrchestratorPreviewDialog } from "./OrchestratorPreviewDialog.jsx";
import { StepHeader } from "./setup/StepHeader.jsx";
import { QuestionCard } from "./setup/QuestionCard.jsx";
import { ModelsCard } from "./setup/ModelsCard.jsx";
import { PersonasCard } from "./setup/PersonasCard.jsx";
import { CapabilitiesCard } from "./setup/CapabilitiesCard.jsx";
import { OrchestratorCard } from "./setup/OrchestratorCard.jsx";
import { ExtendCard } from "./setup/ExtendCard.jsx";
import { StatusBanners } from "./setup/StatusBanners.jsx";
import { StartBar } from "./setup/StartBar.jsx";
import { useSetupState } from "./setup/useSetupState.js";

export function SetupTab({ selectedMeeting, onStarted, meetingState, meetingParticipants, embeddingStatus }) {
  const s = useSetupState({ selectedMeeting, onStarted, meetingState, meetingParticipants, embeddingStatus });
  const registerSection = (key) => (el) => { s.sectionRefs.current[key] = el; };
  const questionDisabled = s.isFrozen || s.readOnly;

  return (
    <div className="flex flex-col gap-5 max-w-4xl pb-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <StepHeader steps={s.steps} />
        <Button variant="ghost" size="sm" onClick={s.clearForm} disabled={s.isFrozen || s.readOnly} title={s.isFrozen ? "Locked while a deliberation is running" : s.readOnly ? "Locked — this deliberation's configuration is read-only" : "Reset the setup form to empty (running deliberations are unaffected)"}>
          Clear form
        </Button>
      </div>

      <StatusBanners
        readOnly={s.readOnly} meetingActive={s.meetingActive} job={s.job} doCancel={s.doCancel}
        startedId={s.startedId} resumedId={s.resumedId} resumeMeta={s.resumeMeta} resumeWarnings={s.resumeWarnings}
        finishedId={s.finishedId} finishMeta={s.finishMeta} finishWarnings={s.finishWarnings}
        selectedMeeting={selectedMeeting} resumeStatus={s.resumeStatus} resumeParts={s.resumeParts}
        doResume={s.doResume} busy={s.busy} finishInfo={s.finishInfo} doFinish={s.doFinish}
        error={s.error} guidance={s.guidance}
      />

      <QuestionCard
        question={s.question} setQuestion={s.setQuestion}
        context={s.context} setContext={s.setContext}
        maxRounds={s.maxRounds} setMaxRounds={s.setMaxRounds}
        disabled={questionDisabled} sectionRef={registerSection("question")}
      />

      <ModelsCard
        llm={s.llm} totalCount={s.totalCount} enabledCount={s.enabledCount}
        busy={s.busy} isFrozen={s.isFrozen} readOnly={s.readOnly}
        refreshLlm={s.refreshLlm} modelRowKey={s.modelRowKey} toggleModel={s.toggleModel}
        sectionRef={registerSection("models")}
      />

      <PersonasCard
        seats={s.seats} embedderReady={s.embedderReady}
        personaIndexReady={s.personaIndexReady} personaIndexBusy={s.personaIndexBusy} personaIndex={s.personaIndex}
        openAutoSelect={s.openAutoSelect} canAutoSelect={s.canAutoSelect} filterOk={s.filterOk}
        busy={s.busy} openAdd={s.openAdd} isFrozen={s.isFrozen} readOnly={s.readOnly}
        enabledModels={s.enabledModels} variantsForKey={s.variantsForKey}
        setSeats={s.setSeats} setSwapIdx={s.setSwapIdx} removeSeat={s.removeSeat}
        sectionRef={registerSection("personas")}
      />

      <CapabilitiesCard
        features={s.features} setFeature={s.setFeature}
        isFrozen={s.isFrozen} readOnly={s.readOnly}
        sectionRef={registerSection("capabilities")}
      />

      <OrchestratorCard
        orchestrator={s.orchestrator} features={s.features}
        setFeature={s.setFeature} setOrchestratorField={s.setOrchestratorField} patchForm={s.patchForm}
        enabledModels={s.enabledModels} variantsForKey={s.variantsForKey}
        openOrchestratorPreview={s.openOrchestratorPreview} previewBusy={s.previewBusy}
        isFrozen={s.isFrozen} readOnly={s.readOnly}
        sectionRef={registerSection("orchestrator")}
      />

      <ExtendCard
        selectedMeeting={selectedMeeting}
        extendInput={s.extendInput} setExtendInput={s.setExtendInput}
        extendRounds={s.extendRounds} setExtendRounds={s.setExtendRounds}
        doExtend={s.doExtend} busy={s.busy} job={s.job}
      />

      <StartBar
        budgetEstimate={s.budgetEstimate} requirements={s.requirements}
        scrollToSection={s.scrollToSection} canStart={s.canStart}
        readOnly={s.readOnly} busy={s.busy} doStart={s.doStart}
      />

      {s.swapIdx !== null && s.seats[s.swapIdx] && (
        <PersonaPickerDialog
          open={s.swapIdx !== null}
          seatNumber={s.swapIdx + 1}
          seatCategory={s.seats[s.swapIdx].category ?? s.seats[s.swapIdx].tier}
          currentName={s.seats[s.swapIdx].name}
          seatedNames={s.seats.filter((_, j) => j !== s.swapIdx).map((x) => x.name)}
          catalog={s.catalog}
          onSelect={(persona, category) => s.selectSwap(s.swapIdx, persona, category)}
          onOpenChange={(v) => { if (!v) s.setSwapIdx(null); }}
        />
      )}
      <OrchestratorPreviewDialog
        open={s.previewOpen}
        busy={s.previewBusy}
        error={s.previewError}
        preview={s.previewData}
        onOpenChange={s.setPreviewOpen}
      />
      {s.addOpen && (
        <PersonaPickerDialog
          mode="add"
          open={s.addOpen}
          seatNumber={s.seats.length + 1}
          seatCategory={null}
          currentName={null}
          seatedNames={s.seats.map((x) => x.name)}
          catalog={s.catalog}
          onSelect={(persona, category) => s.addSeat(persona, category)}
          onOpenChange={(v) => { if (!v) s.setAddOpen(false); }}
        />
      )}
      <RoomSelectionDialog
        open={s.rankOpen}
        question={s.question}
        catalog={s.catalog}
        ranked={s.ranked}
        busy={s.busy === "preview"}
        error={s.error}
        autoSelectCount={s.rankAutoSelect}
        onApply={s.applyAutoSelect}
        onOpenChange={(v) => { if (!v) s.setRankOpen(false); }}
      />
    </div>
  );
}
