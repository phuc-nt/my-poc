"""Command line: `uv run spec-review run --dry-run`, `run`, `p2` to `p6`, `notes`, `score <file>`, `index`."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

from .export import write_xlsx
from .schema import QuestionList, validate_question_list
from .loop import RunConfig, result_summary, run
from .score import ANSWERS, score
from .spec import load_spec

ROOT = Path(__file__).resolve().parents[2]
RUNS = ROOT / "runs"
LEDGER = RUNS / "ledger.jsonl"


def spent_usd() -> float:
    """Cost of every billed run so far, from the ledger. Dry runs are not in it."""
    if not LEDGER.exists():
        return 0.0
    return sum(json.loads(line)["cost_usd"] for line in LEDGER.read_text().splitlines() if line.strip())


def cmd_run(args: argparse.Namespace) -> int:
    spec = load_spec()
    budget = float(os.environ.get("SPEC_REVIEW_BUDGET_USD", "30"))
    left = budget - spent_usd()
    if args.dry_run:
        from .fake_client import FakeClient

        client, label = FakeClient(spec.page_ids), "dry"
    else:
        if left <= 0:
            print(f"Budget used up: {spent_usd():.2f} of {budget:.2f} USD. Raise SPEC_REVIEW_BUDGET_USD only with the owner's approval.")
            return 2
        if not os.environ.get("ANTHROPIC_API_KEY"):
            print("ANTHROPIC_API_KEY is not set. Put it in poc6-spec-review-agent/.env (ignored by git).")
            return 2
        import anthropic

        client, label = anthropic.Anthropic(), args.model

    run_dir = RUNS / f"{datetime.now():%Y%m%d-%H%M%S}-part1-{label}"
    run_dir.mkdir(parents=True)
    cfg = RunConfig(model=args.model, effort=args.effort, max_steps=args.max_steps, fallbacks=args.fallbacks,
                    budget_left_usd=left)
    result = run(client, spec, cfg, log=run_dir / "steps.jsonl")

    summary = result_summary(result)
    summary.update({"part": 1, "model": args.model, "effort": args.effort, "dry_run": args.dry_run, "run_dir": run_dir.name})
    if result.question_list:
        data = result.question_list.model_dump(mode="json")
        (run_dir / "question_list.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        write_xlsx(result.question_list, run_dir / "質問表.xlsx")
        summary["score"] = score(data["questions"], json.loads(ANSWERS.read_text(encoding="utf-8")))
    (run_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    if not args.dry_run:
        with LEDGER.open("a") as f:
            f.write(json.dumps({"run": run_dir.name, "cost_usd": result.cost_usd}) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if result.outcome == "done" else 1


def cmd_p2(args: argparse.Namespace) -> int:
    import asyncio

    from .sdk_agent import P2Config, context_stats, policy_approver, run_p2, subagent_question_list, terminal_approver

    spec = load_spec()
    budget = float(os.environ.get("SPEC_REVIEW_BUDGET_USD", "30"))
    left = budget - spent_usd()
    if left <= 0:
        print(f"Budget used up: {spent_usd():.2f} of {budget:.2f} USD.")
        return 2
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        print("ANTHROPIC_API_KEY is not set. Put it in poc6-spec-review-agent/.env (ignored by git).")
        return 2
    approver = {"ask": terminal_approver(args.approval_timeout), "accept": policy_approver(True),
                "reject": policy_approver(False)}[args.approval]
    part = getattr(args, "part", 2)
    notes = None
    if part == 3:
        from .notes import load_notes

        notes = load_notes(spec)
        if notes is None:
            print("The notes are missing or older than the spec. Build them first: uv run spec-review notes")
            return 2
    cfg = P2Config(model=args.model, subagent_model=args.subagent_model or args.model, effort=args.effort,
                   max_turns=args.max_turns, max_budget_usd=min(args.max_budget, left), notes=notes)
    resume, prev_session_cost = None, 0.0
    if args.resume:
        prev = json.loads((RUNS / args.resume / "summary.json").read_text(encoding="utf-8"))
        resume = prev["session_id"]
        # on a resume the CLI reports the cost of the whole session history, so subtract what was already counted
        prev_session_cost = prev.get("session_cost_usd", prev["cost_usd"])
        tag = "fork" if args.fork else "resume"
        out_dir = RUNS / f"{datetime.now():%Y%m%d-%H%M%S}-part{part}-{tag}"
    else:
        out_dir = RUNS / f"{datetime.now():%Y%m%d-%H%M%S}-part{part}-{args.model}"
    out_dir.mkdir(parents=True, exist_ok=True)
    env = {"ANTHROPIC_API_KEY": key}
    prompt = args.prompt or None
    kwargs = {"prompt": prompt} if prompt else {}
    session_cwd = RUNS / args.resume if args.resume else out_dir  # the CLI finds a session by its first cwd
    prior = RUNS / args.resume / "state.json" if args.resume else None
    if prior is not None and not prior.exists():
        prior = None  # runs before state.json existed: the gate starts empty
    res = asyncio.run(run_p2(spec, cfg, out_dir, approver, env, resume=resume, fork=args.fork, cwd=session_cwd,
                             prior_state=prior, **kwargs))
    r = res.result
    st = res.state
    summary = {
        "part": part, "outcome": res.outcome, "model": cfg.model, "subagent_model": cfg.subagent_model,
        "effort": cfg.effort, "approval": args.approval, "run_dir": out_dir.name, "session_id": res.session_id,
        "resumed_from": args.resume, "fork": args.fork, "init": res.init, "seconds": round(res.seconds, 1),
        "session_cost_usd": r.total_cost_usd if r else None,
        "cost_usd": (r.total_cost_usd - prev_session_cost) if r and r.total_cost_usd is not None else None,
        "own_cost_usd": (res.own_cost_usd - prev_session_cost) if res.own_cost_usd is not None else None,
        "num_turns": r.num_turns if r else None, "result_subtype": r.subtype if r else None,
        "stop_reason": r.stop_reason if r else None, "terminal_reason": getattr(r, "terminal_reason", None),
        "usage": r.usage if r else None, "model_usage": r.model_usage if r else None,
        "permission_denials": r.permission_denials if r else None, "errors": getattr(r, "errors", None),
        "result_text": (r.result or "")[:500] if r else None,
        "submits": st.submits, "submit_blocked": st.pre_denials, "denials": st.denials, "approvals": st.approvals,
        "id_changes": st.id_changes, "reads": len(st.reads),
        "screens_read_by_subagents": sorted(st.screens_read_by_subagents()),
        "screens_answered": sorted(st.screens_answered()),
        "lookups": st.lookups,
        "context": context_stats(out_dir / "transcript.jsonl"),
        "subagent_answers": [{k: a[k] for k in ("screen", "source", "parsed", "unknown_ids", "normalised")} | {"n": len(a["findings"])}
                             for a in st.subagent_answers],
    }
    answers = json.loads(ANSWERS.read_text(encoding="utf-8"))
    sub_q = subagent_question_list(st)
    if sub_q:
        (out_dir / "subagent_findings.json").write_text(json.dumps({"questions": sub_q}, ensure_ascii=False, indent=2),
                                                         encoding="utf-8")
        s = score(sub_q, answers)
        summary["subagent_score"] = {k: s[k] for k in ("questions", "found", "recall", "missed")}
    if st.accepted:
        data = st.accepted.model_dump(mode="json")
        (out_dir / "question_list.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        write_xlsx(st.accepted, out_dir / "質問表.xlsx")
        summary["score"] = score(data["questions"], answers)
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    cost = summary["cost_usd"] if summary["cost_usd"] is not None else (res.own_cost_usd or 0.0)
    with LEDGER.open("a") as f:
        f.write(json.dumps({"run": out_dir.name, "cost_usd": cost}) + "\n")
    print(json.dumps({k: summary[k] for k in ("outcome", "cost_usd", "own_cost_usd", "seconds", "num_turns", "submits",
                                               "denials", "submit_blocked", "screens_answered", "context")}
                     | {"page_reads_by_coordinator": sum(1 for x in st.reads if x.get("agent_type") is None),
                        "lookups": len(st.lookups)}
                     | {"score": {k: summary.get("score", {}).get(k) for k in ("questions", "found", "found_with_kind",
                                                                              "severity_agree", "missed")},
                        "subagent_score": summary.get("subagent_score")}, ensure_ascii=False, indent=2, default=str))
    return 0 if res.outcome == "done" else 1


def cmd_notes(args: argparse.Namespace) -> int:
    from .notes import NOTES_MODEL, build_notes, load_notes

    spec = load_spec()
    if not args.force and load_notes(spec) is not None:
        print("The notes are up to date with the spec (same hash). Use --force to build them again.")
        return 0
    budget = float(os.environ.get("SPEC_REVIEW_BUDGET_USD", "30"))
    if budget - spent_usd() <= 0 or not os.environ.get("ANTHROPIC_API_KEY"):
        print("No budget left, or ANTHROPIC_API_KEY is not set.")
        return 2
    import anthropic

    notes, cost = build_notes(anthropic.Anthropic(), spec, model=args.model or NOTES_MODEL, effort=args.effort)
    with LEDGER.open("a") as f:
        f.write(json.dumps({"run": f"{datetime.now():%Y%m%d-%H%M%S}-notes-{notes.manifest['model']}",
                            "cost_usd": round(cost, 5)}) + "\n")
    m = notes.manifest
    print(json.dumps({"cost_usd": m["cost_usd"], "spec_chars": m["spec_chars"],
                      "notes_chars": sum(v["chars"] for v in m["notes"].values()),
                      "lost_first": {k: v["lost_first"] for k, v in m["notes"].items() if v["lost_first"]},
                      "lost_after_retry": {k: v["lost_after_retry"] for k, v in m["notes"].items() if v["lost_after_retry"]}},
                     ensure_ascii=False, indent=2))
    return 0


def cmd_p4(args: argparse.Namespace) -> int:
    from dataclasses import asdict

    from .extract import P4Config, merged_questions, run_test_set, summarise

    spec = load_spec()
    budget = float(os.environ.get("SPEC_REVIEW_BUDGET_USD", "30"))
    left = min(budget - spent_usd(), args.max_budget)
    if left <= 0 or not os.environ.get("ANTHROPIC_API_KEY"):
        print("No budget left, or ANTHROPIC_API_KEY is not set.")
        return 2
    import anthropic

    cfg = P4Config(mode=args.mode, effort=args.effort, few_shot=args.few_shot, batch=args.batch,
                   max_attempts=args.max_attempts, concurrency=args.concurrency, budget_left_usd=left,
                   screens=args.screens.split(",") if args.screens else None)
    label = args.mode + ("-fewshot" if args.few_shot else "") + ("-batch" if args.batch else "")
    run_dir = RUNS / f"{datetime.now():%Y%m%d-%H%M%S}-part4-{label}"
    run_dir.mkdir(parents=True)
    results, seconds = run_test_set(anthropic.Anthropic(max_retries=4), spec, cfg, log_path=run_dir / "cases.jsonl")
    answers = json.loads(ANSWERS.read_text(encoding="utf-8"))
    summary = summarise(results, seconds, answers, cfg) | {"run_dir": run_dir.name}
    (run_dir / "question_list.json").write_text(json.dumps({"questions": merged_questions(results)}, ensure_ascii=False,
                                                           indent=2), encoding="utf-8")
    (run_dir / "cases.json").write_text(json.dumps([asdict(r) for r in results], ensure_ascii=False, indent=1,
                                                   default=str), encoding="utf-8")
    write_p4_xlsx(run_dir, spec)
    (run_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    with LEDGER.open("a") as f:
        f.write(json.dumps({"run": run_dir.name, "cost_usd": summary["cost_usd"]}) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if k != "usage"}, ensure_ascii=False, indent=2))
    return 0 if summary["valid_final"] == summary["cases"] else 1


def write_p4_xlsx(run_dir: Path, spec) -> bool:
    """The merged list of a P4 run as 質問表.xlsx.

    Each question is validated on its own: every case passed the schema, but twelve cases together can pass the
    60-question limit of one list, which is a limit per answer, not per report. The `case` key is dropped.
    """
    merged = json.loads((run_dir / "question_list.json").read_text(encoding="utf-8"))["questions"]
    items = []
    for q in merged:
        one, errors = validate_question_list({"questions": [{k: v for k, v in q.items() if k != "case"}]}, spec)
        if one is None:
            print("質問表.xlsx not written:", errors[:3])
            return False
        items += one.questions
    write_xlsx(QuestionList.model_construct(questions=items), run_dir / "質問表.xlsx")
    return True


def cmd_p5(args: argparse.Namespace) -> int:
    import asyncio
    import secrets

    from .mcp_check import MCP_CONFIG, check, run_p5
    from .mcp_server import TOKEN_VAR

    spec = load_spec()
    budget = float(os.environ.get("SPEC_REVIEW_BUDGET_USD", "30"))
    key = os.environ.get("ANTHROPIC_API_KEY")
    if budget - spent_usd() <= 0 or not key:
        print("No budget left, or ANTHROPIC_API_KEY is not set.")
        return 2
    # The server's stand-in credential: from the shell if set there, else a fresh random value for this run only.
    # Either way it reaches the server only through the ${SPEC_SERVER_TOKEN} expansion in .mcp.json; it is never printed.
    token_source = "environment" if os.environ.get(TOKEN_VAR) else "generated for this run"
    env = {"ANTHROPIC_API_KEY": key, TOKEN_VAR: os.environ.get(TOKEN_VAR) or secrets.token_urlsafe(16)}
    run_dir = RUNS / f"{datetime.now():%Y%m%d-%H%M%S}-part5-{args.model.split('-')[1]}"
    run_dir.mkdir(parents=True)
    res = asyncio.run(run_p5(run_dir, env, model=args.model, max_budget_usd=min(args.max_budget, budget - spent_usd())))
    r = res.result
    cli_cost = r.total_cost_usd if r else None
    cost = res.own_cost_usd if res.own_cost_usd is not None else (cli_cost or 0.0)
    summary = {"part": 5, "model": args.model, "config": MCP_CONFIG.name, "token_source": token_source,
               "outcome": r.subtype if r else "no_result", "turns": r.num_turns if r else None,
               "calls": res.calls, "answer": res.answer, "answer_error": res.answer_error,
               **check(res, spec), "init": res.init, "cost_usd": cost, "cli_cost_usd": cli_cost,
               "seconds": res.seconds, "run_dir": run_dir.name}
    (run_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    with LEDGER.open("a") as f:
        f.write(json.dumps({"run": run_dir.name, "cost_usd": cost}) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if k != "init"}, ensure_ascii=False, indent=2, default=str))
    return 0 if summary["passed"] == summary["of"] else 1


def cmd_p6(args: argparse.Namespace) -> int:
    import secrets

    from . import headless as h
    from .mcp_server import TOKEN_VAR

    spec = load_spec()
    answers = json.loads(ANSWERS.read_text(encoding="utf-8"))
    screen = args.screen.upper()
    budget = float(os.environ.get("SPEC_REVIEW_BUDGET_USD", "30"))
    left = budget - spent_usd()
    key = os.environ.get("ANTHROPIC_API_KEY")
    if left <= 0 or not key:
        print("No budget left, or ANTHROPIC_API_KEY is not set.")
        return 2
    # A minimal environment: PATH and HOME for the CLI and uv, the API key, the server token. Nothing else leaks in.
    env = {k: os.environ[k] for k in ("PATH", "HOME", "TMPDIR", "LANG") if k in os.environ}
    env |= {"ANTHROPIC_API_KEY": key, TOKEN_VAR: os.environ.get(TOKEN_VAR) or secrets.token_urlsafe(16)}
    run_dir = RUNS / f"{datetime.now():%Y%m%d-%H%M%S}-part6-{args.model.split('-')[1]}"
    run_dir.mkdir(parents=True)
    cap = min(args.max_budget, left)

    cmd = h.build_command(f"/review-spec {screen}", args.model, cap, schema=h.review_schema(spec),
                          tools=["Read", h.T_READ])
    res = h.run_headless(cmd, env)
    (run_dir / "output.json").write_text(json.dumps(res.raw, ensure_ascii=False, indent=2), encoding="utf-8")
    review = h.check_review(res, spec, answers, screen)
    if review["questions"]:
        data = {"questions": review["questions"]}
        (run_dir / "question_list.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        write_xlsx(QuestionList.model_validate(data), run_dir / "質問表.xlsx")
    runs = {"review": {"command": [c if not c.startswith("{") else "<schema>" for c in cmd],
                       "returncode": res.returncode, "parse_error": res.parse_error, "seconds": res.seconds,
                       "cost_usd": res.cost_usd, "num_turns": (res.raw or {}).get("num_turns"),
                       "subtype": (res.raw or {}).get("subtype"),
                       "permission_denials": (res.raw or {}).get("permission_denials"),
                       **{k: v for k, v in review.items() if k != "questions"},
                       "stderr_tail": res.stderr_tail if res.returncode else ""}}

    if args.hook_probe:
        target = ROOT / h.HOOK_TARGET
        if target.exists():
            print(f"{h.HOOK_TARGET} exists already; the hook probe needs it absent. Skipped.")
        else:
            cmd2 = h.build_command(h.HOOK_PROBE, args.model, min(0.10, max(left - res.cost_usd, 0.01)), schema=None,
                                   tools=["Write"])
            res2 = h.run_headless(cmd2, env)
            hook = h.check_hook(res2, target)
            runs["hook_probe"] = {"returncode": res2.returncode, "seconds": res2.seconds, "cost_usd": res2.cost_usd,
                                  "num_turns": (res2.raw or {}).get("num_turns"), **hook}
            (run_dir / "hook_output.json").write_text(json.dumps(res2.raw, ensure_ascii=False, indent=2),
                                                     encoding="utf-8")

    cost = round(sum(r["cost_usd"] for r in runs.values()), 6)
    passed = sum(r["passed"] for r in runs.values())
    of = sum(r["of"] for r in runs.values())
    summary = {"part": 6, "model": args.model, "screen": screen, "runs": runs, "passed": passed, "of": of,
               "cost_usd": cost, "run_dir": run_dir.name}
    (run_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    with LEDGER.open("a") as f:
        f.write(json.dumps({"run": run_dir.name, "cost_usd": cost}) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=str))
    return 0 if passed == of else 1


def cmd_score(args: argparse.Namespace) -> int:
    data = json.loads(Path(args.file).read_text(encoding="utf-8"))
    print(json.dumps(score(data["questions"], json.loads(ANSWERS.read_text(encoding="utf-8"))), ensure_ascii=False, indent=2))
    return 0


def cmd_index(_: argparse.Namespace) -> int:
    spec = load_spec()
    print(json.dumps({"pages": spec.page_ids, "ids": len(spec.all_ids), "defined": len(spec.defined_ids),
                      "referenced_not_defined": sorted(spec.undefined_references()),
                      "spent_usd": round(spent_usd(), 4)}, ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    from dotenv import load_dotenv  # the SDK does not read .env itself

    load_dotenv(ROOT / ".env")
    p = argparse.ArgumentParser(prog="spec-review")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="Part 1: run the hand-written loop once")
    r.add_argument("--dry-run", action="store_true", help="scripted fake client, no network, no cost")
    r.add_argument("--model", default="claude-sonnet-5-5")
    r.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh", "max"])
    r.add_argument("--max-steps", type=int, default=25)
    r.add_argument("--fallbacks", action="store_true", help="server-side refusal fallback (beta, untested here)")
    r.set_defaults(fn=cmd_run)
    q = sub.add_parser("p2", help="Part 2: the review on the Claude Agent SDK (billed)")
    q3 = sub.add_parser("p3", help="Part 3: the P2 review working from the notes (billed)")
    for x, part in ((q, 2), (q3, 3)):
        x.add_argument("--model", default="claude-sonnet-5-5")
        x.add_argument("--subagent-model", default=None, help="default: same as --model")
        x.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh", "max"])
        x.add_argument("--max-turns", type=int, default=40)
        x.add_argument("--max-budget", type=float, default=3.0, help="USD cap for this run (max_budget_usd)")
        x.add_argument("--approval", default="ask", choices=["ask", "accept", "reject"],
                       help="critical questions: ask on the terminal, or a fixed policy")
        x.add_argument("--approval-timeout", type=float, default=600)
        x.add_argument("--resume", metavar="RUN_DIR", help="resume the session of an earlier run")
        x.add_argument("--fork", action="store_true", help="with --resume: branch into a new session")
        x.add_argument("--prompt", help="the user message (default: the review request)")
        x.set_defaults(fn=cmd_p2, part=part)
    n = sub.add_parser("notes", help="Part 3: build the page summaries and the glossary (billed, about 1 cent)")
    n.add_argument("--model", default=None, help="default: claude-haiku-5-5")
    n.add_argument("--effort", default="low", choices=["low", "medium", "high"])
    n.add_argument("--force", action="store_true", help="build again even if the spec has not changed")
    n.set_defaults(fn=cmd_notes)
    f = sub.add_parser("p4", help="Part 4: the twelve-screen test set in one structured-output mode (billed)")
    f.add_argument("--mode", default="sonnet-format",
                   choices=["haiku-forced", "haiku-forced-loose", "haiku-format", "sonnet-strict", "sonnet-format"])
    f.add_argument("--effort", default="medium", choices=["low", "medium", "high"])
    f.add_argument("--few-shot", action="store_true", help="add two worked examples and a counter-example")
    f.add_argument("--batch", action="store_true", help="first attempts through the Message Batches API")
    f.add_argument("--max-attempts", type=int, default=3)
    f.add_argument("--concurrency", type=int, default=4)
    f.add_argument("--screens", help="comma-separated subset, e.g. SC-01,SC-05")
    f.add_argument("--max-budget", type=float, default=2.0, help="USD cap for this run")
    f.set_defaults(fn=cmd_p4)
    m = sub.add_parser("p5", help="Part 5: the spec MCP server used from an Agent SDK session via .mcp.json (billed)")
    m.add_argument("--model", default="claude-haiku-5-5")
    m.add_argument("--max-budget", type=float, default=0.25, help="USD cap for this run")
    m.set_defaults(fn=cmd_p5)
    hp = sub.add_parser("p6", help="Part 6: /review-spec run headless with claude -p on the project config (billed)")
    hp.add_argument("--screen", default="SC-01")
    hp.add_argument("--model", default="claude-haiku-5-5")
    hp.add_argument("--max-budget", type=float, default=0.30, help="USD cap for the review run (--max-budget-usd)")
    hp.add_argument("--hook-probe", action="store_true", help="also ask a second run to write a secret file, to see the hook block it")
    hp.set_defaults(fn=cmd_p6)
    s = sub.add_parser("score", help="score a question_list.json against eval/answers.json")
    s.add_argument("file")
    s.set_defaults(fn=cmd_score)
    sub.add_parser("index", help="show the spec ID index").set_defaults(fn=cmd_index)
    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
