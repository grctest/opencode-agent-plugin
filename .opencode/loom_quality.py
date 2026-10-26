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
# HERE is already the .opencode directory, so the meetings live in
# HERE/loom/meetings — the extra ".opencode" segment pointed at a path that
# does not exist, so `--all` scored nothing.
DEFAULT_DIR = HERE / "loom" / "meetings"

CITE_RE = re.compile(r"\[#(\d+)\]")
URL_RE = re.compile(r"https?://[^\s)>\]]+")
PROB_RE = re.compile(r"~?\d+(?:\.\d+)?\s*%")
# Numeric claims that carry a COUNT — a number with a countable unit. The
# vocabulary is domain-general: the F1 counts (wins, races, podiums) sit
# beside the engineering ones (tests, requests, endpoints, failures), so the
# calibration signal is not blind outside a single meeting's subject.
COUNT_UNITS = (
    r"win|wins|race|races|podium|podiums|pole|poles|game|games|match|matches|"
    r"season|seasons|test|tests|row|rows|request|requests|quer(?:y|ies)|"
    r"endpoint|endpoints|field|fields|bug|bugs|error|errors|failure|failures|"
    r"user|users|session|sessions|ticket|tickets|task|tasks|commit|commits|"
    r"branch|branches|file|files|module|modules|service|services|deploy|deploys|"
    r"incident|incidents|vote|votes|agent|agents|seat|seats|option|options|"
    r"risk|risks|concern|concerns|hypothes(?:is|es)|assumption|assumptions|"
    r"idea|ideas|fix|fixes|regression|regressions|migration|migrations|"
    r"retr(?:y|ies)|timeout|timeouts"
)
COUNT_CLAIM_RE = re.compile(rf"~?\d+(?:\.\d+)?\s*(?:{COUNT_UNITS})\b", re.IGNORECASE)
# Self-correction language (narrow): the speaker revises or withdraws their
# own prior claim. Kept separate from generic disagreement so the metric
# measures revision, not mere pushback.
SELF_CORRECT_RE = re.compile(
    r"\b(correct(?:ion|ed|s)?|retract(?:ed|ion)?|conced(?:e|ed|ing)|withdraw(?:n|ing)?|"
    r"revis(?:e|ed|ion)|mistak(?:e|en)|my error|i was wrong|fatal to|kills? (my|the))\b",
    re.IGNORECASE,
)
# Disagreement language: the speaker pushes back on another holder's claim.
# Distinct from self-correction so a meeting can be high-disagreement but
# low-revision (or vice versa) — both are useful, different signals.
DISAGREE_RE = re.compile(
    r"\b(disagree(?:ment)?|rebut(?:tal)?|challenge(?:d|s)?|object(?:ion|s)?|"
    r"dissent(?:s|ed|ing)?|contest(?:ed|s|ing)?|push(?:es)? back|counter(?:s|ed|ing)?)\b",
    re.IGNORECASE,
)
# Risk/concern language: often persona-vocabulary (a risk-focused seat will
# score high here without any actual dissent). Reported separately and meant
# to be baselined against the persona's category guidance, not counted as
# disagreement.
RISK_LANG_RE = re.compile(
    r"\b(risk(?:s|y)?|concern(?:s|ed|ing)?|flaw(?:s|ed)?|weakness(?:es)?|"
    r"assumption(?:s)?|vulnerabilit(?:y|ies)|caveat(?:s)?)\b",
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
    # Mirror src/evidence-cache.js normalizeQuery exactly: lowercase,
    # replace any non-word, non-space char with a space, collapse whitespace.
    # \w is unicode-aware in both JS (default for str replace) and Python
    # (re.UNICODE is the default for str patterns), so accented/underscore
    # tokens agree across the two tools.
    q = (q or "").lower()
    q = re.sub(r"[^\w\s]", " ", q)
    return re.sub(r"\s+", " ", q).strip()


def _ctx(text: str, m: re.Match, window: int = 36) -> str:
    s = max(0, m.start() - window)
    e = min(len(text), m.end() + window)
    return re.sub(r"\s+", " ", text[s:e]).strip()


def evaluate(con: sqlite3.Connection, db_path: str | None = None) -> dict:
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
    # counters.quality is computed by the system during the meeting; parse once
    # here so every downstream section (moves, timing, contestation) can read it.
    try:
        _counters = json.loads(met.get("counters") or "{}")
    except (ValueError, AttributeError):
        _counters = {}
    quality = _counters.get("quality", {}) if isinstance(_counters, dict) else {}

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
        "mechanism_mix": quality.get("mechanism_mix"),
        "round_budget": quality.get("round_budget"),
        "tool_calls_max_in_a_turn": (quality.get("tool_calls") or {}).get("max_in_a_turn"),
        "participation_ratio": quality.get("participation_ratio"),
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
    uncited_all = sorted(i for i in contrib_ids if i not in cited_targets)
    # Type-aware uncited: ballots are unciteable by contract (no [#id] expected
    # on a vote row) and the terminal contribution has no following speaker to
    # cite it. Report them separately so "uncited" means "genuinely ignored".
    ballot_ids = {c["id"] for c in contribs if c.get("type") == "vote_response"}
    terminal_id = max(contribs, key=lambda c: (c.get("created_at") or ""))["id"] if contribs else None
    uncited = sorted(i for i in uncited_all if i not in ballot_ids and i != terminal_id)
    uncited_ballots = sorted(i for i in uncited_all if i in ballot_ids)
    uncited_terminal = sorted(i for i in uncited_all if i == terminal_id)
    self_cites = sum(1 for e in edges
                     if e["to"] in id_to_part and id_to_part[e["to"]] == e["by"])
    # synthesis coverage: which contribution ids surface in round summaries
    # and artifact text fields (content/decisions/open_questions)?
    # NOTE: artifacts.dissent was removed from the schema alongside the legacy
    # challenge/dissent contribution TYPES (see P16 in the analysis doc). The
    # "## Dissenting Views" section survives inside artifacts.content, so dissent
    # is measured from the prose, not from a dedicated column.
    synth_text_parts = [(r.get("summary") or "") for r in rounds_rows]
    if art:
        synth_text_parts += [(art.get(k) or "") for k in
                             ("content", "decisions", "action_items", "open_questions")]
    synth_text = " ".join(synth_text_parts)
    synth_covered = sorted({int(t) for t in CITE_RE.findall(synth_text)
                            if int(t) in contrib_ids})
    citations = {
        "edges_total": len(edges),
        "edges": edges,
        "unique_targets": len(cited_targets),
        "invalid_targets": invalid,
        "uncited_contributions": uncited,
        "uncited_count": len(uncited),
        "uncited_ballots": uncited_ballots,
        "uncited_terminal": uncited_terminal,
        "self_cites": self_cites,
        "synthesis_covered": synth_covered,
        "synthesis_coverage": round(len(synth_covered) / max(len(contrib_ids), 1), 3),
    }

    # ---- engagement ledger (N8): per-contribution peer citation status ----
    # Computed here so v1-schema DBs (no artifacts.engagement column) can be
    # audited. Mirrors the JS computeEngagementLedger semantics: a contribution
    # is "plain" if it is not a sub-agent response; it is "uncited" if no other
    # contribution cites it via [#id].
    #
    # W8 honesty exemptions (doc 1 §8 / final doc W8):
    #   - terminal exemption: a plain contribution that is the LAST contribution
    #     of the meeting cannot be cited by anyone afterward — flagging it
    #     "peer-uncited" overstates the engagement hole. It is reported
    #     separately (excluded) with its id retained for transparency.
    #   - engaged-via-peer-row: a peer row may engage a primary contribution's
    #     thread without a direct [#id] (e.g. a solicited critique of that
    #     holder's position). Any peer row whose prompt_context names the
    #     holder, or that cites the id, counts as indirect engagement; it is
    #     surfaced as a SEPARATE flag set (never merged into the raw count).
    plain_types = {"contribution"}
    plain_rows = [c for c in contribs if c.get("type") in plain_types]
    plain_ids = [c["id"] for c in plain_rows]
    cited_targets_set = {e["to"] for e in edges}
    raw_uncited_ids = [i for i in plain_ids if i not in cited_targets_set]
    # Terminal exemption: the last contribution overall.
    last_id = (contribs[-1]["id"] if contribs else None)
    terminal_id = last_id if (last_id in raw_uncited_ids) else None
    peer_uncited_ids_excl = [i for i in raw_uncited_ids if i != terminal_id]
    # Engaged-via-peer-row candidates: raw-uncited ids whose holder received a
    # peer response in the same meeting (solicited critique/perspective/evidence).
    peer_holder_ids = set()
    for c in contribs:
        pc = _parse_json_maybe(c.get("prompt_context")) or {}
        if isinstance(pc, dict) and pc.get("source_participant_id"):
            peer_holder_ids.add((pc.get("source_participant_id"), c["participant_id"]))
    id_to_row = {c["id"]: c for c in contribs}
    engaged_via_peer_row: dict[int, bool] = {}
    for i in raw_uncited_ids:
        row = id_to_row.get(i)
        holder = row.get("participant_id") if row else None
        engaged_via_peer_row[i] = any(h == holder for h, _p in peer_holder_ids)
    self_cite_count = sum(1 for e in edges
                          if e["to"] in id_to_part and id_to_part[e["to"]] == e["by"])
    engagement_ledger = {
        "plain_contributions": len(plain_ids),
        "peer_uncited": len(raw_uncited_ids),
        "peer_uncited_terminal_excluded": len(peer_uncited_ids_excl),
        "uncited_plain_ids": raw_uncited_ids,
        "uncited_plain_ids_terminal_excluded": peer_uncited_ids_excl,
        "terminal_id": terminal_id,
        "terminal_exempt": terminal_id is not None,
        "engaged_via_peer_row": sorted([i for i, ok_ in engaged_via_peer_row.items() if ok_]),
        "self_cites": self_cite_count,
        "coverage": round(len(synth_covered) / max(len(contrib_ids), 1), 3),
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
                 [f"{m.group(0)} ‹{_ctx(text, m)}›" for m in COUNT_CLAIM_RE.finditer(text)])
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
    # Clocks: four different "how long did this take" definitions coexist.
    #   duration_ms_canonical  = meeting_metrics.duration_ms (last write; includes
    #                            persona-proposal pass + report write)
    #   meeting_span_s         = created_at -> updated_at (legacy; pre-proposals)
    #   span_phase_s           = round_budget.final_span_ms / 1000 (phase-aware)
    #   round_spans[..].span_s = contribution timestamps only (no setup/post)
    # All four are meaningful; none is "the" answer. Export all, label them.
    duration_ms = met.get("duration_ms")
    span_to_update_s = round((m_end - m_start).total_seconds()) if (m_start and m_end) else None
    # round_budget lives in counters.quality (may be empty on legacy DBs)
    try:
        _counters_for_budget = json.loads(met.get("counters") or "{}")
    except (ValueError, AttributeError):
        _counters_for_budget = {}
    _rb = (_counters_for_budget.get("quality") or {}).get("round_budget") or {}
    span_phase_s = (round(_rb["final_span_ms"] / 1000.0)
                    if _rb.get("final_span_ms") is not None else None)
    timing = {
        "duration_ms_canonical": duration_ms,
        "meeting_span_s": span_to_update_s,   # legacy alias, kept for compat
        "span_to_update_s": span_to_update_s,
        "span_phase_s": span_phase_s,
        "round_spans": round_spans,
        "median_gap_s": sorted(g[1] for g in gaps)[len(gaps) // 2] if gaps else None,
        "max_gap_s": max((g[1] for g in gaps), default=None),
        "max_gap_into_id": max(gaps, key=lambda g: g[1])[0] if gaps else None,
        # Back-compat alias (old name was misleading; value is the gap into that id).
        "max_gap_after_id": max(gaps, key=lambda g: g[1])[0] if gaps else None,
    }

    # ---- contestation ----
    self_correction_hits = sum(len(SELF_CORRECT_RE.findall(c.get("content") or "")) for c in contribs)
    disagreement_hits = sum(len(DISAGREE_RE.findall(c.get("content") or "")) for c in contribs)
    risk_language_hits = sum(len(RISK_LANG_RE.findall(c.get("content") or "")) for c in contribs)
    contest_hits = self_correction_hits + disagreement_hits
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
        "self_correction_hits": self_correction_hits,
        "disagreement_hits": disagreement_hits,
        "risk_language_hits": risk_language_hits,
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
    # Inline peer errors: sub-agent (loom_query/vote/summon) failures that are
    # returned inside the tool payload rather than as agent_errors/error_log.
    # These are invisible to every aggregate unless we scan the payloads.
    inline_peer_errors: list[dict] = []
    for a in audits:
        out = a.get("output")
        if not isinstance(out, str) or not out.strip():
            continue
        try:
            j = json.loads(out)
        except (ValueError, TypeError):
            continue
        # walk for embedded error fields
        def _walk(o, path=""):
            if isinstance(o, dict):
                for k, v in o.items():
                    if k in ("error", "errors") and v:
                        inline_peer_errors.append({
                            "audit_id": a.get("id"), "tool": a.get("tool"),
                            "participant_id": a.get("participant_id"),
                            "path": f"{path}.{k}".strip("."), "error": str(v)[:300],
                        })
                    _walk(v, f"{path}.{k}")
            elif isinstance(o, list):
                for i, v in enumerate(o):
                    _walk(v, f"{path}[{i}]")
        _walk(j)
    robustness = {
        "agent_errors": len(aerrs),
        "error_log": len(elogs),
        "failed_participants": [p["id"] for p in parts if p.get("status") == "failed"],
        "duration_ms": met.get("duration_ms"),
        "orchestrator_summaries": sum(1 for o in orch if o.get("msg_type") == "summary"),
        "inline_peer_errors": inline_peer_errors,
        "inline_peer_error_count": len(inline_peer_errors),
    }

    # ---- sub-agents: per-mode counts, conformity, inline failures ----
    subagent_modes: dict[str, int] = {}
    subagent_targets: dict[str, int] = {}
    subagent_conformity = {"evidence_structure": 0, "ballot_token": 0,
                          "position_line": 0, "critique_close": 0, "total_responses": 0,
                          "total_evidence_responses": 0, "total_vote_responses": 0,
                          "total_perspective_responses": 0, "total_critique_responses": 0}
    # per-mode counts come from tool_audit (authoritative for invocation)
    for a in audits:
        if a.get("tool") != "loom_query":
            continue
        inp = _parse_json_maybe(a.get("input")) or {}
        out = _parse_json_maybe(a.get("output")) or {}
        queries = inp.get("queries") if isinstance(inp, dict) else None
        responses = out.get("responses") if isinstance(out, dict) else None
        if isinstance(queries, list):
            for q in queries:
                mname = (q.get("mode") if isinstance(q, dict) else None) or "unknown"
                subagent_modes[mname] = subagent_modes.get(mname, 0) + 1
                tgt = (q.get("target") if isinstance(q, dict) else None)
                if tgt:
                    subagent_targets[tgt] = subagent_targets.get(tgt, 0) + 1
        if isinstance(responses, list):
            for r in responses:
                if not isinstance(r, dict):
                    continue
                # (conformity totals are computed from stored contributions below)
    # conformity is measured from the STORED contribution bodies (full text),
    # not the truncated tool_audit payloads.
    for c in contribs:
        ctype = c.get("type") or ""
        content = c.get("content") or ""
        if ctype not in ("perspective_response", "evidence_response", "critique_response",
                         "vote_response", "query_response", "summoned_response"):
            continue
        subagent_conformity["total_responses"] += 1
        _type_total_key = {"evidence_response": "total_evidence_responses",
                           "vote_response": "total_vote_responses",
                           "perspective_response": "total_perspective_responses",
                           "critique_response": "total_critique_responses"}.get(ctype)
        if _type_total_key:
            subagent_conformity[_type_total_key] = subagent_conformity.get(_type_total_key, 0) + 1
        if ctype == "evidence_response" and all(tok in content for tok in ("Finding", "Source", "Strength")):
            subagent_conformity["evidence_structure"] += 1
        if ctype == "vote_response" and "[Vote:" in content:
            subagent_conformity["ballot_token"] += 1
        if "Position:" in content:
            subagent_conformity["position_line"] += 1
        # W7 (P4/F doc d2 §8): critique mode's contract ends with
        # "**Most damaging objection:** {one sentence}" — checked against the
        # stored body like the other per-mode contracts.
        if ctype == "critique_response" and "Most damaging objection:" in content:
            subagent_conformity["critique_close"] += 1
    subagents = {
        "modes": subagent_modes,
        "targets": subagent_targets,
        "conformity": subagent_conformity,
        "inline_failures": inline_peer_errors,
        "inline_failure_count": len(inline_peer_errors),
        "retry_events": (counters.get("retry_events") if isinstance(counters, dict) else {}) or {},
    }

    # ---- summary quality: slot presence, [#N] validity, name-pairing, band ----
    summary_rows = rounds_rows
    summary_quality = {"rounds_with_summaries": len([r for r in summary_rows if (r.get("summary") or "").strip()]),
                       "per_round": []}
    for r in summary_rows:
        txt = r.get("summary") or ""
        if not txt.strip():
            summary_quality["per_round"].append({"round": r.get("round"), "has_summary": False})
            continue
        # slot presence (balanced band: Established/Settled/Contested/Evidence/Open/Next)
        slots = {}
        for slot in ("Established", "Settled", "Contested", "Evidence", "Open", "Next"):
            slots[slot] = bool(re.search(rf"^\*\*{slot}\*\*", txt, re.M) or re.search(rf"^- \*\*{slot}\*\*", txt, re.M) or re.search(rf"\b{slot}\b", txt))
        # [#N] validity
        ids = [int(x) for x in re.findall(r"\[#(\d+)\]", txt)]
        invalid = [i for i in ids if i not in contrib_ids]
        # name-pairing: at least one [#N] preceded by a capitalized name token
        paired = len(re.findall(r"[A-Z][a-z]+\s*\[#\d+\]", txt))
        # word count
        wc = len(txt.split())
        summary_quality["per_round"].append({
            "round": r.get("round"), "has_summary": True,
            "slots": slots, "slots_present": sum(1 for v in slots.values() if v),
            "cite_ids": sorted(set(ids)), "invalid_ids": invalid,
            "name_paired_cites": paired, "words": wc,
        })

    # ---- persona proposals: detect file presence (best-effort) ----
    persona_proposals = {"file_present": False, "file_path": None, "anti_patterns": 0,
                        "known_biases": 0, "proposals": 0}
    if db_path:
        try:
            pp_path = Path(db_path).parent.parent / "persona-proposals" / f"{mid}.md"
            if pp_path.exists():
                persona_proposals["file_present"] = True
                persona_proposals["file_path"] = str(pp_path)
                txt = pp_path.read_text(encoding="utf-8", errors="replace")
                persona_proposals["anti_patterns"] = txt.count("- **anti_pattern:**") or txt.lower().count("anti_pattern")
                persona_proposals["known_biases"] = txt.lower().count("known_bias")
                persona_proposals["proposals"] = txt.count("## ") 
        except Exception as e:
            persona_proposals["error"] = str(e)

    # ---- parity: report md vs artifact content (best-effort) ----
    parity = {"report_path": None, "artifact_len": len(art.get("content") or "") if art else 0,
              "report_len": None, "tails_match": None}
    if db_path:
        try:
            report_path = Path(db_path).with_suffix(".md")
            if report_path.exists():
                parity["report_path"] = str(report_path)
                report_txt = report_path.read_text(encoding="utf-8", errors="replace")
                parity["report_len"] = len(report_txt)
                art_content = (art.get("content") or "").strip() if art else ""
                # report = header + "---" + artifact content; check artifact is a
                # byte-exact suffix of the report (after the first "---" line).
                marker = "\n---\n"
                idx = report_txt.find(marker)
                if idx >= 0 and art_content:
                    tail = report_txt[idx + len(marker):].strip()
                    parity["tails_match"] = (tail == art_content)
        except Exception as e:
            parity["error"] = str(e)

    return {
        "meeting_id": mid,
        "question": (m.get("question") or "")[:200],
        "participation": participation,
        "moves": moves,
        "grounding": grounding,
        "citations": citations,
        "engagement": engagement_ledger,
        "evidence": evidence,
        "stances": stances,
        "calibration": calibration,
        "timing": timing,
        "contestation": contestation,
        "convergence": convergence,
        "robustness": robustness,
        "quality_counters": quality,
        "counters": counters,
        "subagents": subagents,
        "summary_quality": summary_quality,
        "engagement": engagement_ledger,
        "persona_proposals": persona_proposals,
        "parity": parity,
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
    if mv.get("mechanism_mix"):
        mm = mv["mechanism_mix"]
        w(f"  mechanism_mix: {mm.get('argument_shaped')}/{mm.get('decision_shaped')}/{mm.get('other')} "
          f"(arg/dec/other) decision_share={mm.get('decision_share')}\n")
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
    if ci.get("uncited_ballots"):
        w(f"  - uncited ballots (expected): {ci.get('uncited_ballots')}\n")
    if ci.get("uncited_terminal"):
        w(f"  - uncited terminal contribution (no following speaker): {ci.get('uncited_terminal')}\n")
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
    w(f"- clocks: duration_ms (canonical)={tm.get('duration_ms_canonical')} "
      f"span_phase_s={tm.get('span_phase_s')} "
      f"span_to_update_s={tm.get('span_to_update_s')} "
      f"round_spans={ {k: v['span_s'] for k, v in (tm.get('round_spans') or {}).items()} }\n")
    w(f"- median gap {tm.get('median_gap_s')}s, max gap {tm.get('max_gap_s')}s "
      f"(into #{tm.get('max_gap_into_id')})\n")

    # ---- robustness: inline peer errors ----
    sa = rep.get("subagents", {})
    iperrs = rb.get("inline_peer_errors") or []
    w("\n## Robustness (deep)\n\n")
    w(f"- agent_errors={rb['agent_errors']} error_log={rb['error_log']} "
      f"inline_peer_errors={rb.get('inline_peer_error_count', 0)}\n")
    if iperrs:
        for e in iperrs:
            w(f"  - audit #{e.get('audit_id')} {e.get('tool')} {e.get('participant_id')}: {e.get('error')}\n")
    else:
        w("  - no inline peer errors detected (whole-run scan of all tool_audit payloads)\n")

    # ---- sub-agents ----
    w("\n## Sub-agents\n\n")
    w(f"- modes: {sa.get('modes')}\n")
    w(f"- targets: {sa.get('targets')}\n")
    cf = sa.get("conformity", {})
    w(f"- conformity: total_responses={cf.get('total_responses')} "
      f"evidence_structure={cf.get('evidence_structure')} "
      f"ballot_token={cf.get('ballot_token')} "
      f"position_line={cf.get('position_line')} "
      f"critique_close={cf.get('critique_close')}\n")
    # W7: per-mode conformity ratios computed from actual per-type totals —
    # an auditor sees which per-mode contracts were met (evidence 2/2,
    # critique 1/1, ...) instead of four unrelated counters. A dimension with
    # zero instances is omitted rather than printed as 0/0.
    _ev = cf.get("evidence_structure", 0)
    _vt = cf.get("ballot_token", 0)
    _ps = cf.get("position_line", 0)
    _cr = cf.get("critique_close", 0)
    _dims = [
        ("evidence", _ev, cf.get("total_evidence_responses", 0)),
        ("ballot", _vt, cf.get("total_vote_responses", 0)),
        ("perspective-position", _ps, cf.get("total_perspective_responses", 0)),
        ("critique-close", _cr, cf.get("total_critique_responses", 0)),
    ]
    _ratios = [f"{name} {hit}/{n}" for name, hit, n in _dims if n > 0]
    _tot = cf.get("total_responses", 0) or 0
    if _tot:
        w("- per-mode conformity: " + (", ".join(_ratios) or "none") + "\n")
    w(f"- inline failures: {sa.get('inline_failure_count', 0)}\n")
    w(f"- retry events: {sa.get('retry_events')}\n")
    # W1 (P3.3) — turn-order override visibility: N overrides in the run, from
    # the durable meeting_metrics.counters.turn_order_overrides key.
    _counters_md = rep.get("counters", {})
    _too = _counters_md.get("turn_order_overrides") if isinstance(_counters_md, dict) else None
    if _too is not None:
        _too_n = sum(v for v in _too.values() if isinstance(v, (int, float))) if isinstance(_too, dict) else 0
        w(f"- turn-order overrides (loom_set_turn_order): {_too_n}\n")

    # ---- summary quality ----
    sq = rep.get("summary_quality", {})
    w("\n## Summary quality (clerk)\n\n")
    w(f"- rounds_with_summaries: {sq.get('rounds_with_summaries')}\n")
    for r in sq.get("per_round", []):
        if not r.get("has_summary"):
            w(f"  - round {r.get('round')}: (no summary)\n")
            continue
        w(f"  - round {r.get('round')}: slots={r.get('slots_present')}/6 "
          f"words={r.get('words')} cite_ids={r.get('cite_ids')} "
          f"invalid={r.get('invalid_ids') or 'none'} "
          f"name_paired_cites={r.get('name_paired_cites')}\n")

    # ---- engagement ledger ----
    eng = rep.get("engagement", {})
    w("\n## Engagement ledger (N8)\n\n")
    w(f"- plain_contributions: {eng.get('plain_contributions')} "
      f"peer_uncited: {eng.get('peer_uncited')} "
      f"self_cites: {eng.get('self_cites')} "
      f"coverage: {eng.get('coverage')}\n")
    # W8 honesty exemptions: the terminal contribution cannot be cited by a
    # peer afterwards, and a peer row may engage a holder's thread without a
    # direct [#id]. Both are surfaced separately — never merged into the raw
    # peer_uncited count.
    if eng.get("terminal_exempt"):
        w(f"- terminal exemption: [#{eng.get('terminal_id')}] is the meeting's last "
          f"contribution and cannot be cited by a peer — peer_uncited excluding it: "
          f"{eng.get('peer_uncited_terminal_excluded')} "
          f"(ids: {eng.get('uncited_plain_ids_terminal_excluded') or 'none'})\n")
    if eng.get("engaged_via_peer_row"):
        _eprs = eng.get("engaged_via_peer_row") or []
        w(f"- engaged via peer row (indirect, no direct [#id] cite): "
          f"{', '.join(f'#{i}' for i in _eprs) if isinstance(_eprs, list) else _eprs}\n")
    if eng.get("uncited_plain_ids"):
        w(f"  - uncited plain ids: {eng.get('uncited_plain_ids')}\n")

    # ---- persona proposals ----
    pp = rep.get("persona_proposals", {})
    w("\n## Persona proposals\n\n")
    w(f"- file_present: {pp.get('file_present')} path={pp.get('file_path')}\n")
    if pp.get("file_present"):
        w(f"  - anti_patterns={pp.get('anti_patterns')} known_biases={pp.get('known_biases')}\n")

    # ---- parity ----
    par = rep.get("parity", {})
    w("\n## Report ↔ artifact parity\n\n")
    w(f"- report_path: {par.get('report_path')} report_len={par.get('report_len')} "
      f"artifact_len={par.get('artifact_len')} tails_match={par.get('tails_match')}\n")

    w("\n> Heuristics only — validate against human grades before trusting.\n")
    return out.getvalue()


def verify(rep: dict, db_path: str) -> int:
    """Run golden invariants on a report; return 0 if all pass, 1 otherwise."""
    checks = []
    def check(name, cond, detail=""):
        checks.append((name, bool(cond), detail))

    ci = rep.get("citations", {})
    cv = rep.get("convergence", {})
    rb = rep.get("robustness", {})
    eng = rep.get("engagement", {})
    par = rep.get("parity", {})
    sa = rep.get("subagents", {})
    sq = rep.get("summary_quality", {})
    tm = rep.get("timing", {})

    check("coverage in [0,1]", 0 <= (ci.get("synthesis_coverage") or 0) <= 1)
    check("no invalid cite targets", not ci.get("invalid_targets"))
    check("inline_peer_errors is a list", isinstance(rb.get("inline_peer_errors"), list))
    check("inline_peer_error_count consistent",
          rb.get("inline_peer_error_count") == len(rb.get("inline_peer_errors") or []))
    if par.get("report_path"):
        check("report↔artifact tails match", par.get("tails_match") is True,
              f"tails_match={par.get('tails_match')}")
    if cv.get("artifact_present"):
        check("artifact present", True)
        check("decisions non-empty", (cv.get("decisions_chars") or 0) > 0)
    check("duration_ms_canonical present", tm.get("duration_ms_canonical") is not None)
    check("span_phase_s present", tm.get("span_phase_s") is not None)
    check("engagement ledger present", isinstance(eng, dict) and "plain_contributions" in eng)
    # W7 invariant: per-mode conformity keys present and internally consistent
    # (hits never exceed per-type totals).
    cf2 = (sa.get("conformity") if isinstance(sa, dict) else {}) or {}
    check("per-mode conformity consistent",
          "critique_close" in cf2
          and cf2.get("critique_close", 0) <= cf2.get("total_critique_responses", 0)
          and cf2.get("evidence_structure", 0) <= cf2.get("total_evidence_responses", 0)
          and cf2.get("ballot_token", 0) <= cf2.get("total_vote_responses", 0))
    # W8 invariant: the ledger exposes the terminal exemption and an
    # excluded count that never exceeds the raw one.
    check("engagement terminal exemption exposed",
          isinstance(eng, dict) and "peer_uncited_terminal_excluded" in eng
          and "engaged_via_peer_row" in eng
          and (eng.get("peer_uncited_terminal_excluded") or 0)
              <= (eng.get("peer_uncited") or 0))
    check("subagents section present", isinstance(sa, dict) and "modes" in sa)
    check("summary_quality present", isinstance(sq, dict) and "per_round" in sq)
    check("invalid_cites empty", not ci.get("invalid_targets"))

    failed = 0
    for name, cond, detail in checks:
        status = "PASS" if cond else "FAIL"
        if not cond:
            failed += 1
        print(f"  [{status}] {name}" + (f"  ({detail})" if detail else ""))
    print(f"\nverify: {len(checks) - failed}/{len(checks)} passed" + (" — ALL GREEN" if failed == 0 else f" — {failed} FAILED"))
    return 0 if failed == 0 else 1

def main() -> None:
    ap = argparse.ArgumentParser(description="Score Loom deliberation quality (read-only).")
    ap.add_argument("db", nargs="?", default=None, help="path to meeting .db")
    ap.add_argument("--all", action="store_true",
                    help=f"score every *.db in {DEFAULT_DIR}")
    ap.add_argument("--out", default=None, help="write full JSON report")
    ap.add_argument("--md", default=None, help="write markdown report (single-DB mode)")
    ap.add_argument("--csv", default=None, help="write flat CSV summary (--all mode)")
    ap.add_argument("--verify", action="store_true",
                    help="run golden invariants on the DB; exit 0 if all pass")
    args = ap.parse_args()

    if args.all:
        dbs = sorted(DEFAULT_DIR.glob("*.db"))
        if not dbs:
            sys.exit(f"no .db files in {DEFAULT_DIR}")
        reps = []
        for db in dbs:
            try:
                with connect_ro(db) as con:
                    rep = evaluate(con, str(db))
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
    if args.verify:
        with connect_ro(Path(args.db)) as con:
            rep = evaluate(con, str(args.db))
        rc = verify(rep, args.db)
        sys.exit(rc)
    with connect_ro(Path(args.db)) as con:
        rep = evaluate(con, str(args.db))
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
