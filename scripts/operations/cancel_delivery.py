#!/usr/bin/env python3
"""Close one obsolete PR through its admitted Council publisher; restart observes only."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import uuid
from datetime import datetime, timezone
import github_feedback
from integrate_delivery import native, private_json


def current(args):
    view = native(args, {"command": "n5-inspect"})
    p = view["delivery"]["publication"]
    if p["operation"] != "cancel-pr" or p["issueId"] != os.environ["PAPERCLIP_TASK_ID"] or p["runId"] != os.environ["PAPERCLIP_RUN_ID"]:
        raise ValueError("Exact admitted cancellation publisher required")
    return view


def report(args, view):
    p = view["delivery"]["publication"]
    repository = view["delivery"]["authority"]["repository"]
    match = re.fullmatch(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)", p["targetUrl"])
    if not match or match[1] != repository:
        raise ValueError("Original canonical PR required")
    pr = github_feedback.read_api("repos/" + repository + "/pulls/" + match[2])
    if pr["html_url"] != p["targetUrl"] or pr["head"]["sha"] != p["submission"]["candidateCommit"]:
        raise ValueError("PR/head changed; retain original cancellation")
    return {"protocol": "publisher-cancellation-report-v1", "companyId": args.company_id, "missionId": args.mission_id,
        "intentId": p["intentId"], "issueId": p["issueId"], "runId": p["runId"], "repository": repository,
        "url": p["targetUrl"], "candidateCommit": p["submission"]["candidateCommit"],
        "state": "merged" if pr.get("merged") else pr["state"], "observedAt": datetime.now(timezone.utc).isoformat()}


def close_once(args, view, directory):
    claim_file = directory / "close-claim.json"
    if claim_file.exists():
        raise ValueError("Prepared cancellation permits readback only")
    observed = report(args, view)
    if observed["state"] != "open":
        raise ValueError("Original unmerged open PR required")
    payload = {"command": "n5-claim-cancellation", "commandId": str(uuid.uuid4()), "expectedVersion": view["version"], "report": observed}
    private_json(claim_file, payload)
    response = native(args, payload)
    if response.get("effectPermission") != "execute" or response.get("outcome") != "applied":
        raise ValueError("No one-shot permission observed")
    # Repeat the read-only check immediately before the single close; never delete commits/branches.
    if report(args, view)["state"] != "open":
        raise ValueError("Original PR is no longer open")
    body_file = directory / "github-close-input.json"
    private_json(body_file, {"state": "closed"})
    number = observed["url"].rsplit("/", 1)[1]
    result = subprocess.run(["gh", "api", "--method", "PATCH", "repos/" + observed["repository"] + "/pulls/" + number, "--input", str(body_file)],
                            capture_output=True, text=True, timeout=30, check=False)
    private_json(directory / "close-attempt.json", {"exitCode": result.returncode})


def observe(args, directory):
    view = current(args)
    payload = {"command": "n5-observe-cancellation", "commandId": str(uuid.uuid4()), "expectedVersion": view["version"], "report": report(args, view)}
    private_json(directory / ("observation-" + str(uuid.uuid4()) + ".json"), payload)
    response = native(args, payload)
    return {"effectPermission": "none", "state": response["mission"]["aggregate"]["linearContinuity"]["cancellation"]["state"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["close", "observe"])
    parser.add_argument("--mission-id", required=True)
    parser.add_argument("--company-id", required=True)
    args = parser.parse_args()
    try:
        for value in [args.company_id, args.mission_id, os.environ["PAPERCLIP_TASK_ID"], os.environ["PAPERCLIP_RUN_ID"]]:
            uuid.UUID(value)
        view = current(args)
        git_dir = subprocess.run(["git", "rev-parse", "--absolute-git-dir"], capture_output=True, text=True, check=True, timeout=15).stdout.strip()
        directory = Path(git_dir) / "council-cancellation" / view["delivery"]["publication"]["intentId"]
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if args.operation == "close":
            close_once(args, view, directory)
        print(json.dumps(observe(args, directory)))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        print(json.dumps({"state": "blocked", "effectPermission": "none", "reason": "Retain original cancellation; observe only, never close again"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
