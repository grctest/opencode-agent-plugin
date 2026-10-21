#!/usr/bin/env python3
"""Export a Loom meeting SQLite DB to markdown / JSON / JSONL / CSV (read-only).

Usage:
    python3 loom_export.py [DB] --format md --out transcript.md
    python3 loom_export.py [DB] --format json --out transcript.json
    python3 loom_export.py [DB] --format jsonl --out contributions.jsonl
    python3 loom_export.py [DB] --format csv --out contributions.csv

Chunking a large DB (to stay within context limits):
    python3 loom_export.py [DB] --list
    python3 loom_export.py [DB] --round 1 --truncate 1200
    python3 loom_export.py [DB] --round 2 --participant startup_veteran_0
    python3 loom_export.py [DB] --no-tools --truncate 800 --out chunk.md

Covering the DB in its entirety, one aspect at a time:
    python3 loom_export.py [DB] --section tools --tools-full --out tools.json
    python3 loom_export.py [DB] --section patches --out patches.md
    python3 loom_export.py [DB] --section artifact,metrics,errors --out synthesis.md

Sections: meeting, participants, rounds, contributions, tools, patches,
          artifact, orchestrator, metrics, errors, forum.

Defaults to the example meeting:
    .opencode/loom/meetings/b9c90e3e-f4b3-4da2-80b6-f49b02dcb38c.db
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DB = None  # pass a meeting .db explicitly — no hardcoded default exists here


SECTIONS = ("meeting", "participants", "rounds", "contributions", "tools",
            "patches", "artifact", "orchestrator", "metrics", "errors", "forum")

# section -> top-level keys in load_meeting()'s dict (for --format json)
SECTION_KEYS = {
    "meeting": ["meeting"],
    "participants": ["participants"],
    "rounds": ["rounds"],
    "contributions": ["contributions", "turn_requests"],
    "tools": ["tool_audit"],
    "patches": ["state_patches"],
    "artifact": ["artifacts"],
    "orchestrator": ["orchestrator_messages"],
    "metrics": ["metrics"],
    "errors": ["agent_errors", "error_log"],
    "forum": ["forum_topics", "forum_comments"],
}


def connect_ro(path: Path) -> sqlite3.Connection:
    if not path.exists():
        sys.exit(f"DB not found: {path}")
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def fetch_all(con: sqlite3.Connection, sql: str, args: tuple = ()) -> list[dict]:
    try:
        return [dict(r) for r in con.execute(sql, args)]
    except sqlite3.Error:
        return []  # table missing in older schema versions -> treat as empty


def load_meeting(con: sqlite3.Connection, meeting_id: str | None,
                 rounds: list[int] | None = None,
                 participant: str | None = None,
                 truncate: int = 0,
                 include_tools: bool = True,
                 tools_full: bool = False) -> dict:
    meetings = fetch_all(con, "SELECT * FROM meetings ORDER BY created_at")
    if meeting_id:
        meetings = [m for m in meetings if m["id"] == meeting_id]
    if not meetings:
        sys.exit("no matching meeting row found")
    m = meetings[0]
    mid = m["id"]
    participants = fetch_all(
        con, "SELECT id, name, persona, agenda, tier, provider_id, model_id,"
        " status, reflection, state_json FROM participants WHERE meeting_id=? ORDER BY id", (mid,))
    q, qargs = "SELECT round, summary, created_at FROM rounds WHERE meeting_id=?", [mid]
    if rounds:
        q += f" AND round IN ({','.join('?' * len(rounds))})"
        qargs += list(rounds)
    rounds_rows = fetch_all(con, q + " ORDER BY round", tuple(qargs))
    cq, cargs = ("SELECT id, participant_id, round, type, content, target_which, batch_id,"
                 " tool_calls, created_at FROM contributions WHERE meeting_id=?"), [mid]
    if rounds:
        cq += f" AND round IN ({','.join('?' * len(rounds))})"
        cargs += list(rounds)
    if participant:
        cq += " AND participant_id=?"
        cargs.append(participant)
    contributions = fetch_all(con, cq + " ORDER BY round, id", tuple(cargs))
    if truncate > 0:
        for c in contributions:
            if c.get("content") and len(c["content"]) > truncate:
                c["content"] = c["content"][:truncate] + f"...<{len(c['content'])} chars total>"
    turn_requests = fetch_all(
        con, "SELECT * FROM turn_requests WHERE meeting_id=? ORDER BY round, id", (mid,))
    tool_audit: list[dict] = []
    if include_tools:
        # full tool outputs are ~1.5MB; capped at 400 chars unless --tools-full
        cap = "input, output" if tools_full else \
            "substr(input,1,400) AS input, substr(output,1,400) AS output"
        tq, targs = (f"SELECT participant_id, round, tool, status, title, {cap},"
                     " created_at FROM tool_audit WHERE meeting_id=?"), [mid]
        if rounds:
            tq += f" AND round IN ({','.join('?' * len(rounds))})"
            targs += list(rounds)
        tool_audit = fetch_all(con, tq + " ORDER BY round, id", tuple(targs))
    orch = fetch_all(
        con, "SELECT msg_type, role, content, round, created_at FROM orchestrator_messages"
        " WHERE meeting_id=? ORDER BY id", (mid,))
    patches = fetch_all(
        con, "SELECT participant_id, round, contribution_id, version, patch_json, applied_json"
        " FROM state_patches WHERE meeting_id=? ORDER BY round, participant_id, version", (mid,))
    artifacts = fetch_all(con, "SELECT * FROM artifacts WHERE meeting_id=?", (mid,))
    metrics = fetch_all(con, "SELECT * FROM meeting_metrics WHERE meeting_id=?", (mid,))
    errors = fetch_all(con, "SELECT * FROM agent_errors WHERE meeting_id=? ORDER BY id", (mid,))
    elog = fetch_all(con, "SELECT * FROM error_log WHERE meeting_id=? ORDER BY id", (mid,))
    topics = fetch_all(con, "SELECT * FROM forum_topics WHERE meeting_id=? ORDER BY id", (mid,))
    comments: list[dict] = []
    if topics:
        comments = fetch_all(con, "SELECT * FROM forum_comments ORDER BY id")
    return {
        "meeting": m, "participants": participants, "rounds": rounds_rows,
        "contributions": contributions, "turn_requests": turn_requests,
        "tool_audit": tool_audit, "orchestrator_messages": orch,
        "state_patches": patches, "artifacts": artifacts, "metrics": metrics,
        "agent_errors": errors, "error_log": elog,
        "forum_topics": topics, "forum_comments": comments,
    }


def _json_or_str(v):
    if v is None or not isinstance(v, str) or not v.strip():
        return v
    try:
        return json.loads(v)
    except (ValueError, TypeError):
        return v


def to_markdown(d: dict) -> str:
    m = d["meeting"]
    sections = (d.get("_params") or {}).get("sections")  # None = all
    show = lambda name: sections is None or name in sections
    out = io.StringIO()
    w = out.write
    w(f"# {m.get('question', '(no question)')}\n\n")
    w(f"- meeting: `{m['id']}`\n- status: {m.get('status')} (round {m.get('round')}/{m.get('max_rounds')})\n")
    w(f"- created: {m.get('created_at')} updated: {m.get('updated_at')}\n")
    if m.get("tags"):
        w(f"- tags: {m['tags']}\n")
    if show("participants"):
        w("\n## Participants\n\n")
        for p in d["participants"]:
            w(f"### {p['name']} (`{p['id']}`, {p['tier']}, {p['status']})\n")
            w(f"- model: {p.get('provider_id')}/{p.get('model_id')}\n")
            w(f"- agenda: {p.get('agenda', '')}\n")
            state = _json_or_str(p.get("state_json"))
            stance = state.get("stance") if isinstance(state, dict) else None
            if stance:
                w(f"- final stance: {stance}\n")
            w("\n")
    if show("rounds") or show("contributions"):
        w("## Rounds\n\n")
        contrib_by_round: dict[int, list[dict]] = {}
        for c in d["contributions"]:
            contrib_by_round.setdefault(c["round"], []).append(c)
        # when chunking (--round/--participant) without explicit --section,
        # suppress full-meeting sections to keep the chunk within context limits
        chunked = bool((d.get("_params") or {}).get("chunked")) and sections is None
        for r in d["rounds"]:
            w(f"### Round {r['round']} ({r.get('created_at', '')})\n\n")
            if show("rounds") and r.get("summary"):
                w(f"> {r['summary']}\n\n")
            if show("contributions"):
                for c in contrib_by_round.get(r["round"], []):
                    body = (c["content"] or "").strip()
                    w(f"#### [#{c['id']}] {c['participant_id']} — {c['type']}\n\n{body}\n\n")
        # contributions in rounds missing from rounds table (shouldn't happen, but be safe)
        known = {r["round"] for r in d["rounds"]}
        if show("contributions"):
            for rnd, cs in sorted(contrib_by_round.items()):
                if rnd not in known:
                    w(f"### Round {rnd} (no summary row)\n\n")
                    for c in cs:
                        w(f"#### [#{c['id']}] {c['participant_id']} — {c['type']}\n\n{(c['content'] or '').strip()}\n\n")
        if d["turn_requests"] and show("contributions"):
            w("### Turn requests\n\n")
            for t in d["turn_requests"]:
                w(f"- [#{t['id']}] {t['participant_id']} → {t.get('target_participant_id')} "
                  f"(round {t.get('round')}, pri {t.get('priority')}): {(t.get('content') or '')[:500]}\n")
            w("\n")
    else:
        chunked = False
    if chunked:
        w("> _Chunked view: artifact / orchestrator / tool / patches / metrics / errors / forum "
          "sections suppressed. Re-run without --round/--participant (or add --section) "
          "for the full meeting._\n")
        return out.getvalue()
    if show("artifact") and d["artifacts"]:
        a = d["artifacts"][0]
        w("## Artifact (synthesis)\n\n")
        # `dissent` was removed from the artifacts table with the legacy
        # challenge/dissent contribution TYPES; the section now lives inside
        # `content` as a "## Dissenting Views" heading, so it is not listed here.
        for key in ("content", "decisions", "action_items",
                    "open_questions", "confidence", "refusals"):
            if a.get(key):
                w(f"### {key}\n\n{a[key]}\n\n")
    if show("orchestrator") and d["orchestrator_messages"]:
        w("## Orchestrator messages\n\n")
        for o in d["orchestrator_messages"]:
            w(f"- (round {o.get('round')}) [{o['msg_type']}/{o['role']}] {(o['content'] or '')[:2000]}\n")
        w("\n")
    if show("tools") and d["tool_audit"]:
        w("## Tool use (audit)\n\n| participant | round | tool | status | title |\n|---|---|---|---|---|\n")
        for t in d["tool_audit"]:
            w(f"| {t['participant_id']} | {t['round']} | {t['tool']} | {t['status']} | {(t.get('title') or '')[:60]} |\n")
        w("\n")
    if show("patches") and d["state_patches"]:
        w("## State patches (stance evolution)\n\n")
        for p in d["state_patches"]:
            stance = ""
            try:
                stance = (json.loads(p.get("patch_json") or "{}").get("stance") or "")[:300]
            except (ValueError, TypeError):
                pass
            w(f"- {p['participant_id']} round {p['round']} v{p['version']} "
              f"(contrib #{p.get('contribution_id')}): {stance}\n")
        w("\n")
    if show("metrics") and d["metrics"]:
        w("## Meeting metrics\n\n")
        for mm in d["metrics"]:
            for k, v in mm.items():
                if k in ("counters", "latencies"):
                    try:
                        v = json.dumps(json.loads(v or "{}"), indent=2)
                    except (ValueError, TypeError):
                        pass
                w(f"- {k}: {v}\n")
        w("\n")
    if show("errors") and (d["agent_errors"] or d["error_log"]):
        w("## Errors\n\n")
        for e in d["agent_errors"]:
            w(f"- agent_error #{e['id']} {e['participant_id']} round {e['round']} "
              f"[{e.get('error_type')}] {(e.get('error_message') or '')[:300]}\n")
        for e in d["error_log"]:
            w(f"- error_log #{e['id']} [{e.get('severity')}/{e.get('context')}] "
              f"{(e.get('message') or '')[:300]}\n")
        w("\n")
    if show("forum") and d["forum_topics"]:
        w("## Forum\n\n")
        for t in d["forum_topics"]:
            w(f"### {t.get('title')} (topic #{t['id']} by {t.get('author_id')})\n\n{(t.get('body') or '')[:2000]}\n\n")
        for c in d["forum_comments"]:
            w(f"- comment #{c['id']} on topic {c.get('topic_id')} by {c.get('author_id')}: "
              f"{(c.get('body') or '')[:1000]}\n")
        w("\n")
    return out.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser(description="Export Loom meeting DB (read-only).")
    ap.add_argument("db", nargs="?", default=None, help="path to meeting .db")
    ap.add_argument("--meeting-id", default=None, help="select meeting id (default: first)")
    ap.add_argument("--format", choices=["md", "json", "jsonl", "csv"], default="md")
    ap.add_argument("--out", default=None, help="output file (default: stdout)")
    ap.add_argument("--round", type=int, action="append", default=None,
                    help="restrict to round N (repeatable) — chunking for large DBs")
    ap.add_argument("--participant", default=None, help="restrict to participant id")
    ap.add_argument("--truncate", type=int, default=0,
                    help="truncate contribution bodies to N chars (0 = full)")
    ap.add_argument("--list", action="store_true",
                    help="index only: id/round/type/participant/chars, no bodies")
    ap.add_argument("--no-tools", action="store_true", help="skip tool_audit section")
    ap.add_argument("--tools-full", action="store_true",
                    help="include FULL tool input/output (large: ~1.5MB here)")
    ap.add_argument("--section", action="append", default=None,
                    help="export only this aspect (repeatable or comma-separated); "
                    f"choices: {', '.join(SECTIONS)}")
    args = ap.parse_args()

    if not args.db:
        sys.exit("usage: loom_export.py <meeting.db> [--meeting-id ID] [--format md|json] — no default DB exists")

    if args.section:
        # flatten comma-separated values: --section artifact,metrics
        sections: list[str] | None = []
        for s in args.section:
            sections.extend(x.strip() for x in s.split(",") if x.strip())
        bad = [s for s in sections if s not in SECTIONS]
        if bad:
            sys.exit(f"unknown section(s): {bad} (choices: {', '.join(SECTIONS)})")
    else:
        sections = None

    with connect_ro(Path(args.db)) as con:
        data = load_meeting(con, args.meeting_id, rounds=args.round,
                            participant=args.participant, truncate=args.truncate,
                            include_tools=not args.no_tools,
                            tools_full=args.tools_full)
    data["_params"] = {"chunked": bool(args.round or args.participant),
                       "sections": sections}

    if args.list:
        lines = ["id | round | type | participant | chars | created",
                 "--- | --- | --- | --- | --- | ---"]
        for c in data["contributions"]:
            # content may be truncated already; report stored length via query is
            # cheaper, but len() here is fine for chunked views
            lines.append(f"{c['id']} | {c['round']} | {c['type']} | "
                         f"{c['participant_id']} | {len(c.get('content') or '')} | {c.get('created_at')}")
        text = "\n".join(lines)
    elif args.format == "json":
        if sections is not None:
            keep = {k for s in sections for k in SECTION_KEYS[s]} | {"meeting", "_params"}
            data = {k: v for k, v in data.items() if k in keep}
        text = json.dumps(data, indent=2, ensure_ascii=False, default=str)
    elif args.format == "jsonl":
        if sections is not None and "contributions" not in sections:
            sys.exit("--format jsonl exports contributions; add --section contributions")
        text = "\n".join(json.dumps(c, ensure_ascii=False, default=str)
                          for c in data["contributions"])
    elif args.format == "csv":
        if sections is not None and "contributions" not in sections:
            sys.exit("--format csv exports contributions; add --section contributions")
        buf = io.StringIO()
        rows = data["contributions"]
        fields = ["id", "meeting_id", "participant_id", "round", "type",
                  "content", "target_which", "batch_id", "created_at"]
        wr = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
        wr.writeheader()
        # re-add meeting_id for csv consumers (load_meeting strips it via SELECT list)
        mid = data["meeting"]["id"]
        for c in rows:
            wr.writerow({**c, "meeting_id": mid})
        text = buf.getvalue()
    else:
        text = to_markdown(data)

    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        n_c = len(data.get("contributions", []))
        n_r = len(data.get("rounds", []))
        print(f"wrote {args.format} -> {args.out} "
              f"({n_c} contributions, {n_r} rounds)")
    else:
        print(text)


if __name__ == "__main__":
    main()
