export const TIER_ORDER = ["principal", "senior", "mid", "civilian", "junior"];

export const TIER_META = {
  principal: {
    label: "Principal",
    badge: "bg-violet-500/15 text-violet-700 border-violet-500/30 dark:text-violet-300",
    dot: "bg-violet-500",
    blurb: "Top authority — sets direction and writes the final synthesis",
  },
  senior: {
    label: "Senior",
    badge: "bg-blue-500/15 text-blue-700 border-blue-500/30 dark:text-blue-300",
    dot: "bg-blue-500",
    blurb: "Senior authority — names irreversible commitments and mitigations",
  },
  mid: {
    label: "Mid",
    badge: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-300",
    dot: "bg-emerald-500",
    blurb: "Experienced practitioner — challenges and refines proposals",
  },
  civilian: {
    label: "Civilian",
    badge: "bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-300",
    dot: "bg-amber-500",
    blurb: "Generalist — outside perspective, no specialist blinders",
  },
  junior: {
    label: "Junior",
    badge: "bg-slate-500/15 text-slate-600 border-slate-500/30 dark:text-slate-300",
    dot: "bg-slate-400",
    blurb: "Fresh eyes — questions assumptions others take for granted",
  },
};

// Uniform persona avatar look: every persona gets the same eyes + mouth —
// only the seeded colours/geometry (from `name`) differ. Module-level so the
// object identities are stable and Avatar's useMemo isn't defeated.
export const AVATAR_EXPRESSION = { eye: "normal", mouth: "open" };
export const AVATAR_COLORS = ["#92A1C6", "#146A7C", "#F0AB3D", "#C271B4", "#C20D90"];

export function initials(name) {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
