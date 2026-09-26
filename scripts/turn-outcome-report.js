// Turn-outcome report (audit P3-B): aggregates the per-turn signals the
// executor already records into release-grade prompt metrics.
//
// Usage:
//   node scripts/turn-outcome-report.js <meeting.db> [more.db ...] [--check]
//
// --check exits 1 when a floor is violated (CI gate for prompt regressions):
//   never_attempted ≤ 10% (of non-exempt primary turns)
//   tool error rate   ≤ 15%
//   prose in 350–700  ≥ 50%  (contract band; informational otherwise)
import { DatabaseSync } from "node:sqlite";

const FLOORS = { neverAttemptedMax: 0.1, toolErrorMax: 0.15, proseInBandMin: 0.5 };
const WORD_BAND = [350, 700];

function words(s) {
  return String(s ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function reportOne(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare(
      "SELECT id, participant_id, round, type, content, tool_calls, prompt_context FROM contributions",
    ).all();
    const outcome = {};
    const nonExempt = new Set(["applied", "never_attempted", "rejected", "unverified", "skipped_deadline"]);
    let nonExemptCount = 0;
    let cited = 0;
    let proseTurns = 0;
    let proseInBand = 0;
    let toolTotal = 0;
    let toolErrors = 0;
    let passes = 0;
    let toolOnly = 0;
    for (const r of rows) {
      let pc = null;
      try { pc = r.prompt_context ? JSON.parse(r.prompt_context) : null; } catch {}
      const o = pc?.state_patch_outcome ?? pc?.state_patch?.outcome ?? null;
      if (o) outcome[o] = (outcome[o] ?? 0) + 1;
      if (o && nonExempt.has(o)) nonExemptCount++;
      if (r.type === "pass") passes++;
      if (typeof r.content === "string" && r.content.includes("[TOOL-ONLY TURN")) toolOnly++;
      if (r.type === "contribution" && typeof r.content === "string" && !r.content.includes("[TOOL-ONLY TURN")) {
        proseTurns++;
        if (/\[#\d+\]/.test(r.content)) cited++;
        const w = words(r.content);
        if (w >= WORD_BAND[0] && w <= WORD_BAND[1]) proseInBand++;
      }
      try {
        const calls = r.tool_calls ? JSON.parse(r.tool_calls) : [];
        for (const t of (Array.isArray(calls) ? calls : [])) {
          toolTotal++;
          if (t.status === "error" || t.metadata?.validationFailed || t.metadata?.persistenceFailed || t.metadata?.error) toolErrors++;
        }
      } catch {}
    }
    return {
      path, turns: rows.length, outcome, nonExemptCount, passes, toolOnly,
      cited, proseTurns, proseInBand, toolTotal, toolErrors,
    };
  } finally {
    db.close();
  }
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const paths = args.filter((a) => a !== "--check" && !a.startsWith("--"));
  if (paths.length === 0) {
    console.error("usage: node scripts/turn-outcome-report.js <meeting.db> [...] [--check]");
    process.exit(2);
  }
  const agg = { turns: 0, outcome: {}, nonExemptCount: 0, passes: 0, toolOnly: 0, cited: 0, proseTurns: 0, proseInBand: 0, toolTotal: 0, toolErrors: 0 };
  for (const p of paths) {
    const r = reportOne(p);
    console.log(`== ${r.path} (${r.turns} contributions)`);
    console.log(`   patch outcomes: ${JSON.stringify(r.outcome)}`);
    agg.turns += r.turns;
    for (const [k, v] of Object.entries(r.outcome)) agg.outcome[k] = (agg.outcome[k] ?? 0) + v;
    agg.nonExemptCount += r.nonExemptCount;
    agg.passes += r.passes; agg.toolOnly += r.toolOnly;
    agg.cited += r.cited; agg.proseTurns += r.proseTurns; agg.proseInBand += r.proseInBand;
    agg.toolTotal += r.toolTotal; agg.toolErrors += r.toolErrors;
  }
  const neverRate = agg.nonExemptCount ? (agg.outcome.never_attempted ?? 0) / agg.nonExemptCount : 0;
  const toolErrRate = agg.toolTotal ? agg.toolErrors / agg.toolTotal : 0;
  const citeRate = agg.proseTurns ? agg.cited / agg.proseTurns : 0;
  const bandRate = agg.proseTurns ? agg.proseInBand / agg.proseTurns : 0;
  console.log(`-- aggregate over ${paths.length} meeting(s), ${agg.turns} contributions`);
  console.log(`   patch outcomes: ${JSON.stringify(agg.outcome)}`);
  console.log(`   never_attempted (non-exempt): ${(neverRate * 100).toFixed(1)}%  [floor ≤ ${(FLOORS.neverAttemptedMax * 100).toFixed(0)}%]`);
  console.log(`   tool error rate: ${(toolErrRate * 100).toFixed(1)}% of ${agg.toolTotal} calls  [floor ≤ ${(FLOORS.toolErrorMax * 100).toFixed(0)}%]`);
  console.log(`   citation density: ${(citeRate * 100).toFixed(1)}% of ${agg.proseTurns} prose turns carry [#id]`);
  console.log(`   prose in 350–700 band: ${(bandRate * 100).toFixed(1)}%  [floor ≥ ${(FLOORS.proseInBandMin * 100).toFixed(0)}%]`);
  console.log(`   passes: ${agg.passes}, tool-only turns: ${agg.toolOnly}`);
  if (check) {
    const violations = [];
    if (neverRate > FLOORS.neverAttemptedMax) violations.push(`never_attempted ${(neverRate * 100).toFixed(1)}% > floor`);
    if (toolErrRate > FLOORS.toolErrorMax) violations.push(`tool error rate ${(toolErrRate * 100).toFixed(1)}% > floor`);
    if (agg.proseTurns > 0 && bandRate < FLOORS.proseInBandMin) violations.push(`prose in-band ${(bandRate * 100).toFixed(1)}% < floor`);
    if (violations.length > 0) {
      console.error(`CHECK FAILED: ${violations.join("; ")}`);
      process.exit(1);
    }
    console.log("CHECK PASSED");
  }
}

main();
