#!/usr/bin/env python3
"""Inspect a Loom meeting SQLite DB (read-only).

Usage:
    python3 loom_inspect.py [DB] [--all] [--schema] [--table NAME --limit N]
    python3 loom_inspect.py [DB] --json [--out overview.json]

Defaults to the example meeting:
    .opencode/loom/meetings/b9c90e3e-f4b3-4da2-80b6-f49b02dcb38c.db

DB reads are read-only (SQLite URI mode=ro) so scripts never mutate meetings.
Schema reference: <workspace>/opencode-agent-plugin/src/database/schema.js
(LATEST_SCHEMA_VERSION, initSchema + MIGRATIONS).
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DB = None  # pass a meeting .db explicitly — no hardcoded default exists here
DEFAULT_DIR = HERE / ".opencode" / "loom" / "meetings"

CORE_TABLES = [
    "meetings", "participants", "rounds", "contributions", "turn_requests",
    "tool_audit", "artifacts", "orchestrator_messages", "state_patches",
    "meeting_metrics", "agent_errors", "error_log", "forum_topics",
    "forum_comments", "persona_embeddings", "meta",
]

# Time-bearing tables and their timestamp columns, for the timeline section.
TIME_COLS = {
    "meetings": ("created_at", "updated_at"),
    "participants": (),
    "rounds": ("created_at",),
    "contributions": ("created_at",),
    "turn_requests": ("created_at",),
    "tool_audit": ("created_at",),
    "artifacts": ("created_at",),
    "orchestrator_messages": ("created_at",),
    "state_patches": ("created_at",),
    "meeting_metrics": ("created_at",),
    "agent_errors": ("created_at",),
    "error_log": ("created_at",),
    "forum_topics": ("created_at", "updated_at"),
    "forum_comments": ("created_at",),
    "persona_embeddings": ("created_at",),
}

# Schema version from opencode-agent-plugin/src/database/schema.js (SCHEMA_VERSION).
# Pre-userbase there is a single version and no migrations: a DB at any other
# version is stale (delete it and let it be recreated) or newer than this script.
LATEST_KNOWN_SCHEMA = 17


def connect_ro(path: Path) -> sqlite3.Connection:
    if not path.exists():
        sys.exit(f"DB not found: {path}")
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def list_tables(con: sqlite3.Connection) -> list[str]:
    return [r["name"] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]


def table_count(con: sqlite3.Connection, table: str) -> int | str:
    try:
        return con.execute(f'SELECT COUNT(*) AS c FROM "{table}"').fetchone()["c"]
    except sqlite3.Error as e:
        if "vec0" in str(e):
            return "n/a (removed sqlite-vec extension; table orphaned)"
        return f"ERR {e}"


def table_bytes(con: sqlite3.Connection, table: str) -> int | None:
    """Bytes attributed to a table via dbstat; None when unavailable."""
    try:
        row = con.execute(
            "SELECT SUM(pgsize) AS s FROM dbstat WHERE name=?", (table,)).fetchone()
        return row["s"] if row and row["s"] is not None else None
    except sqlite3.Error:
        return None


def table_columns(con: sqlite3.Connection, table: str) -> list[str]:
    try:
        return [c["name"] for c in con.execute(f'PRAGMA table_info("{table}")')]
    except sqlite3.Error:
        return []


def show_overview(con: sqlite3.Connection) -> None:
    tables = list_tables(con)
    print(f"tables ({len(tables)}): {', '.join(tables)}")
    try:
        ver = con.execute("PRAGMA user_version").fetchone()[0]
        print(f"PRAGMA user_version: {ver} (latest known: {LATEST_KNOWN_SCHEMA})")
        if ver is not None and ver != LATEST_KNOWN_SCHEMA:
            print(f"  note: schema v{ver} {'pre' if ver < LATEST_KNOWN_SCHEMA else 'post'}-dates "
                  f"the known v{LATEST_KNOWN_SCHEMA} — expect missing/extra tables")
    except sqlite3.Error:
        pass
    if "persona_embeddings" not in tables:
        print("  note: no persona_embeddings/vec tables — new-schema DB "
              "(vectors live in process memory, not sqlite)")
    print("\nrow counts:")
    for t in CORE_TABLES:
        if t in tables:
            print(f"  {t:22s} {table_count(con, t)}")
    extra = [t for t in tables if t not in CORE_TABLES and not t.startswith("sqlite_")]
    if extra:
        print("\nother tables:")
        for t in extra:
            print(f"  {t:22s} {table_count(con, t)}")

    if "meetings" in tables:
        print("\nmeetings:")
        for r in con.execute(
                "SELECT id, status, round, max_rounds, substr(question,1,100) AS q,"
                " created_at, updated_at FROM meetings"):
            print(f"  {r['id']} [{r['status']}] round {r['round']}/{r['max_rounds']}")
            print(f"    Q: {r['q']}")
            print(f"    created={r['created_at']} updated={r['updated_at']}")

    if "participants" in tables:
        print("\nparticipants:")
        pcols = set(table_columns(con, "participants"))
        # schema v15->v16 renamed participants.tier -> category; accept either
        tier_col = "category" if "category" in pcols else "tier" if "tier" in pcols else None
        tier_sel = f', "{tier_col}" AS tier_cat' if tier_col else ""
        for r in con.execute(
                f'SELECT id, name, status, provider_id, model_id{tier_sel} FROM participants ORDER BY id'):
            print(f"  {r['id']} name={r['name']!r} {tier_col or 'tier/category'}={r['tier_cat'] if tier_col else '?'} status={r['status']} "
                  f"model={r['provider_id']}/{r['model_id']}")

    if "contributions" in tables:
        print("\ncontributions by (round, type):")
        for r in con.execute(
                "SELECT round, type, COUNT(*) c, AVG(LENGTH(content)) avglen "
                "FROM contributions GROUP BY round, type ORDER BY round, type"):
            print(f"  round {r['round']} {r['type']:22s} n={r['c']} avg_chars={r['avglen']:.0f}")
        print("\ncontributions by participant:")
        for r in con.execute(
                "SELECT participant_id, COUNT(*) c, SUM(LENGTH(content)) chars "
                "FROM contributions GROUP BY participant_id ORDER BY c DESC"):
            print(f"  {r['participant_id']:32s} n={r['c']} chars={r['chars']}")

    if "tool_audit" in tables:
        print("\ntool_audit by tool:")
        for r in con.execute(
                "SELECT tool, status, COUNT(*) c FROM tool_audit GROUP BY tool, status ORDER BY c DESC"):
            print(f"  {r['tool']:20s} {r['status']:12s} n={r['c']}")

    if "meeting_metrics" in tables:
        print("\nmeeting_metrics:")
        for r in con.execute("SELECT * FROM meeting_metrics"):
            d = dict(r)
            for k in ("counters", "latencies"):
                try:
                    d[k] = json.dumps(json.loads(d[k]), indent=None)[:300]
                except (TypeError, ValueError):
                    d[k] = str(d[k])[:300]
            for k, v in d.items():
                print(f"  {k} = {v}")

    if "meta" in tables:
        print("\nmeta:")
        for r in con.execute("SELECT key, substr(value,1,160) v FROM meta"):
            print(f"  {r['key']} = {r['v']}")

    # ---- timeline: first/last timestamps per time-bearing table ----
    print("\ntimeline:")
    for t in CORE_TABLES:
        if t not in tables or t not in TIME_COLS or not TIME_COLS[t]:
            continue
        cols = [c for c in table_columns(con, t) if c in TIME_COLS[t]]
        if not cols:
            continue
        try:
            vals_lo = [con.execute(
                f'SELECT MIN("{c}") AS m FROM "{t}"').fetchone()["m"]
                for c in cols]
            vals_hi = [con.execute(
                f'SELECT MAX("{c}") AS m FROM "{t}"').fetchone()["m"]
                for c in cols]
            vals_lo = [v for v in vals_lo if v is not None]
            vals_hi = [v for v in vals_hi if v is not None]
            if not vals_lo:
                print(f"  {t:22s} (empty)")
            else:
                print(f"  {t:22s} {min(vals_lo)} .. {max(vals_hi)}")
        except sqlite3.Error:
            continue

    # ---- storage: which tables dominate the file ----
    print("\nstorage (top tables by bytes):")
    sizes = [(t, table_bytes(con, t)) for t in tables if not t.startswith("sqlite_")]
    sizes = [(t, s) for t, s in sizes if s]
    for t, s in sorted(sizes, key=lambda x: -x[1])[:10]:
        print(f"  {t:45s} {s / 1024:9.1f} KB")


def structural_overview(con: sqlite3.Connection, db_path: str) -> dict:
    """Machine-readable full-structure overview (for --json)."""
    tables = list_tables(con)
    try:
        ver = con.execute("PRAGMA user_version").fetchone()[0]
    except sqlite3.Error:
        ver = None
    try:
        import os
        file_bytes = os.path.getsize(db_path)
    except OSError:
        file_bytes = None
    info = {
        "db": db_path,
        "user_version": ver,
        "latest_known_schema": LATEST_KNOWN_SCHEMA,
        "file_bytes": file_bytes,
        "tables": {},
    }
    for t in tables:
        cols = table_columns(con, t)
        entry: dict = {"rows": table_count(con, t), "columns": cols,
                       "bytes": table_bytes(con, t)}
        # summarize JSON-blob columns by their top-level keys (cheap, LIMIT 20)
        for blob_col in ("counters", "stats", "state_json", "patch_json",
                         "applied_json", "tool_calls", "prompt_context",
                         "settled_items", "convergence", "tags"):
            if blob_col in cols:
                keys: set[str] = set()
                try:
                    for r in con.execute(
                            f'SELECT "{blob_col}" AS v FROM "{t}" LIMIT 20'):
                        try:
                            v = json.loads(r["v"] or "")
                        except (TypeError, ValueError):
                            continue
                        if isinstance(v, dict):
                            keys.update(map(str, v.keys()))
                        elif isinstance(v, list):
                            keys.add(f"list[{len(v)}]")
                except sqlite3.Error:
                    pass
                if keys:
                    entry.setdefault("json_keys", {})[blob_col] = sorted(keys)
        info["tables"][t] = entry
    missing = [t for t in CORE_TABLES if t not in tables]
    if missing:
        info["missing_core_tables"] = missing
    return info


def show_schema(con: sqlite3.Connection) -> None:
    for (name, sql) in con.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name"):
        print(f"=== table {name} ===")
        print(sql or "(no sql)")
        print()
        try:
            cols = con.execute(f'PRAGMA table_info("{name}")').fetchall()
            print("  cols: " + ", ".join(f"{c['name']}:{c['type']}" for c in cols))
        except sqlite3.Error:
            pass
        print()


def dump_table(con: sqlite3.Connection, table: str, limit: int) -> None:
    rows = con.execute(f'SELECT * FROM "{table}" LIMIT ?', (limit,)).fetchall()
    for r in rows:
        d = dict(r)
        # truncate long text for terminal readability
        for k, v in d.items():
            if isinstance(v, str) and len(v) > 300:
                d[k] = v[:300] + f"...<{len(v)} chars>"
        print(json.dumps(d, ensure_ascii=False, default=str))




def show_deep(con: sqlite3.Connection, db_path: str) -> None:
    """In-depth audit: prompt_context completeness, inline errors, clocks, counters."""
    tables = list_tables(con)
    mid = None
    try:
        mid = con.execute("SELECT id FROM meetings LIMIT 1").fetchone()["id"]
    except sqlite3.Error:
        pass
    if not mid:
        print("no meeting row"); return

    # ---- three clocks ----
    print("\n=== THREE CLOCKS ===")
    try:
        m = con.execute("SELECT created_at, updated_at FROM meetings WHERE id=?", (mid,)).fetchone()
        print(f"  meeting created_at : {m['created_at']}")
        print(f"  meeting updated_at : {m['updated_at']}")
    except sqlite3.Error:
        pass
    try:
        mm = con.execute("SELECT duration_ms, counters FROM meeting_metrics WHERE meeting_id=?", (mid,)).fetchone()
        if mm:
            print(f"  metrics.duration_ms: {mm['duration_ms']}  (canonical wall-clock)")
            try:
                c = json.loads(mm["counters"] or "{}")
                q = c.get("quality", {}) if isinstance(c, dict) else {}
                rb = q.get("round_budget", {}) if isinstance(q, dict) else {}
                print(f"  round_budget.final_span_ms: {rb.get('final_span_ms')}  ratio={rb.get('ratio')} below_floor={rb.get('below_floor')}")
                mmix = q.get("mechanism_mix") if isinstance(q, dict) else None
                if mmix:
                    print(f"  mechanism_mix: arg={mmix.get('argument_shaped')} dec={mmix.get('decision_shaped')} other={mmix.get('other')} decision_share={mmix.get('decision_share')}")
            except (ValueError, TypeError):
                pass
    except sqlite3.Error:
        pass
    try:
        contribs = con.execute("SELECT id, created_at FROM contributions WHERE meeting_id=? ORDER BY id", (mid,)).fetchall()
        if contribs:
            ts = [r["created_at"] for r in contribs]
            print(f"  contribution span   : {ts[0]} .. {ts[-1]}")
    except sqlite3.Error:
        pass

    # ---- prompt_context completeness ----
    print("\n=== PROMPT CONTEXT COMPLETENESS ===")
    try:
        rows = con.execute("SELECT id, type, prompt_context, state_patch_outcome" if False else "SELECT id, type, prompt_context FROM contributions WHERE meeting_id=? ORDER BY id", (mid,)).fetchall()
        cols = [c["name"] for c in con.execute("PRAGMA table_info(contributions)")]
        has_outcome_col = "state_patch_outcome" in cols  # not a real col; check prompt_context
        for r in rows:
            pc = None
            try:
                pc = json.loads(r["prompt_context"] or "")
            except (ValueError, TypeError):
                pc = None
            keys = sorted(pc.keys()) if isinstance(pc, dict) else []
            sp = pc.get("system_prompt") if isinstance(pc, dict) else None
            up = pc.get("user_prompt") if isinstance(pc, dict) else None
            outcome = (pc.get("state_patch_outcome") if isinstance(pc, dict) else None) or "?"
            print(f"  #{r['id']:>2} {r['type']:22s} ctx_keys={len(keys)} sys={len(sp or '')} user={len(up or '')} patch_outcome={outcome}")
    except sqlite3.Error as e:
        print(f"  err: {e}")

    # ---- patch outcomes distribution ----
    print("\n=== PATCH OUTCOMES ===")
    try:
        from collections import Counter
        c = Counter()
        for r in con.execute("SELECT prompt_context FROM contributions WHERE meeting_id=?", (mid,)):
            try:
                pc = json.loads(r["prompt_context"] or "")
                c[pc.get("state_patch_outcome", "?")] += 1
            except (ValueError, TypeError):
                c["?"] += 1
        for k, v in c.items():
            print(f"  {k}: {v}")
    except sqlite3.Error as e:
        print(f"  err: {e}")

    # ---- inline peer errors (scan all tool_audit payloads) ----
    print("\n=== INLINE PEER ERRORS (scan of all tool_audit payloads) ===")
    found = 0
    for r in con.execute("SELECT id, tool, participant_id, output FROM tool_audit WHERE meeting_id=?", (mid,)):
        out = r["output"]
        if not isinstance(out, str) or not out.strip():
            continue
        try:
            j = json.loads(out)
        except (ValueError, TypeError):
            continue
        def walk(o, path=""):
            nonlocal found
            if isinstance(o, dict):
                for k, v in o.items():
                    if k in ("error", "errors") and v:
                        found += 1
                        print(f"  audit #{r['id']} {r['tool']} {r['participant_id']}: {str(v)[:200]}")
                    walk(v, f"{path}.{k}")
            elif isinstance(o, list):
                for i, v in enumerate(o):
                    walk(v, f"{path}[{i}]")
        walk(j)
    if found == 0:
        print("  none — whole-run scan clean")

    # ---- sub-agent conformity (loom_query responses) ----
    print("\n=== SUB-AGENT CONFORMITY ===")
    modes = {}
    total_resp = 0
    ev_struct = 0
    ballot_tok = 0
    pos_line = 0
    for r in con.execute("SELECT output FROM tool_audit WHERE meeting_id=? AND tool='loom_query'", (mid,)):
        try:
            j = json.loads(r["output"] or "")
        except (ValueError, TypeError):
            continue
        for q in (j.get("queries") if isinstance(j, dict) else []) or []:
            if isinstance(q, dict):
                mname = q.get("mode") or "unknown"
                modes[mname] = modes.get(mname, 0) + 1
        for resp in (j.get("responses") if isinstance(j, dict) else []) or []:
            if not isinstance(resp, dict):
                continue
            total_resp += 1
            content = resp.get("content") or ""
            mode = resp.get("mode") or ""
            if mode == "evidence" and all(t in content for t in ("Finding", "Source", "Strength")):
                ev_struct += 1
            if "[Vote:" in content:
                ballot_tok += 1
            if "Position:" in content:
                pos_line += 1
    print(f"  modes: {modes}")
    print(f"  total_responses={total_resp} evidence_structure={ev_struct} ballot_token={ballot_tok} position_line={pos_line}")

    # ---- persona proposals ----
    print("\n=== PERSONA PROPOSALS ===")
    try:
        pp = Path(db_path).parent.parent / "persona-proposals" / f"{mid}.md"
        if pp.exists():
            txt = pp.read_text(encoding="utf-8", errors="replace")
            print(f"  file: {pp}")
            print(f"  anti_patterns={txt.lower().count('anti_pattern')} known_biases={txt.lower().count('known_bias')} proposals={txt.count('## ')}")
        else:
            print(f"  (no proposals file at {pp})")
    except Exception as e:
        print(f"  err: {e}")

    # ---- report ↔ artifact parity ----
    print("\n=== REPORT ↔ ARTIFACT PARITY ===")
    try:
        report_path = Path(db_path).with_suffix(".md")
        if report_path.exists():
            report_txt = report_path.read_text(encoding="utf-8", errors="replace")
            art = con.execute("SELECT content FROM artifacts WHERE meeting_id=?", (mid,)).fetchone()
            art_content = (art["content"] if art else "").strip()
            marker = "\n---\n"
            idx = report_txt.find(marker)
            if idx >= 0 and art_content:
                tail = report_txt[idx + len(marker):].strip()
                print(f"  report_len={len(report_txt)} artifact_len={len(art_content)} tails_match={tail == art_content}")
            else:
                print(f"  report_len={len(report_txt)} artifact_len={len(art_content)} (no marker or empty artifact)")
        else:
            print(f"  (no report file at {report_path})")
    except Exception as e:
        print(f"  err: {e}")

    # ---- counters.quality ----
    print("\n=== COUNTERS.QUALITY ===")
    try:
        mm = con.execute("SELECT counters FROM meeting_metrics WHERE meeting_id=?", (mid,)).fetchone()
        c = json.loads(mm["counters"] or "{}")
        q = c.get("quality", {}) if isinstance(c, dict) else {}
        print(json.dumps(q, indent=2, ensure_ascii=False)[:3000])
    except Exception as e:
        print(f"  err: {e}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("db", nargs="?", default=None,
                    help="path to meeting .db file")
    ap.add_argument("--all", action="store_true",
                    help=f"overview every *.db in {DEFAULT_DIR}")
    ap.add_argument("--schema", action="store_true", help="print full DDL + columns")
    ap.add_argument("--table", help="dump rows from one table")
    ap.add_argument("--limit", type=int, default=5, help="rows for --table (default 5)")
    ap.add_argument("--json", action="store_true",
                    help="machine-readable structural overview (tables, counts, "
                    "columns, bytes, JSON-blob keys) instead of text")
    ap.add_argument("--deep", action="store_true",
                    help="in-depth audit: prompt_context, inline errors, clocks, counters, parity")
    ap.add_argument("--out", default=None, help="write output (with --json) to file")
    args = ap.parse_args()

    if args.all:
        dbs = sorted(DEFAULT_DIR.glob("*.db"))
        if not dbs:
            sys.exit(f"no .db files in {DEFAULT_DIR}")
        if args.json:
            reps = []
            for db in dbs:
                try:
                    with connect_ro(db) as con:
                        reps.append(structural_overview(con, str(db)))
                except sqlite3.Error as e:
                    reps.append({"db": str(db), "error": str(e)})
            text = json.dumps(reps, indent=2, ensure_ascii=False, default=str)
            if args.out:
                Path(args.out).write_text(text, encoding="utf-8")
                print(f"wrote {args.out} ({len(reps)} DBs)")
            else:
                print(text)
            return
        for db in dbs:
            print(f"{'=' * 70}\n== {db.name} ==\n{'=' * 70}")
            try:
                with connect_ro(db) as con:
                    show_overview(con)
            except sqlite3.Error as e:
                print(f"  ERROR: {e}")
            print()
        return

    if not args.db:
        sys.exit("usage: script <meeting.db> [options] — no default DB exists; pass a meeting .db path")
    with connect_ro(Path(args.db)) as con:
        if args.json:
            text = json.dumps(structural_overview(con, str(args.db)),
                              indent=2, ensure_ascii=False, default=str)
            if args.out:
                Path(args.out).write_text(text, encoding="utf-8")
                print(f"wrote {args.out}")
            else:
                print(text)
        elif args.schema:
            show_schema(con)
        elif args.table:
            dump_table(con, args.table, args.limit)
        elif args.deep:
            show_deep(con, str(args.db))
        else:
            show_overview(con)


if __name__ == "__main__":
    main()
