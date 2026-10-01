import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { List } from "react-window";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog.tsx";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Alert } from "./ui/alert.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { Avatar } from "./Avatar.tsx";
import { TIER_ORDER, TIER_META, AVATAR_EXPRESSION, AVATAR_COLORS } from "./tierMeta.jsx";
import { similarityOf, similarityPercent } from "../../composer/similarity.js";

const ROW_HEIGHT = 68;

/** Mirrors the composer's L2 distance back to cosine similarity for display. */
export { similarityOf, similarityPercent };

/**
 * react-window v2 injects `{index, style, ariaAttributes}` plus everything in
 * `rowProps`. It does NOT pass itemCount/itemData, so `items` comes from
 * rowProps and must be destructured alongside the injected props.
 */
function RankRow({ index, style, ariaAttributes, items, selectedNames, onToggle }) {
  const entry = items[index];
  if (!entry) return null;
  const { persona, rank, distance } = entry;
  const meta = TIER_META[persona.tier] ?? TIER_META.mid;
  const isSelected = selectedNames.has(persona.name);
  const pct = similarityPercent(distance);
  return (
    <div style={style} {...ariaAttributes}>
      <button
        type="button"
        onClick={() => onToggle(persona.name)}
        aria-pressed={isSelected}
        aria-label={`${isSelected ? "Deselect" : "Select"} ${persona.name}, ${meta.label}, ${pct}% similar`}
        className={
          "flex h-full w-full items-center gap-3 rounded-lg border px-2.5 text-left transition-colors " +
          (isSelected
            ? "border-primary/60 bg-primary/[0.06]"
            : "border-border bg-card hover:border-primary/40 hover:bg-muted/50")
        }
      >
        <span className="w-8 shrink-0 text-center font-mono text-xs text-muted-foreground tabular-nums">
          {rank}
        </span>
        <span className="shrink-0" aria-hidden="true">
          <Avatar name={persona.name} extra="Rank" size={30} title={persona.name} expression={AVATAR_EXPRESSION} colors={AVATAR_COLORS} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <strong className="truncate text-sm">{persona.name}</strong>
            <Badge variant="outline" className={"shrink-0 " + meta.badge} title={meta.blurb}>
              {meta.label}
            </Badge>
          </span>
          <span className="truncate text-xs text-muted-foreground" title={persona.agenda}>
            {persona.agenda}
          </span>
        </span>
        <span className="flex w-24 shrink-0 flex-col items-end gap-1">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{pct}%</span>
          <span className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span
              className="block h-full rounded-full bg-primary/70"
              style={{ width: `${Math.max(2, similarityOf(distance) * 100)}%` }}
            />
          </span>
        </span>
        <span
          className={
            "flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs " +
            (isSelected ? "border-primary bg-primary text-primary-foreground" : "border-border text-transparent")
          }
          aria-hidden="true"
        >
          ✓
        </span>
      </button>
    </div>
  );
}

/**
 * Auto-select dialog.
 *
 * The server ranks the ENTIRE persona catalog against the question and hands
 * back one ordered list. This dialog's job is to make that ordering legible and
 * correctable: the top N are pre-selected, every persona is listed in distance
 * order, and the tier buttons hide tiers the user does not want without
 * reordering anything.
 *
 * Two invariants worth stating, because both are easy to break later:
 *
 * 1. Filtering only ever REMOVES rows. It never re-sorts. The whole point of
 *    the list is that it is the similarity ordering; a filter that re-sorted
 *    by tier would be showing a different claim about relevance.
 * 2. Selection is local until `onApply`. Toggling tiers does not silently drop
 *    already-selected personas from the result — a user who hides a tier is
 *    looking away from it, not evicting seats. The footer says so explicitly
 *    when a hidden tier holds selected seats.
 */
