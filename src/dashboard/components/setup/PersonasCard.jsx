import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../ui/card.tsx";
import { Badge } from "../ui/badge.tsx";
import { Avatar } from "../Avatar.tsx";
import { Button } from "../ui/button.tsx";
import { Label } from "../ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { CATEGORY_META, AVATAR_EXPRESSION, AVATAR_COLORS } from "../tierMeta.jsx";

export function PersonasCard({
  seats, embedderReady, personaIndexReady, personaIndexBusy, personaIndex,
  openAutoSelect, canAutoSelect, filterOk, busy, openAdd, isFrozen, readOnly,
  enabledModels, variantsForKey, setSeats, setSwapIdx, removeSeat, sectionRef,
}) {
  return (
    <Card ref={sectionRef}>
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
  );
}
