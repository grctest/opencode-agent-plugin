#!/usr/bin/env python3
"""Deliberation-quality heuristics for Loom meeting SQLite DBs (read-only).

Heuristic, not authoritative: cheap text signals that predict where a human
should look, to be validated later against human grades.

Usage:
    python3 loom_quality.py [DB] [--out report.json] [--md report.md]
    python3 loom_quality.py --all [--csv summary.csv]
        # one summary row per *.db in .opencode/loom/meetings/

Metric groups:
  participation  balance of voice (counts, words, Gini, silent members)
  moves          deliberation moves (query/critique/evidence/vote vs plain)
  grounding      evidence grounding ([#id] cites, URLs, websearch/tool use)
  citations      citation graph (edges, validity, uncited, synthesis coverage)
  evidence       evidence ledger (per-contribution URLs, search queries, dupes)
  stances        stance evolution timeline (state patches + final states)
  calibration    probability/number claims per contribution over time
  timing         meeting span, per-round spans, inter-contribution gaps
  contestation   self-correction + dissent language, unresolved objections
  convergence    settled items, artifact decisiveness, vote/vote_response
  robustness     errors, failures, completion status
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sqlite3
import sys
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
DEFAULT_DB = None  # pass a meeting .db explicitly — no hardcoded default exists here
DEFAULT_DIR = HERE / ".opencode" / "loom" / "meetings"

CITE_RE = re.compile(r"\[#(\d+)\]")
URL_RE = re.compile(r"https?://[^\s)>\]]+")
PROB_RE = re.compile(r"~?\d+(?:\.\d+)?\s*%")
WINS_RE = re.compile(r"~?\d+(?:\.\d+)?\s*(?:GP\s+)?wins?\b", re.IGNORECASE)
SELF_CORRECT_RE = re.compile(
    r"\b(correct(?:ion|ed|s)?|retract(?:ed|ion)?|conced(?:e|ed|ing)|withdraw(?:n|ing)?|"
    r"revis(?:e|ed|ion)|mistak(?:e|en)|my error|i was wrong|fatal to|kills? (my|the)|"
    r"agree|disagree|rebut|challenge|object|dissent|concern|risk|flaw|weakness)\b",
    re.IGNORECASE,
)


def connect_ro(path: Path) -> sqlite3.Connection:
    if not path.exists():
        sys.exit(f"DB not found: {path}")
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def rows(con: sqlite3.Connection, sql: str, args: tuple = ()) -> list[dict]:
    try:
        return [dict(r) for r in con.execute(sql, args)]
    except sqlite3.Error:
        return []


def gini(xs: list[float]) -> float:
    xs = sorted(x for x in xs if x >= 0)
    n = len(xs)
    if n == 0 or sum(xs) == 0:
        return 0.0
    total = sum(xs)
    cum = sum((i + 1) * x for i, x in enumerate(xs))
    return (2 * cum) / (n * total) - (n + 1) / n


def words(s: str) -> int:
    return len(re.findall(r"\S+", s or ""))


def _parse_json_maybe(v):
    if v is None or not isinstance(v, str) or not v.strip():
        return None
    try:
        return json.loads(v)
    except (ValueError, TypeError):
        return None


def _norm_query(q: str) -> str:
    q = (q or "").lower()
    q = re.sub(r"[^a-z0-9\s]", " ", q)
    return re.sub(r"\s+", " ", q).strip()


def _ctx(text: str, m: re.Match, window: int = 36) -> str:
    s = max(0, m.start() - window)
    e = min(len(text), m.end() + window)
    return re.sub(r"\s+", " ", text[s:e]).strip()


def evaluate(con: sqlite3.Connection) -> dict:
    meetings = rows(con, "SELECT * FROM meetings ORDER BY created_at")
    if not meetings:
        return {"error": "no meetings table rows"}
    m = meetings[0]
    mid = m["id"]
    parts = rows(con, "SELECT * FROM participants WHERE meeting_id=? ORDER BY id", (mid,))
    contribs = rows(con, "SELECT * FROM contributions WHERE meeting_id=? ORDER BY round, id", (mid,))
    rounds_rows = rows(con, "SELECT * FROM rounds WHERE meeting_id=? ORDER BY round", (mid,))
    audits = rows(con, "SELECT * FROM tool_audit WHERE meeting_id=? ORDER BY round, id", (mid,))
    orch = rows(con, "SELECT * FROM orchestrator_messages WHERE meeting_id=? ORDER BY id", (mid,))
    patches = rows(con, "SELECT * FROM state_patches WHERE meeting_id=? ORDER BY round, participant_id, version", (mid,))
    # `turn_requests` was dropped in schema v14->v15 — this DB may or may not
    # still carry it. Guard explicitly (schema-aware, no silent swallow).
    con2 = None
    schema = 0
    try:
        schema = con.execute("PRAGMA user_version").fetchone()[0] or 0
    except sqlite3.Error:
        pass
    if schema >= 1 and schema < 15:
        treqs = rows(con, "SELECT * FROM turn_requests WHERE meeting_id=? ORDER BY id", (mid,))
    else:
        treqs = []
    arts = rows(con, "SELECT * FROM artifacts WHERE meeting_id=?", (mid,))
    mets = rows(con, "SELECT * FROM meeting_metrics WHERE meeting_id=?", (mid,))
    aerrs = rows(con, "SELECT * FROM agent_errors WHERE meeting_id=?", (mid,))
    elogs = rows(con, "SELECT * FROM error_log WHERE meeting_id=?", (mid,))
    art = arts[0] if arts else {}
    met = mets[0] if mets else {}

    # ---- participation ----
    per_p: dict[str, dict] = {}
    for p in parts:
        cs = [c for c in contribs if c["participant_id"] == p["id"]]
        w = sum(words(c.get("content") or "") for c in cs)
        rounds_active = sorted({c["round"] for c in cs})
        per_p[p["id"]] = {
            "name": p.get("name"), "tier": p.get("category") or p.get("tier"), "status": p.get("status"),
            "n": len(cs), "words": w,
            "avg_words": round(w / len(cs), 1) if cs else 0,
            "rounds_active": rounds_active,
        }
    counts = [v["n"] for v in per_p.values()]
    word_counts = [v["words"] for v in per_p.values()]
    participation = {
        "n_participants": len(parts),
        "n_contributions": len(contribs),
        "per_participant": per_p,
        "count_min_max_ratio": round(min(counts) / max(counts), 3) if counts and max(counts) else 0,
        "count_gini": round(gini([float(x) for x in counts]), 3),
        "words_gini": round(gini([float(x) for x in word_counts]), 3),
        "silent_participants": [pid for pid, v in per_p.items() if v["n"] == 0],
    }

    # ---- moves ----
    by_type: dict[str, int] = {}
    for c in contribs:
        by_type[c.get("type", "?")] = by_type.get(c.get("type", "?"), 0) + 1
    n = max(len(contribs), 1)
    interactive = sum(by_type.get(t, 0) for t in
                      ("query_response", "critique_response", "evidence_response",
                       "perspective_response", "summoned_response", "vote_response"))
    _rws = rows(con, "SELECT COUNT(*) c FROM rounds WHERE meeting_id=? AND summary<>''", (mid,))
    rounds_with_summaries = _rws[0]["c"] if _rws else 0
    moves = {
        "by_type": by_type,
        "interactive_share": round(interactive / n, 3),
        "critique_share": round((by_type.get("critique_response", 0)) / n, 3),
        "query_share": round((by_type.get("query_response", 0)) / n, 3),
        "vote_responses": by_type.get("vote_response", 0),
        "passes": sum(1 for c in contribs if c.get("type") == "pass"),
        "turn_requests": len(treqs),
        "rounds_with_summaries": rounds_with_summaries,
    }

    # ---- grounding ----
    cites = sum(len(CITE_RE.findall(c.get("content") or "")) for c in contribs)
    urls = URL_RE.findall(" ".join(c.get("content") or "" for c in contribs))
    domains = sorted({urlparse(u).netloc.lower() for u in urls if urlparse(u).netloc})
    websearches = sum(1 for a in audits if a.get("tool") == "websearch")
    ws_by_p: dict[str, int] = {}
    for a in audits:
        if a.get("tool") == "websearch":
            ws_by_p[a["participant_id"]] = ws_by_p.get(a["participant_id"], 0) + 1
    grounding = {
        "cite_marks_total": cites,
        "cite_marks_per_contrib": round(cites / n, 2),
        "contribs_with_cite": sum(1 for c in contribs if CITE_RE.search(c.get("content") or "")),
        "urls_total": len(urls),
        "url_domains": domains,
        "tool_calls_total": len(audits),
        "websearch_total": websearches,
        "websearch_by_participant": ws_by_p,
        "state_patches": len(patches),
        "participants_with_state_patch": len({p.get("participant_id") for p in patches}),
    }

    # ---- citations: full citation graph ----
    contrib_ids = {c["id"] for c in contribs}
    id_to_part = {c["id"]: c["participant_id"] for c in contribs}
    edges: list[dict] = []
    for c in contribs:
        for t in CITE_RE.findall(c.get("content") or ""):
            edges.append({"from": c["id"], "to": int(t),
                          "by": c["participant_id"], "round": c["round"]})
    cited_targets = {e["to"] for e in edges}
    invalid = sorted({e["to"] for e in edges if e["to"] not in contrib_ids})
    uncited = sorted(i for i in contrib_ids if i not in cited_targets)
    self_cites = sum(1 for e in edges
                     if e["to"] in id_to_part and id_to_part[e["to"]] == e["by"])
    # synthesis coverage: which contribution ids surface in round summaries
    # and artifact text fields (content/decisions/open_questions)?
    # NOTE: artifacts.dissent was removed from the schema alongside the legacy
    # challenge/dissent contribution TYPES (see P16 in the analysis doc). The
    # "## Dissenting Views" section survives inside artifacts.content, so dissent
    # is measured from the prose, not from a dedicated column.
    synth_text = " ".join(
        [(r.get("summary") or "") for r in rounds_rows] +
        [(art.get(k) or "") for k in
         ("content", "decisions", "action_items", "open_questions")
         ] if art else [])
    synth_covered = sorted({int(t) for t in CITE_RE.findall(synth_text)
                            if int(t) in contrib_ids})
    citations = {
        "edges_total": len(edges),
        "edges": edges,
        "unique_targets": len(cited_targets),
        "invalid_targets": invalid,
        "uncited_contributions": uncited,
        "uncited_count": len(uncited),
        "self_cites": self_cites,
        "synthesis_covered": synth_covered,
        "synthesis_coverage": round(len(synth_covered) / max(len(contrib_ids), 1), 3),
    }

    # ---- evidence: URL ledger + search-query ledger ----
    url_ledger = [{"id": c["id"], "round": c["round"],
                   "participant_id": c["participant_id"],
                   "urls": URL_RE.findall(c.get("content") or "")}
                  for c in contribs]
    url_ledger = [u for u in url_ledger if u["urls"]]
    domain_counts: dict[str, int] = {}
    for u in url_ledger:
        for url in u["urls"]:
            host = urlparse(url).netloc.lower()
            if host:
                domain_counts[host] = domain_counts.get(host, 0) + 1
    queries: list[dict] = []
    for a in audits:
        if a.get("tool") != "websearch":
            continue
        inp = _parse_json_maybe(a.get("input")) or {}
        queries.append({"participant_id": a["participant_id"], "round": a["round"],
                        "query": inp.get("query", "") if isinstance(inp, dict) else "",
                        "created_at": a.get("created_at")})
    seen: dict[str, int] = {}
    dup_groups: dict[str, int] = {}
    for q in queries:
        nq = _norm_query(q["query"])
        q["normalized"] = nq
        if nq in seen:
            dup_groups[nq] = dup_groups.get(nq, 1) + 1
        seen[nq] = seen.get(nq, 0) + 1
    non_search = {}
    for a in audits:
        if a.get("tool") != "websearch":
            non_search[a.get("tool")] = non_search.get(a.get("tool"), 0) + 1
    evidence = {
        "url_ledger": url_ledger,
        "contribs_with_urls": len(url_ledger),
        "domain_counts": dict(sorted(domain_counts.items(),
                                      key=lambda kv: -kv[1])),
        "queries": queries,
        "duplicate_query_groups": len(dup_groups),
        "duplicate_queries": dup_groups,
        "searches_per_contribution": round(websearches / n, 2),
        "non_search_tools": non_search,
    }

    # ---- stances: evolution timeline from state patches ----
    stance_timeline = []
    for p in patches:
        st = (_parse_json_maybe(p.get("patch_json")) or {}).get("stance", "")
        stance_timeline.append({
            "participant_id": p.get("participant_id"), "round": p.get("round"),
            "version": p.get("version"),
            "contribution_id": p.get("contribution_id"),
            "stance": (st or "")[:400],
        })
    final_stances = {}
    for p in parts:
        st = (_parse_json_maybe(p.get("state_json")) or {}).get("stance", "")
        final_stances[p["id"]] = (st or "")[:400]
    stances = {
        "timeline": stance_timeline,
        "final": final_stances,
    }

    # ---- calibration: number claims over time ----
    claims = []
    for c in contribs:
        text = c.get("content") or ""
        found = ([f"{m.group(0)} ‹{_ctx(text, m)}›" for m in PROB_RE.finditer(text)] +
                 [f"{m.group(0)} ‹{_ctx(text, m)}›" for m in WINS_RE.finditer(text)])
        if found:
            claims.append({"id": c["id"], "round": c["round"],
                           "participant_id": c["participant_id"],
                           "claims": found[:12], "n_claims": len(found)})
    calibration = {
        "contribs_with_number_claims": len(claims),
        "claims": claims,
    }

    # ---- timing ----
    def _ts(s):
        try:
            from datetime import datetime
            return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return None
    contrib_times = [(c["id"], _ts(c.get("created_at"))) for c in contribs]
    contrib_times = [(i, t) for i, t in contrib_times if t]
    gaps = [(contrib_times[i][0],
             round((contrib_times[i][1] - contrib_times[i - 1][1]).total_seconds()))
            for i in range(1, len(contrib_times))]
    round_spans = {}
    for r in rounds_rows:
        cs = [c for c in contribs if c["round"] == r["round"]]
        ts = [_ts(c.get("created_at")) for c in cs]
        ts = [t for t in ts if t]
        if ts:
            round_spans[r["round"]] = {
                "n": len(cs),
                "span_s": round((max(ts) - min(ts)).total_seconds()),
            }
    m_start, m_end = _ts(m.get("created_at")), _ts(m.get("updated_at"))
    timing = {
        "meeting_span_s": round((m_end - m_start).total_seconds())
        if m_start and m_end else None,
        "round_spans": round_spans,
        "median_gap_s": sorted(g[1] for g in gaps)[len(gaps) // 2] if gaps else None,
        "max_gap_s": max((g[1] for g in gaps), default=None),
        "max_gap_after_id": max(gaps, key=lambda g: g[1])[0] if gaps else None,
    }

    # ---- contestation ----
    contest_hits = sum(len(SELF_CORRECT_RE.findall(c.get("content") or "")) for c in contribs)
    counters = {}
    try:
        counters = json.loads(met.get("counters") or "{}")
    except (ValueError, AttributeError):
        pass
    quality = counters.get("quality", {}) if isinstance(counters, dict) else {}
    dissent_len = 0
    if art:
        dissent_len = len(art.get("dissent") or "")
        if not dissent_len:
            # column removed from schema — measure the prose section instead
            sec = re.search(r"^##\s*Dissenting Views\s*$(.*?)(?=^##\s|\Z)",
                            art.get("content") or "", re.M | re.S)
            if sec:
                dissent_len = len(sec.group(1).strip())
    # NOTE: `unresolved_objections` / `total_objections` were removed from the
    # DB — keyword-based objection detection is gone and the orchestrator now
    # judges dissent itself. Contestation is measured from the transcript plus
    # the artifact's `## Dissenting Views` prose, which is the only record of it.
    contestation = {
        "contest_language_hits": contest_hits,
        "contest_hits_per_contrib": round(contest_hits / n, 2),
        "dissent_source": "column" if (art and art.get("dissent")) else
                          ("prose:## Dissenting Views" if dissent_len else "none"),
        "dissent_chars": dissent_len,
    }

    # ---- convergence ----
    try:
        settled = json.loads(m.get("settled_items") or "[]")
        n_settled = len(settled) if isinstance(settled, list) else 0
    except (ValueError, AttributeError):
        n_settled, settled = 0, []
    convergence = {
        "status": m.get("status"),
        "rounds_done": m.get("round"),
        "max_rounds": m.get("max_rounds"),
        "completed_all_rounds": (m.get("round") or 0) >= (m.get("max_rounds") or 0),
        "settled_items": n_settled,
        "artifact_present": bool(art),
        "decisions_chars": len(art.get("decisions") or "") if art else 0,
        "open_questions_chars": len(art.get("open_questions") or "") if art else 0,
        "confidence_text": (art.get("confidence") or "")[:300] if art else "",
        "votes_held": quality.get("votes_held"),
    }

    # ---- robustness ----
    robustness = {
        "agent_errors": len(aerrs),
        "error_log": len(elogs),
        "failed_participants": [p["id"] for p in parts if p.get("status") == "failed"],
        "duration_ms": met.get("duration_ms"),
        "orchestrator_summaries": sum(1 for o in orch if o.get("msg_type") == "summary"),
    }

    return {
        "meeting_id": mid,
        "question": (m.get("question") or "")[:200],
        "participation": participation,
        "moves": moves,
        "grounding": grounding,
        "citations": citations,
        "evidence": evidence,
        "stances": stances,
        "calibration": calibration,
        "timing": timing,
        "contestation": contestation,
        "convergence": convergence,
        "robustness": robustness,
    }


def flat_row(rep: dict) -> dict:
    """One CSV-friendly row per meeting for cross-meeting comparison."""
    if "error" in rep:
        return {"meeting_id": rep.get("meeting_id", "?"), "error": rep["error"]}
    p, mv, g, ct, cv, rb = (rep["participation"], rep["moves"], rep["grounding"],
                            rep["contestation"], rep["convergence"], rep["robustness"])
    ci = rep.get("citations", {})
    ev = rep.get("evidence", {})
    tm = rep.get("timing", {})
    cal = rep.get("calibration", {})
    return {
        "meeting_id": rep["meeting_id"],
        "question": rep["question"],
        "status": cv["status"],
        "rounds": f"{cv['rounds_done']}/{cv['max_rounds']}",
        "n_participants": p["n_participants"],
        "n_contributions": p["n_contributions"],
        "count_min_max_ratio": p["count_min_max_ratio"],
        "count_gini": p["count_gini"],
        "words_gini": p["words_gini"],
        "interactive_share": mv["interactive_share"],
        "critique_share": mv["critique_share"],
        "query_share": mv["query_share"],
        "turn_requests": mv["turn_requests"],
        "cites_per_contrib": g["cite_marks_per_contrib"],
        "contribs_with_cite": g["contribs_with_cite"],
        "urls_total": g["urls_total"],
        "websearch_total": g["websearch_total"],
        "state_patches": g["state_patches"],
        "contest_hits_per_contrib": ct["contest_hits_per_contrib"],
        "settled_items": cv["settled_items"],
        "votes_held": cv["votes_held"],
        "agent_errors": rb["agent_errors"],
        "error_log": rb["error_log"],
        "invalid_cites": len(ci.get("invalid_targets", [])),
        "uncited_contribs": ci.get("uncited_count"),
        "synth_coverage": ci.get("synthesis_coverage"),
        "contribs_with_urls": ev.get("contribs_with_urls"),
        "dup_query_groups": ev.get("duplicate_query_groups"),
        "searches_per_contrib": ev.get("searches_per_contribution"),
        "number_claim_contribs": len(cal.get("claims", [])),
        "meeting_span_s": tm.get("meeting_span_s"),
        "median_gap_s": tm.get("median_gap_s"),
    }


def to_markdown(rep: dict) -> str:
    out = io.StringIO()
    w = out.write
    w(f"# Deliberation quality: {rep.get('meeting_id')}\n\n")
    w(f"Q: {rep.get('question')}\n\n")
    p, mv, g, ct, cv, rb = (rep["participation"], rep["moves"], rep["grounding"],
                            rep["contestation"], rep["convergence"], rep["robustness"])
    ci, ev = rep.get("citations", {}), rep.get("evidence", {})
    st, cal, tm = rep.get("stances", {}), rep.get("calibration", {}), rep.get("timing", {})
    w(f"- status: {cv['status']} rounds {cv['rounds_done']}/{cv['max_rounds']} "
      f"settled_items={cv['settled_items']} votes_held={cv['votes_held']}\n")
    w(f"- participation: n={p['n_contributions']} across {p['n_participants']} "
      f"(min/max={p['count_min_max_ratio']}, gini_n={p['count_gini']}, gini_w={p['words_gini']})"
      f"{' SILENT: ' + ','.join(p['silent_participants']) if p['silent_participants'] else ''}\n")
    w(f"- moves: {mv['by_type']} interactive_share={mv['interactive_share']} "
      f"turn_requests={mv['turn_requests']}\n")
    w(f"- grounding: {g['cite_marks_total']} [#id] cites "
      f"({g['cite_marks_per_contrib']}/contrib, in {g['contribs_with_cite']} contribs), "
      f"{g['urls_total']} urls [{', '.join(g['url_domains'][:8])}], "
      f"websearch={g['websearch_total']} {g['websearch_by_participant']}, "
      f"state_patches={g['state_patches']}\n")
    w(f"- contestation: {ct['contest_hits_per_contrib']} contest-hits/contrib, "
      f"dissent_chars={ct['dissent_chars']} (source: {ct['dissent_source']})\n")
    w(f"- robustness: agent_errors={rb['agent_errors']} error_log={rb['error_log']} "
      f"failed={rb['failed_participants']} duration_ms={rb['duration_ms']}\n\n")
    w("## Per participant\n\n| id | name | tier | n | words | avg | rounds |\n|---|---|---|---|---|---|---|\n")
    for pid, v in p["per_participant"].items():
        w(f"| {pid} | {v['name']} | {v['tier']} | {v['n']} | {v['words']} | "
          f"{v['avg_words']} | {','.join(map(str, v['rounds_active']))} |\n")
    w("\n## Citations\n\n")
    w(f"- {ci.get('edges_total')} [#id] edges → {ci.get('unique_targets')} unique targets; "
      f"invalid={ci.get('invalid_targets') or 'none'}; self-cites={ci.get('self_cites')}\n")
    w(f"- uncited contributions ({ci.get('uncited_count')}): {ci.get('uncited_contributions')}\n")
    w(f"- synthesis coverage: {ci.get('synthesis_coverage')} "
      f"(covered: {ci.get('synthesis_covered')})\n\n")
    w("## Evidence\n\n")
    w(f"- {ev.get('contribs_with_urls')} contribs carry URLs; "
      f"top domains: {list((ev.get('domain_counts') or {}).items())[:8]}\n")
    w(f"- {len(ev.get('queries', []))} websearch queries, "
      f"{ev.get('duplicate_query_groups')} duplicate groups; "
      f"{ev.get('searches_per_contribution')} searches/contrib\n")
    if ev.get("duplicate_queries"):
        for q, k in list(ev["duplicate_queries"].items())[:5]:
            w(f"  - {k}x: {q[:100]}\n")
    w(f"- non-search tools: {ev.get('non_search_tools')}\n\n")
    w("## Stance timeline\n\n")
    for s in st.get("timeline", []):
        w(f"- {s['participant_id']} R{s['round']} v{s['version']} "
          f"(#{s['contribution_id']}): {(s['stance'] or '')[:160]}\n")
    w("\n## Number claims (calibration trail)\n\n")
    for c in cal.get("claims", []):
        w(f"- [#{c['id']}] {c['participant_id']} R{c['round']}: "
          f"{'; '.join(c['claims'][:4])}\n")
    w("\n## Timing\n\n")
    w(f"- meeting span: {tm.get('meeting_span_s')}s; rounds: "
      f"{ {k: v['span_s'] for k, v in (tm.get('round_spans') or {}).items()} }; "
      f"median gap {tm.get('median_gap_s')}s, max gap {tm.get('max_gap_s')}s "
      f"(after #{tm.get('max_gap_after_id')})\n")
    w("\n> Heuristics only — validate against human grades before trusting.\n")
    return out.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser(description="Score Loom deliberation quality (read-only).")
    ap.add_argument("db", nargs="?", default=None, help="path to meeting .db")
    ap.add_argument("--all", action="store_true",
                    help=f"score every *.db in {DEFAULT_DIR}")
    ap.add_argument("--out", default=None, help="write full JSON report")
    ap.add_argument("--md", default=None, help="write markdown report (single-DB mode)")
    ap.add_argument("--csv", default=None, help="write flat CSV summary (--all mode)")
    args = ap.parse_args()

    if args.all:
        dbs = sorted(DEFAULT_DIR.glob("*.db"))
        if not dbs:
            sys.exit(f"no .db files in {DEFAULT_DIR}")
        reps = []
        for db in dbs:
            try:
                with connect_ro(db) as con:
                    rep = evaluate(con)
            except sqlite3.Error as e:
                rep = {"meeting_id": db.stem, "question": "", "error": str(e)}
            rep["_db"] = db.name
            reps.append(rep)
        table = [flat_row(r) for r in reps]
        if args.csv:
            with open(args.csv, "w", newline="", encoding="utf-8") as f:
                wr = csv.DictWriter(f, fieldnames=list(table[0].keys()))
                wr.writeheader()
                wr.writerows(table)
            print(f"wrote {args.csv} ({len(table)} meetings)")
        elif args.out:
            Path(args.out).write_text(json.dumps(reps, indent=2, ensure_ascii=False, default=str),
                                       encoding="utf-8")
            print(f"wrote {args.out} ({len(reps)} meetings)")
        else:
            print(json.dumps(table, indent=2, ensure_ascii=False, default=str))
        return

    if not args.db:
        sys.exit("usage: script <meeting.db> [options] — no default DB exists; pass a meeting .db path")
    with connect_ro(Path(args.db)) as con:
        rep = evaluate(con)
    if args.md:
        Path(args.md).write_text(to_markdown(rep), encoding="utf-8")
        print(f"wrote {args.md}")
    if args.out:
        Path(args.out).write_text(json.dumps(rep, indent=2, ensure_ascii=False, default=str),
                                   encoding="utf-8")
        print(f"wrote {args.out}")
    if not args.out and not args.md:
        print(to_markdown(rep))


if __name__ == "__main__":
    main()