export function RoomSelectionDialog({
  open,
  question,
  catalog,
  ranked,
  busy,
  error,
  autoSelectCount = 3,
  onApply,
  onOpenChange,
}) {
  const [selected, setSelected] = useState(() => new Set());
  const [hiddenTiers, setHiddenTiers] = useState(() => new Set());
  const listWrapRef = useRef(null);
  const [listHeight, setListHeight] = useState(380);

  useEffect(() => {
    if (!open) return;
    const el = listWrapRef.current;
    if (!el) return;
    const update = () => setListHeight(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, busy]);

  // Seed selection from the server's top slice every time the dialog opens, so
  // reopening it never inherits a previous question's choices.
  useEffect(() => {
    if (!open) return;
    const seed = (ranked ?? []).slice(0, autoSelectCount).map((r) => r.name);
    setSelected(new Set(seed));
    setHiddenTiers(new Set());
  }, [open, autoSelectCount, ranked]);

  // Join the ranking to the catalog for display text. `ranked` carries only
  // {name, tier, distance} — the full persona bodies come from /api/personas.
  const items = useMemo(() => {
    const tiers = catalog?.tiers ?? {};
    const byName = new Map();
    for (const t of TIER_ORDER) {
      for (const p of tiers[t] ?? []) byName.set(p.name, { ...p, tier: t });
    }
    const out = [];
    (ranked ?? []).forEach((row, i) => {
      const persona = byName.get(row.name) ?? { name: row.name, tier: row.tier, agenda: "", tags: [] };
      out.push({ persona, rank: i + 1, distance: row.distance });
    });
    return out;
  }, [catalog, ranked]);

  const counts = useMemo(() => {
    const per = {};
    for (const t of TIER_ORDER) per[t] = items.filter((it) => it.persona.tier === t).length;
    return per;
  }, [items]);

  const visible = useMemo(() => items.filter((it) => !hiddenTiers.has(it.persona.tier)), [items, hiddenTiers]);

  const selectedNames = useMemo(() => new Set(selected), [selected]);
  const hiddenSelected = useMemo(
    () => items.filter((it) => hiddenTiers.has(it.persona.tier) && selected.has(it.persona.name)).map((it) => it.persona.name),
    [items, hiddenTiers, selected],
  );

  const toggleTier = useCallback((tier) => {
    setHiddenTiers((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  }, []);

  const togglePersona = useCallback((name) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const resetToTop = useCallback(() => {
    setSelected(new Set(items.slice(0, autoSelectCount).map((it) => it.persona.name)));
  }, [items, autoSelectCount]);

  const rowKey = useCallback(
    (index, data) => {
      const entry = data.items[index];
      return entry ? entry.persona.name : index;
    },
    [],
  );

  const selectedInOrder = useMemo(
    () => items.filter((it) => selected.has(it.persona.name)).map((it) => it.persona),
    [items, selected],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[88vh] max-w-3xl flex-col overflow-hidden"
        aria-label="Select personas for this deliberation"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>Select personas</DialogTitle>
          <DialogDescription>
            All {items.length} personas ranked by similarity to your question, closest first. The top{" "}
            {autoSelectCount} are selected — change the selection, or hide a seniority you don't want.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex shrink-0 flex-wrap gap-1.5" role="group" aria-label="Hide or show a seniority">
            {TIER_ORDER.map((t) => {
              const meta = TIER_META[t] ?? TIER_META.mid;
              const hidden = hiddenTiers.has(t);
              return (
                <Button
                  key={t}
                  size="sm"
                  variant={hidden ? "outline" : "default"}
                  onClick={() => toggleTier(t)}
                  aria-pressed={!hidden}
                  className={hidden ? "opacity-50" : ""}
                  title={hidden ? `Show ${meta.label} personas` : `Hide all ${meta.label} personas`}
                >
                  {meta.label}
                  <span className="ml-1 font-mono text-[11px] tabular-nums opacity-70">{counts[t] ?? 0}</span>
                </Button>
              );
            })}
          </div>

          <div ref={listWrapRef} className="min-h-0 flex-1">
            {busy && (
              <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Spinner /> Ranking {catalog ? `${items.length} ` : ""}personas…
              </p>
            )}
            {!busy && error && (
              <Alert variant="destructive">
                <span>{error}</span>
              </Alert>
            )}
            {!busy && !error && visible.length === 0 && (
              <p className="py-8 text-sm text-muted-foreground">
                No personas in the seniorities you have shown — turn a filter back on above.
              </p>
            )}
            {!busy && !error && visible.length > 0 && listHeight > 0 && (
              <List
                rowComponent={RankRow}
                rowCount={visible.length}
                rowHeight={ROW_HEIGHT}
                rowKey={rowKey}
                rowProps={{ items: visible, selectedNames, onToggle: togglePersona }}
                overscanCount={6}
                style={{ height: listHeight, width: "100%", overflowY: "auto" }}
              />
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0 items-center justify-between gap-3 sm:justify-between">
          <div className="flex min-w-0 flex-col items-start gap-0.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {selected.size} selected
              {selectedInOrder.length > 0 && (
                <span className="font-normal text-muted-foreground">
                  {" "}— {selectedInOrder.slice(0, 4).map((p) => p.name).join(", ")}
                  {selectedInOrder.length > 4 && ` +${selectedInOrder.length - 4} more`}
                </span>
              )}
            </span>
            {hiddenSelected.length > 0 && (
              <span>
                {hiddenSelected.length} selected persona{hiddenSelected.length === 1 ? " is" : "s are"} in a hidden
                seniority — still included.
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={resetToTop} disabled={busy || !!error}>
              Reset to top {autoSelectCount}
            </Button>
            <Button size="sm" onClick={() => onApply(selectedInOrder)} disabled={busy || !!error || selected.size === 0}>
              Add {selected.size} to room
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}