import { Alert, AlertTitle, AlertDescription } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";

export function StatusBanners({
  readOnly, meetingActive, job, doCancel,
  startedId, resumedId, resumeMeta, resumeWarnings,
  finishedId, finishMeta, finishWarnings,
  selectedMeeting, resumeStatus, resumeParts, doResume, busy,
  finishInfo, doFinish, error, guidance,
}) {
  return (
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
  );
}
