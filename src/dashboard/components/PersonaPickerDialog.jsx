import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { List } from "react-window";
import Fuse from "fuse.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog.tsx";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Avatar } from "./Avatar.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import { CATEGORY_ORDER, CATEGORY_META, AVATAR_EXPRESSION, AVATAR_COLORS } from "./tierMeta.jsx";

const ROW_HEIGHT = 104;

function PersonaRow({ index, style, ariaAttributes, items, currentName, seatedNames, onSelect }) {
  const entry = items[index];
  if (!entry) return null;
  const { persona: p, category } = entry;
  const meta = CATEGORY_META[category] ?? CATEGORY_META.mid;
  const isCurrent = p.name === currentName;
  const isSeated = !isCurrent && (seatedNames ?? []).includes(p.name);
  const tags = (p.tags ?? []).slice(0, 3);
  const inner = (
    <>
                  <div className="shrink-0 self-center" aria-hidden="true">
                    <Avatar name={p.name} extra="Picker" size={36} title={p.name} expression={AVATAR_EXPRESSION} colors={AVATAR_COLORS} />
                  </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <div className="flex items-center gap-2">
          <strong className="truncate text-sm">{p.name}</strong>
          <Badge variant="outline" className={"shrink-0 " + meta.badge} title={meta.blurb}>{meta.label}</Badge>
          {p.custom === true && <Badge variant="secondary" className="shrink-0 text-[11px]">Custom</Badge>}
          {isCurrent && <Badge variant="secondary" className="shrink-0 text-[11px]">Current seat</Badge>}
          {isSeated && <Badge variant="secondary" className="shrink-0 text-[11px]">Already in room</Badge>}
        </div>
        <div className="flex gap-1 overflow-hidden">
          {tags.map((t) => <Badge key={t} variant="secondary" className="shrink-0 text-[10px] font-normal">{t}</Badge>)}
        </div>
        <p className="truncate text-xs text-muted-foreground" title={p.agenda}>{p.agenda}</p>
      </div>
      <div className="flex shrink-0 items-center">
        {isCurrent ? (
          <span className="text-xs font-medium text-muted-foreground">✓</span>
        ) : (
          <span
            aria-hidden="true"
            className="text-sm font-medium text-primary opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            Select →
          </span>
        )}
      </div>
    </>
  );
  return (
    <div style={style} {...ariaAttributes}>
      <div className="h-full pb-2">
        {isCurrent || isSeated ? (
          <div
            className={
              "flex h-full gap-3 overflow-hidden rounded-xl border p-2.5 " +
              (isCurrent ? "border-primary/60 bg-primary/[0.05]" : "border-border bg-card opacity-60")
            }
            title={isSeated ? "This persona already holds another seat" : undefined}
          >
            {inner}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onSelect(p, category)}
            aria-label={`Seat ${p.name} (${meta.label}) in this chair`}
            className="group flex h-full w-full cursor-pointer gap-3 overflow-hidden rounded-xl border border-border bg-card p-2.5 text-left transition-all duration-150 hover:-translate-y-px hover:border-primary/60 hover:bg-primary/[0.05] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:translate-y-0 active:scale-[0.99]"
          >
            {inner}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * High-quality persona browser for swapping a deliberation seat.
 * Search + category filter buttons + virtualized persona list (react-window
 * v2 — only visible rows mount, so all 89 personas stay smooth). The dialog
 * itself is height-capped so it can never overflow the viewport. Cross-category
 * picks are allowed (the seat takes the persona's category; per-seat model
 * pickers follow).
 */
export function PersonaPickerDialog({ open, seatNumber, seatCategory, currentName, currentSeat, seatedNames, catalog, onSelect, onOpenChange, mode = "swap" }) {
  const isAdd = mode === "add";
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState(isAdd ? "all" : "seat");
  const listWrapRef = useRef(null);
  const [listHeight, setListHeight] = useState(360);

  // Measure the list viewport so the virtualized List gets exact pixels —
  // this is what guarantees the dialog can never exceed the viewport.
  useEffect(() => {
    if (!open) return;
    const el = listWrapRef.current;
    if (!el) return;
    const update = () => setListHeight(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // Reset filters each time the dialog opens for a seat
  useEffect(() => {
    if (open) {
      setQuery("");
      setCategoryFilter(isAdd ? "all" : "seat");
    }
  }, [open, seatNumber, isAdd]);

  // Every group present in the catalog, bundled categories first. User-saved
  // folders (e.g. `custom/`) are appended so their personas are browsable —
  // without this, the fixed CATEGORY_ORDER loop would silently hide them.
  const groupKeys = useMemo(() => {
    const categories = catalog?.categories ?? catalog?.tiers ?? {}; // legacy alias: accept legacy tiers key
    const extras = Object.keys(categories).filter((k) => !CATEGORY_ORDER.includes(k)).sort();
    return [...CATEGORY_ORDER, ...extras];
  }, [catalog]);

  const counts = useMemo(() => {
    const categories = catalog?.categories ?? catalog?.tiers ?? {}; // legacy alias: accept legacy tiers key
    const per = {};
    let total = 0;
    let custom = 0;
    for (const t of groupKeys) {
      const arr = categories[t] ?? [];
      per[t] = arr.length;
      total += arr.length;
      for (const p of arr) if (p?.custom === true) custom += 1;
    }
    return { per, total, custom };
  }, [catalog, groupKeys]);

  // In-scope pool for the active filter (catalog order preserved). The
  // "custom" filter is origin-based: it spans every folder and keeps only
  // personas flagged custom by the loader.
  const scopeItems = useMemo(() => {
    const categories = catalog?.categories ?? catalog?.tiers ?? {}; // legacy alias: accept legacy tiers key
    const wanted = categoryFilter === "all" || categoryFilter === "custom"
      ? groupKeys
      : categoryFilter === "seat" && !isAdd
        ? [seatCategory]
        : [categoryFilter];
    const out = [];
    for (const t of wanted) {
      for (const p of categories[t] ?? []) {
        if (categoryFilter === "custom" && p?.custom !== true) continue;
        out.push({ persona: p, category: p.category ?? p.tier ?? t }); // legacy alias: normalize legacy tier field
      }
    }
    return out;
  }, [catalog, categoryFilter, seatCategory, isAdd, groupKeys]);

  // Swap keeps a seated persona selectable even when its file is gone from
  // disk (deleted, moved, failed to load): a meeting never reads personas
  // back from files once seated, so removing the source must not strand or
  // auto-reset the seat. Rendered as a stub row above the list.
  const currentMissing = useMemo(() => {
    if (isAdd || !catalog || !currentSeat || !currentName) return false;
    const categories = catalog.categories ?? catalog.tiers ?? {};
    return Object.values(categories).every(
      (arr) => !(arr ?? []).some((p) => p?.name === currentName),
    );
  }, [catalog, isAdd, currentSeat, currentName]);

  // Fuzzy index over persona content: name matches rank highest, then tags,
  // expertise, then agenda. ignoreLocation so matches deep in long agendas
  // still score well. Rebuilt only when the category scope changes — not per keystroke.
  const fuse = useMemo(() => new Fuse(scopeItems, {
    includeScore: true,
    ignoreLocation: true,
    threshold: 0.4,
    keys: [
      { name: "persona.name", weight: 2 },
      { name: "persona.tags", weight: 1.5 },
      { name: "persona.expertise", weight: 1.2 },
      { name: "persona.agenda", weight: 1 },
    ],
  }), [scopeItems]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return scopeItems;
    return fuse.search(q).map((r) => r.item);
  }, [fuse, scopeItems, query]);

  const rowKey = useCallback(
    (index, data) => {
      const entry = data.items[index];
      return entry ? `${entry.category}:${entry.persona.name}` : index;
    },
    [],
  );

  const seatMeta = CATEGORY_META[seatCategory] ?? CATEGORY_META.mid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[88vh] max-w-2xl flex-col overflow-hidden"
        aria-label={`Choose persona for seat ${seatNumber}`}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{isAdd ? "Add persona to the room" : `Choose persona for Seat ${seatNumber}`}</DialogTitle>
          <DialogDescription>
            {isAdd ? (
              <>Browsing all categories — the new seat takes the persona's category.</>
            ) : (
              <>Seat category is <strong>{seatMeta.label}</strong> — browsing it by default, but you may pick any category (the seat takes the persona's category).</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex shrink-0 flex-col gap-1.5">
            <Label htmlFor="loom-persona-search">Search personas</Label>
            <Input
              id="loom-persona-search"
              placeholder="Name, expertise, tag… e.g. security, pricing, ethics"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="flex shrink-0 flex-wrap gap-1.5" role="group" aria-label="Filter by category">
            {!isAdd && (
              <Button
                size="sm"
                variant={categoryFilter === "seat" ? "default" : "outline"}
                onClick={() => setCategoryFilter("seat")}
                title={`Only ${seatMeta.label} category`}
              >
                {seatMeta.label} ({counts.per[seatCategory] ?? 0})
              </Button>
            )}
            <Button
              size="sm"
              variant={categoryFilter === "all" ? "default" : "outline"}
              onClick={() => setCategoryFilter("all")}
            >
              All ({counts.total})
            </Button>
            {counts.custom > 0 && (
              <Button
                size="sm"
                variant={categoryFilter === "custom" ? "default" : "outline"}
                onClick={() => setCategoryFilter("custom")}
                title="Personas you saved from a generation (or dropped into the loom personas folder)"
              >
                Custom ({counts.custom})
              </Button>
            )}
            {CATEGORY_ORDER.filter((t) => t !== seatCategory).map((t) => (
              <Button
                key={t}
                size="sm"
                variant={categoryFilter === t ? "default" : "outline"}
                onClick={() => setCategoryFilter(t)}
              >
                {(CATEGORY_META[t] ?? {}).label ?? t} ({counts.per[t] ?? 0})
              </Button>
            ))}
          </div>

          <p className="shrink-0 text-xs text-muted-foreground" aria-live="polite">
            {results.length} of {counts.total} personas
            {query.trim() && <> matching “{query.trim()}”</>}
          </p>

          {currentMissing && currentSeat && (
            <div className="flex shrink-0 items-start gap-3 rounded-md border border-dashed bg-muted/40 p-3" data-testid="current-seat-stub">
              <div className="shrink-0 self-center" aria-hidden="true">
                <Avatar name={currentSeat.name} extra="Picker" size={36} title={currentSeat.name} expression={AVATAR_EXPRESSION} colors={AVATAR_COLORS} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <strong className="truncate text-sm">{currentSeat.name}</strong>
                  <Badge variant="outline" className={"shrink-0 " + (CATEGORY_META[currentSeat.category] ?? CATEGORY_META.mid).badge}>
                    {(CATEGORY_META[currentSeat.category] ?? CATEGORY_META.mid).label}
                  </Badge>
                  <Badge variant="secondary" className="shrink-0 text-[11px]">Not in catalog anymore</Badge>
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {currentSeat.agenda || currentSeat.persona}
                </p>
                <p className="text-xs text-muted-foreground">
                  Kept as the current seat — the meeting reads seated personas from its own records, not from files. Pick a row below to replace it.
                </p>
              </div>
            </div>
          )}

          <div ref={listWrapRef} className="min-h-[220px] flex-1">
            {!catalog && <p className="p-3 text-sm text-muted-foreground">Loading personas…</p>}
            {catalog && results.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">
                No personas match. Try a different search or category filter.
              </p>
            )}
            {catalog && results.length > 0 && listHeight > 0 && (
              <List
                rowComponent={PersonaRow}
                rowCount={results.length}
                rowHeight={ROW_HEIGHT}
                rowKey={rowKey}
                rowProps={{ items: results, currentName, seatedNames, onSelect }}
                overscanCount={4}
                style={{ height: listHeight, width: "100%" }}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
